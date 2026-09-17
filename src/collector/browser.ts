/**
 * The bundled browser runtime.
 *
 * Constraints this module exists to honour (§11, §23):
 *  - The application launches and supervises its OWN Chromium, bundled with
 *    the installer. It never hijacks the user's Chrome or Edge profile, and it
 *    never asks the user to locate a browser executable.
 *  - Headless by default; an explicit "Open source window" action uses the
 *    same bundled browser for troubleshooting.
 *  - One browser, a small bounded page pool, unhealthy pages recycled, a
 *    per-navigation deadline, and cancellation of abandoned work.
 *  - Only child processes this application owns are shut down. Nothing is
 *    killed by process name.
 *  - No stealth plugins, fingerprint spoofing, proxy rotation, CAPTCHA
 *    services, token extraction, TLS interception or endpoint replay. A
 *    challenge pauses the source; it is never worked around.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { Browser, BrowserContext, Page } from 'playwright-core';

export interface BrowserRuntimeOptions {
  /** Absolute path to the bundled Chromium executable. */
  readonly executablePath: string;
  /** Per-user directory for isolated source profiles. */
  readonly profileDir: string;
  readonly headless: boolean;
  /** Maximum pages kept open at once. Small on purpose. */
  readonly maxPages: number;
  readonly navigationTimeoutMs: number;
  /** Identifies the application to the source, as its policy expects. */
  readonly userAgentSuffix: string;
  readonly locale: string;
  readonly timezoneId: string;
  readonly log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
}

export const DEFAULT_NAVIGATION_TIMEOUT_MS = 45_000;
export const DEFAULT_MAX_PAGES = 2;

/**
 * Resolves the bundled Chromium path.
 *
 * In production the browser is packaged as a resource OUTSIDE app.asar and
 * resolved from `process.resourcesPath`. In development it comes from the
 * controlled path the setup script wrote. The builder's home cache is never
 * relied upon, because it does not exist on a user's machine.
 */
export function resolveBundledChromium(options: {
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly developmentBrowserDir: string;
  readonly platform: NodeJS.Platform;
}): { path: string; found: boolean; searched: readonly string[] } {
  const executable = options.platform === 'win32' ? 'chrome.exe' : 'chrome';
  const candidates = options.isPackaged
    ? [
        join(options.resourcesPath, 'browser', 'chrome-win', executable),
        join(options.resourcesPath, 'browser', executable),
      ]
    : [
        join(options.developmentBrowserDir, 'chrome-win', executable),
        join(options.developmentBrowserDir, executable),
      ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return { path: candidate, found: true, searched: candidates };
  }
  return { path: candidates[0] as string, found: false, searched: candidates };
}

export type PageHealth = 'healthy' | 'recycle';

interface PooledPage {
  readonly page: Page;
  readonly context: BrowserContext;
  navigations: number;
  failures: number;
}

/** Maximum navigations before a page is recycled, to bound memory growth. */
const MAX_NAVIGATIONS_PER_PAGE = 40;
/** Consecutive failures before a page is considered unhealthy. */
const MAX_PAGE_FAILURES = 3;

export interface NavigationResult {
  readonly ok: boolean;
  readonly status: number | null;
  /** Populated when the response carried a Retry-After header. */
  readonly retryAfterMs: number | null;
  readonly finalUrl: string;
  readonly detail: string | null;
}

/**
 * Owns one Chromium process and a bounded page pool.
 *
 * The collector worker holds exactly one of these. A browser crash is
 * contained here: it surfaces as failed attempts, and the UI stays up because
 * the renderer is a different process entirely.
 */
export class BrowserRuntime {
  private readonly options: BrowserRuntimeOptions;
  private browser: Browser | null = null;
  private readonly pool: PooledPage[] = [];
  private closing = false;

  constructor(options: BrowserRuntimeOptions) {
    this.options = options;
  }

  get isRunning(): boolean {
    return this.browser !== null && this.browser.isConnected();
  }

  /**
   * Launches the bundled browser.
   *
   * `chromium.launch` is imported lazily so that merely loading the collector
   * module does not pull in Playwright, which keeps the health check cheap.
   */
  async start(): Promise<void> {
    if (this.browser?.isConnected()) return;
    if (!existsSync(this.options.executablePath)) {
      throw new Error(
        `The bundled browser was not found at ${this.options.executablePath}. ` +
          'Run "npm run setup:browser" in development, or reinstall ChargeWatch.',
      );
    }

    const { chromium } = await import('playwright-core');
    this.browser = await chromium.launch({
      executablePath: this.options.executablePath,
      headless: this.options.headless,
      // Deliberately minimal. No flags that disguise the browser, disable
      // security boundaries, or route traffic through a proxy.
      args: ['--disable-background-networking', '--disable-sync', '--no-first-run'],
      // Playwright manages this Chromium as OUR child process, so shutdown
      // terminates only what we started.
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    });

    this.browser.on('disconnected', () => {
      this.options.log('warn', 'the bundled browser disconnected; pages will be rebuilt on demand');
      this.browser = null;
      this.pool.length = 0;
    });

    this.options.log(
      'info',
      `bundled browser started (${this.options.headless ? 'headless' : 'headed'})`,
    );
  }

  private async createPooledPage(): Promise<PooledPage> {
    if (!this.browser?.isConnected()) await this.start();
    const browser = this.browser;
    if (!browser) throw new Error('the bundled browser could not be started');

    const context = await browser.newContext({
      // The source profile lives under the application data directory with
      // ordinary per-user filesystem protections.
      storageState: undefined,
      locale: this.options.locale,
      timezoneId: this.options.timezoneId,
      // An identifiable application request, as tile and API policies expect.
      userAgent: undefined,
      extraHTTPHeaders: { 'X-Requested-With': this.options.userAgentSuffix },
      viewport: { width: 1280, height: 900 },
      serviceWorkers: 'block',
    });
    context.setDefaultNavigationTimeout(this.options.navigationTimeoutMs);
    context.setDefaultTimeout(this.options.navigationTimeoutMs);

    const page = await context.newPage();
    return { page, context, navigations: 0, failures: 0 };
  }

  /** Acquires a healthy page, creating or recycling as needed. */
  async acquirePage(): Promise<Page> {
    if (this.closing) throw new Error('the browser runtime is shutting down');

    for (let i = this.pool.length - 1; i >= 0; i -= 1) {
      const pooled = this.pool[i] as PooledPage;
      if (
        pooled.page.isClosed() ||
        pooled.navigations >= MAX_NAVIGATIONS_PER_PAGE ||
        pooled.failures >= MAX_PAGE_FAILURES
      ) {
        this.pool.splice(i, 1);
        await this.disposePooled(pooled);
      }
    }

    const available = this.pool.find((p) => !p.page.isClosed());
    if (available) return available.page;

    if (this.pool.length >= this.options.maxPages) {
      const oldest = this.pool.shift();
      if (oldest) await this.disposePooled(oldest);
    }

    const created = await this.createPooledPage();
    this.pool.push(created);
    return created.page;
  }

  private async disposePooled(pooled: PooledPage): Promise<void> {
    try {
      if (!pooled.page.isClosed()) await pooled.page.close({ runBeforeUnload: false });
    } catch {
      /* a page that will not close is abandoned with its context */
    }
    try {
      await pooled.context.close();
    } catch {
      /* ignore */
    }
  }

  private trackOutcome(page: Page, ok: boolean): void {
    const pooled = this.pool.find((p) => p.page === page);
    if (!pooled) return;
    pooled.navigations += 1;
    pooled.failures = ok ? 0 : pooled.failures + 1;
  }

  /**
   * Navigates with a bounded deadline and cancellation.
   *
   * `networkidle` is deliberately NOT the readiness condition: a map page can
   * hold connections open indefinitely, so readiness is decided by the caller
   * waiting for actual status content.
   */
  async navigate(page: Page, url: string, abortSignal: AbortSignal): Promise<NavigationResult> {
    if (abortSignal.aborted) {
      return { ok: false, status: null, retryAfterMs: null, finalUrl: url, detail: 'aborted before navigation' };
    }

    const parsed = safeHttpUrl(url);
    if (!parsed) {
      return {
        ok: false,
        status: null,
        retryAfterMs: null,
        finalUrl: url,
        detail: 'only http and https source URLs may be navigated',
      };
    }

    const onAbort = (): void => {
      void page.evaluate('window.stop()').catch(() => undefined);
    };
    abortSignal.addEventListener('abort', onAbort, { once: true });

    try {
      const response = await page.goto(parsed.toString(), {
        waitUntil: 'domcontentloaded',
        timeout: this.options.navigationTimeoutMs,
      });
      const status = response?.status() ?? null;
      const retryAfterHeader = response?.headers()['retry-after'] ?? null;
      const ok = status === null ? false : status < 400;
      this.trackOutcome(page, ok);
      return {
        ok,
        status,
        retryAfterMs: parseRetryAfter(retryAfterHeader),
        finalUrl: page.url(),
        detail: ok ? null : `HTTP ${String(status)}`,
      };
    } catch (error) {
      this.trackOutcome(page, false);
      const detail = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        status: null,
        retryAfterMs: null,
        finalUrl: page.url(),
        detail: abortSignal.aborted ? 'navigation cancelled' : detail,
      };
    } finally {
      abortSignal.removeEventListener('abort', onAbort);
    }
  }

  /**
   * Opens a visible window on a source page for troubleshooting, using this
   * same bundled browser. The user's own browser is never involved.
   */
  async openSourceWindow(url: string): Promise<void> {
    const parsed = safeHttpUrl(url);
    if (!parsed) throw new Error('only http and https source URLs can be opened');
    const { chromium } = await import('playwright-core');
    const browser = await chromium.launch({
      executablePath: this.options.executablePath,
      headless: false,
      args: ['--no-first-run'],
    });
    const context = await browser.newContext({
      locale: this.options.locale,
      timezoneId: this.options.timezoneId,
      viewport: null,
    });
    const page = await context.newPage();
    await page.goto(parsed.toString(), { waitUntil: 'domcontentloaded' });
    // The window stays open for the user; it closes when they close it.
    browser.on('disconnected', () => {
      this.options.log('info', 'the troubleshooting source window was closed');
    });
  }

  /**
   * Graceful shutdown: close pages, close contexts, close the browser.
   * Nothing is killed by process name, so unrelated Chrome sessions are safe.
   */
  async close(): Promise<void> {
    this.closing = true;
    for (const pooled of this.pool.splice(0)) await this.disposePooled(pooled);
    const browser = this.browser;
    this.browser = null;
    if (!browser) return;
    try {
      await browser.close();
    } catch {
      /* a browser that will not close is left to its own process exit */
    }
  }
}

/** Accepts only http and https URLs; everything else is refused. */
export function safeHttpUrl(raw: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return parsed;
}

/**
 * Parses a Retry-After header in either delta-seconds or HTTP-date form.
 *
 * Anything else returns null, meaning "the provider gave no instruction" —
 * which is a different thing from "retry immediately". A malformed header must
 * never collapse into a zero wait.
 */
export function parseRetryAfter(header: string | null, nowMs: number = Date.now()): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (trimmed.length === 0) return null;

  // delta-seconds: a non-negative integer and nothing else.
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isSafeInteger(seconds) ? seconds * 1000 : null;
  }

  // HTTP-date: require a month name so a bare number or junk cannot slip into
  // Date.parse's lenient fallbacks.
  if (!/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i.test(trimmed)) return null;
  const asDate = Date.parse(trimmed);
  if (!Number.isFinite(asDate)) return null;
  return Math.max(0, asDate - nowMs);
}
