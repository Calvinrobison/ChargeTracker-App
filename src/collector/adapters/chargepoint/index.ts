/**
 * The ChargePoint browser adapter.
 *
 * IMPORTANT — eligibility. This adapter ships with
 * `eligibilityState: 'needs_review'` and `verificationState: 'blocked'`. The
 * scheduler refuses to collect from any source that is not `enabled`, so this
 * adapter does nothing until a documented terms review concludes that
 * automated collection is permitted and a live verification succeeds.
 *
 * Why it ships in that state: the build environment had no network route to
 * `driver.chargepoint.com` or to ChargePoint's terms pages, so neither the
 * review nor the verification could be performed. Visible public content is
 * not affirmative automation permission. See docs/SOURCE_VERIFICATION.md.
 *
 * The adapter owns navigation, readiness and extraction only. Scheduling,
 * retries, rate limits, provenance and health belong to the collector service.
 */

import type { Page } from 'playwright-core';

import type {
  AdapterObservation,
  BindingDescriptor,
  BindingValidation,
  CollectContext,
  CollectionBatch,
  SourceAdapter,
  SourceCapabilities,
} from '../../contract.ts';
import type { BrowserRuntime } from '../../browser.ts';
import { safeHttpUrl } from '../../browser.ts';
import {
  PARSER_VERSION,
  REQUESTED_LOCALE,
  type PageReading,
  parsePageReading,
} from './parse.ts';

export const SOURCE_ID = 'chargepoint';
export const ADAPTER_VERSION = '0.1.0';
export const CAPABILITY_VERSION = 1;

/**
 * Origins this adapter may navigate to.
 *
 * An "Add location link" must not become an arbitrary URL fetcher, a
 * file:// reader or an intranet probe, so every binding URL is checked against
 * this list before any navigation.
 */
export const ALLOWED_ORIGINS: readonly string[] = [
  'https://driver.chargepoint.com',
  'https://na.chargepoint.com',
];

const STATION_URL_PATTERN = /^\/stations\/(\d{1,12})\b/;

export const CAPABILITIES: SourceCapabilities = {
  sourceId: SOURCE_ID,
  displayName: 'ChargePoint',
  websiteUrls: ['https://www.chargepoint.com', 'https://driver.chargepoint.com'],
  adapterVersion: ADAPTER_VERSION,
  capabilityVersion: CAPABILITY_VERSION,
  supportedRegion: 'Mesa, Arizona — 50 mile straight-line radius of 33.4152, -111.8315',
  observationGranularity: 'station_aggregate',
  stateMeanings: {
    available: 'The provider lists the port as available to start a session.',
    occupied:
      'The provider lists the port as in use. Unless the page says "Charging", this means reported in use, not that electricity was flowing.',
    reserved: 'The provider lists the port as reserved.',
    out_of_service:
      'The provider lists the port as out of service, offline, unavailable or coming soon.',
    unknown: 'The provider showed a status this adapter does not recognise.',
  },
  // Until a live read proves otherwise, assume no durable port identity: the
  // brief's spot check saw two repeated port rows with no stable identifiers.
  identityReliability: 'none',
  accessRequirements:
    'The public driver map was reported readable without signing in. Not established as permitted for automated collection.',
  collectionMethod: 'rendered_dom',
  minIntervalMs: 15 * 60_000,
  minNavigationIntervalMs: 30_000,
  sourceFreshnessLimitMs: null,
  distinguishesCharging: false,
  providesRecordedSessions: false,
  termsUrls: [
    'https://www.chargepoint.com/terms-of-use',
    'https://na.chargepoint.com/standard-driver-terms?country_id=233&instance=NA-US&locale=en',
  ],
  termsReviewedAtMs: null,
  termsReviewScope: null,
  eligibilityBasis: null,
  eligibilityState: 'needs_review',
  verificationState: 'blocked',
  notes:
    'Terms review and live verification could not be performed in the build environment: the network route to the source and its terms pages was unavailable. Public visibility is not automation permission.',
};

/**
 * The in-page extraction script.
 *
 * Runs in the page with NO application preload and no Node bridge, and returns
 * plain data. Selectors are semantic and attribute-based rather than absolute
 * XPath or nth-child positions, so ordinary markup changes degrade to a
 * `layout_changed` outcome rather than silently wrong numbers.
 */
const EXTRACT_SCRIPT = `(() => {
  const textOf = (el) => (el && typeof el.textContent === 'string' ? el.textContent.trim() : null);
  const firstText = (selectors) => {
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      const value = textOf(el);
      if (value) return value;
    }
    return null;
  };

  const bodyText = (document.body && document.body.innerText) || '';

  // Page condition, checked before any extraction.
  const lower = bodyText.toLowerCase();
  let pageState = 'status_present';
  if (/verify (you are|you're) human|unusual traffic|are you a robot|captcha/.test(lower)) {
    pageState = 'challenge';
  } else if (/sign in to (see|view)|log in to continue|please sign in/.test(lower)) {
    pageState = 'login_required';
  } else if (/something went wrong|we could not load|service unavailable|try again later/.test(lower)) {
    pageState = 'source_error';
  } else if (/no (stations|results) found|no charging stations/.test(lower)) {
    pageState = 'no_results';
  }

  const portNodes = Array.from(
    document.querySelectorAll('[data-port], [data-testid*="port" i], [class*="port-row" i], [class*="portStatus" i]')
  );

  const portRows = portNodes.map((node) => {
    const attr = (name) => (node.getAttribute && node.getAttribute(name)) || null;
    const within = (selectors) => {
      for (const selector of selectors) {
        const el = node.querySelector(selector);
        const value = textOf(el);
        if (value) return value;
      }
      return null;
    };
    return {
      label: within(['[class*="label" i]', '[class*="name" i]', 'h3', 'h4']) || textOf(node.firstElementChild),
      statusText: within(['[data-status]', '[class*="status" i]', '[aria-label*="status" i]']) || attr('data-status'),
      connectorText: within(['[class*="connector" i]', '[class*="plug" i]']) || attr('data-connector'),
      powerText: within(['[class*="power" i]', '[class*="kw" i]']) || attr('data-power'),
      lastUsedText: within(['[class*="lastused" i]', '[class*="last-used" i]']),
      durablePortId: attr('data-port-id') || attr('data-outlet-id') || attr('data-port') || null,
    };
  });

  const summaryText = firstText([
    '[data-testid*="availability" i]',
    '[class*="availability" i]',
    '[class*="portsAvailable" i]',
    '[aria-label*="available" i]',
  ]);

  const updatedText = firstText([
    '[data-testid*="updated" i]',
    '[class*="updated" i]',
    '[class*="lastRefresh" i]',
    'time[datetime]',
  ]);

  const loadingPresent = !!document.querySelector('[aria-busy="true"], [class*="skeleton" i], [class*="spinner" i]');
  if (pageState === 'status_present' && portRows.length === 0 && !summaryText && loadingPresent) {
    pageState = 'loading';
  }

  const statusRegion = document.querySelector('[class*="stationDetail" i], [class*="station-detail" i], main');
  if (pageState === 'status_present' && portRows.length === 0 && !summaryText && statusRegion) {
    pageState = 'empty_status';
  }

  const stationName = firstText(['h1', '[class*="stationName" i]', '[class*="station-name" i]']);

  const statusBlocks = Array.from(
    document.querySelectorAll('[class*="accessNote" i], [class*="hours" i], [class*="network" i]')
  )
    .map(textOf)
    .filter(Boolean)
    .slice(0, 8);

  return {
    pageState,
    stationNameOnPage: stationName,
    summaryText,
    updatedText,
    portRows,
    statusBlocks,
    documentLocale: document.documentElement.getAttribute('lang'),
  };
})()`;

interface RawExtraction {
  pageState: PageReading['pageState'];
  stationNameOnPage: string | null;
  summaryText: string | null;
  updatedText: string | null;
  portRows: PageReading['portRows'];
  statusBlocks: string[];
  documentLocale: string | null;
}

/** Recovers the station id from a canonical station URL. */
export function stationIdFromUrl(url: string): string | null {
  const parsed = safeHttpUrl(url);
  if (!parsed) return null;
  const match = STATION_URL_PATTERN.exec(parsed.pathname);
  return match ? (match[1] as string) : null;
}

export function isAllowedSourceUrl(url: string): boolean {
  const parsed = safeHttpUrl(url);
  if (!parsed) return false;
  return ALLOWED_ORIGINS.includes(parsed.origin);
}

export interface ChargePointAdapterOptions {
  readonly runtime: BrowserRuntime;
  /** Readiness deadline for status content to appear, per navigation. */
  readonly readinessTimeoutMs?: number;
}

export function createChargePointAdapter(options: ChargePointAdapterOptions): SourceAdapter {
  const readinessTimeoutMs = options.readinessTimeoutMs ?? 20_000;

  /**
   * Waits for actual status content rather than for the network to go quiet.
   * A map page holds connections open, so `networkidle` would never settle.
   */
  async function waitForStatusContent(page: Page): Promise<void> {
    await page
      .waitForFunction(
        `(() => {
          const hasPorts = document.querySelectorAll('[data-port], [data-testid*="port" i], [class*="port-row" i], [class*="portStatus" i]').length > 0;
          const hasSummary = !!document.querySelector('[data-testid*="availability" i], [class*="availability" i], [class*="portsAvailable" i]');
          const text = ((document.body && document.body.innerText) || '').toLowerCase();
          const terminal = /verify (you are|you're) human|sign in to (see|view)|something went wrong|no (stations|results) found/.test(text);
          return hasPorts || hasSummary || terminal;
        })()`,
        undefined,
        { timeout: readinessTimeoutMs },
      )
      .catch(() => undefined);
  }

  return {
    describeCapabilities(): SourceCapabilities {
      return CAPABILITIES;
    },

    async validateBinding(binding: BindingDescriptor): Promise<BindingValidation> {
      if (CAPABILITIES.eligibilityState !== 'enabled') {
        return {
          ok: false,
          code: 'source_not_eligible',
          detail:
            'ChargePoint collection is not enabled: the terms review and live verification have not been completed.',
        };
      }
      const parsed = safeHttpUrl(binding.canonicalUrl);
      if (!parsed) {
        return { ok: false, code: 'url_not_http', detail: 'the binding URL is not http or https' };
      }
      if (!isAllowedSourceUrl(binding.canonicalUrl)) {
        return {
          ok: false,
          code: 'url_not_allowlisted',
          detail: `${parsed.origin} is not an allowed ChargePoint origin`,
        };
      }
      const idFromUrl = stationIdFromUrl(binding.canonicalUrl);
      if (!idFromUrl) {
        return {
          ok: false,
          code: 'station_id_missing',
          detail: 'the URL does not identify a ChargePoint station',
        };
      }
      if (binding.sourceStationId !== null && binding.sourceStationId !== idFromUrl) {
        return {
          ok: false,
          code: 'station_id_mismatch',
          detail: `binding declares ${binding.sourceStationId} but the URL points at ${idFromUrl}`,
        };
      }
      return { ok: true, code: 'ok', resolvedUrl: parsed.toString() };
    },

    async collect(
      context: CollectContext,
      bindings: readonly BindingDescriptor[],
      abortSignal: AbortSignal,
    ): Promise<CollectionBatch> {
      const startedMs = context.nowMs();
      const outcomes: CollectionBatch['outcomes'] = [];
      const warnings: string[] = [];
      let retryAfterMs: number | null = null;

      for (const binding of bindings) {
        const bindingStarted = context.nowMs();
        let navigationCount = 0;

        if (abortSignal.aborted) {
          (outcomes as CollectionBatch['outcomes'][number][]).push({
            bindingId: binding.bindingId,
            scopeKey: binding.scopeKey,
            outcome: 'cancelled',
            startedMs: bindingStarted,
            finishedMs: context.nowMs(),
            navigationCount,
            errorDetail: 'cancelled before navigation',
            observation: null,
          });
          continue;
        }

        if (!isAllowedSourceUrl(binding.canonicalUrl)) {
          (outcomes as CollectionBatch['outcomes'][number][]).push({
            bindingId: binding.bindingId,
            scopeKey: binding.scopeKey,
            outcome: 'invalid_data',
            startedMs: bindingStarted,
            finishedMs: context.nowMs(),
            navigationCount,
            errorDetail: 'binding URL is not an allowed ChargePoint origin',
            observation: null,
          });
          continue;
        }

        try {
          // Spend the shared source budget BEFORE navigating.
          await context.acquireNavigationSlot();
          const page = await options.runtime.acquirePage();
          navigationCount += 1;

          const navigation = await options.runtime.navigate(page, binding.canonicalUrl, abortSignal);
          if (navigation.retryAfterMs !== null) {
            retryAfterMs = Math.max(retryAfterMs ?? 0, navigation.retryAfterMs);
          }

          if (!navigation.ok) {
            const outcome =
              navigation.status === 429
                ? 'rate_limited'
                : navigation.status === 401 || navigation.status === 403
                  ? 'source_blocked'
                  : abortSignal.aborted
                    ? 'cancelled'
                    : navigation.detail?.includes('Timeout')
                      ? 'timeout'
                      : 'offline';
            (outcomes as CollectionBatch['outcomes'][number][]).push({
              bindingId: binding.bindingId,
              scopeKey: binding.scopeKey,
              outcome,
              startedMs: bindingStarted,
              finishedMs: context.nowMs(),
              navigationCount,
              errorDetail: navigation.detail,
              observation: null,
            });
            continue;
          }

          await waitForStatusContent(page);
          const raw = (await page.evaluate(EXTRACT_SCRIPT)) as RawExtraction;
          const readAtUtcMs = context.nowMs();

          const reading: PageReading = {
            url: navigation.finalUrl,
            pageState: raw.pageState,
            // Identity comes from the URL we actually ended on, so a redirect
            // is caught by the parser's identity check.
            stationIdOnPage: stationIdFromUrl(navigation.finalUrl),
            stationNameOnPage: raw.stationNameOnPage,
            summaryText: raw.summaryText,
            updatedText: raw.updatedText,
            portRows: raw.portRows,
            statusBlocks: raw.statusBlocks,
            readAtUtcMs,
            documentLocale: raw.documentLocale,
          };

          const parsed = parsePageReading(reading, {
            expectedStationId: binding.sourceStationId ?? stationIdFromUrl(binding.canonicalUrl),
            catalogPortCount: binding.catalogPortCount,
          });

          if (!parsed.ok) {
            (outcomes as CollectionBatch['outcomes'][number][]).push({
              bindingId: binding.bindingId,
              scopeKey: binding.scopeKey,
              outcome: parsed.outcome,
              startedMs: bindingStarted,
              finishedMs: context.nowMs(),
              navigationCount,
              errorDetail: parsed.detail,
              observation: null,
            });
            continue;
          }

          const observation: AdapterObservation = {
            bindingId: binding.bindingId,
            scopeKey: binding.scopeKey,
            sourceStationId: reading.stationIdOnPage,
            observedAtUtcMs: readAtUtcMs,
            sourceUpdatedAtUtcMs: parsed.sourceUpdatedAtUtcMs,
            granularity: binding.granularity,
            counts: parsed.counts,
            capacityBasis: parsed.capacityBasis,
            completeness: parsed.completeness,
            level: parsed.level,
            ports: parsed.ports,
            sanitizedSourceText: parsed.sanitizedSourceText,
            sourceUrl: navigation.finalUrl,
            quality: parsed.completeness === 'partial' ? 'provisional' : 'reliable',
            sourceFreshness:
              parsed.sourceUpdatedAtUtcMs === null ? 'unknown_source_clock' : 'fresh',
            warnings: parsed.warnings,
          };

          (outcomes as CollectionBatch['outcomes'][number][]).push({
            bindingId: binding.bindingId,
            scopeKey: binding.scopeKey,
            outcome: parsed.completeness === 'partial' ? 'partial' : 'succeeded',
            startedMs: bindingStarted,
            finishedMs: context.nowMs(),
            navigationCount,
            errorDetail: null,
            observation,
          });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          context.log('warn', `ChargePoint collection failed for ${binding.bindingId}: ${detail}`);
          (outcomes as CollectionBatch['outcomes'][number][]).push({
            bindingId: binding.bindingId,
            scopeKey: binding.scopeKey,
            outcome: abortSignal.aborted ? 'cancelled' : 'timeout',
            startedMs: bindingStarted,
            finishedMs: context.nowMs(),
            navigationCount,
            errorDetail: detail,
            observation: null,
          });
        }
      }

      return {
        sourceId: SOURCE_ID,
        adapterVersion: ADAPTER_VERSION,
        attemptId: context.attemptId,
        startedMs,
        finishedMs: context.nowMs(),
        outcomes,
        warnings,
        retryAfterMs,
      };
    },

    async close(): Promise<void> {
      // The runtime is owned by the collector service, which closes it; the
      // adapter holds no other resources.
    },
  };
}

export { PARSER_VERSION, REQUESTED_LOCALE };
