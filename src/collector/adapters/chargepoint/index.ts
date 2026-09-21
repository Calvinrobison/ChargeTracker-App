/**
 * The ChargePoint browser adapter.
 *
 * Eligibility. This adapter ships `eligibilityState: 'enabled'` and
 * `verificationState: 'verified'` as of 2026-09-21, on the basis recorded in
 * `docs/SOURCE_VERIFICATION.md` and repeated in `CAPABILITIES` below: a read
 * of ChargePoint's website terms and its driver terms (last updated
 * 2026-03-25) found no clause restricting automated reading of the public
 * station page, `driver.chargepoint.com/robots.txt` allows every path, and a
 * bounded live read on 2026-09-21 matched what the page showed by eye.
 * The restrictions that DO apply — personal, non-commercial use; no
 * circumvention of any access control — are conditions this application
 * satisfies by design: it never signs in, never bypasses a challenge (a
 * challenge pauses the source), and keeps everything on the user's machine.
 *
 * Reading. The station page is a single-page application. The status region
 * is the dialog `#slideout_station_details`; each port is a
 * `[data-qa-id="port_<outletNumber>"]` block carrying a status pill
 * `[data-qa-id="port_status_pill_<code>"]` whose visible text is the
 * provider's own display word for that code. Those `data-qa-id` attributes
 * are the page's own test hooks and the only stable selectors on it — every
 * class name is a styled-components hash that changes with each deploy.
 * `port_<N>` is the physical outlet number (the page interpolates
 * `outletNumber` from its station-info payload into it), which is a durable
 * identifier from the provider and is what makes per-port history possible.
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
import { PARSER_VERSION, REQUESTED_LOCALE, type PageReading, parsePageReading } from './parse.ts';

export const SOURCE_ID = 'chargepoint';
export const ADAPTER_VERSION = '0.2.0';
export const CAPABILITY_VERSION = 2;

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

/** Builds the canonical station page URL for a provider station id. */
export function stationUrl(stationId: string): string {
  return `https://driver.chargepoint.com/stations/${stationId}`;
}

/** The instant the terms review recorded in docs/SOURCE_VERIFICATION.md was done. */
export const TERMS_REVIEWED_AT_MS = Date.parse('2026-09-21T10:30:00Z');

export const CAPABILITIES: SourceCapabilities = {
  sourceId: SOURCE_ID,
  displayName: 'ChargePoint',
  websiteUrls: ['https://www.chargepoint.com', 'https://driver.chargepoint.com'],
  adapterVersion: ADAPTER_VERSION,
  capabilityVersion: CAPABILITY_VERSION,
  supportedRegion: 'Mesa, Arizona — 50 mile straight-line radius of 33.4152, -111.8315',
  observationGranularity: 'port',
  stateMeanings: {
    available: 'The provider shows the port as "Available".',
    occupied:
      'The provider shows the port as "In Use". That means reported in use, not that electricity was flowing; the page does not separate the two for anyone but the signed-in driver, and ChargeWatch never signs in.',
    reserved: 'The provider shows the port as reserved. Not seen on this page so far.',
    out_of_service:
      'The provider shows "Out of Service" (its codes unavailable, maintenance_required, out_of_service, fault, out_of_order) or "Closed" (outside the station\'s open hours).',
    unknown:
      'The provider shows "Unknown" (its codes unknown, unreachable) or a word this adapter does not recognise.',
  },
  // `data-qa-id="port_<outletNumber>"` on each port block is the physical
  // outlet number from the provider's own station payload.
  identityReliability: 'durable',
  accessRequirements:
    'The public station page is readable without an account. No sign-in, no API key, no cookie beyond what the page sets itself.',
  collectionMethod: 'rendered_dom',
  minIntervalMs: 15 * 60_000,
  minNavigationIntervalMs: 30_000,
  sourceFreshnessLimitMs: null,
  distinguishesCharging: false,
  providesRecordedSessions: false,
  termsUrls: [
    'https://www.chargepoint.com/terms-of-use',
    'https://na.chargepoint.com/standard-driver-terms?country_id=233&instance=NA-US&locale=en',
    'https://driver.chargepoint.com/robots.txt',
  ],
  termsReviewedAtMs: TERMS_REVIEWED_AT_MS,
  termsReviewScope:
    'Read in full on 2026-09-21: the Website Terms of Use (all 17 sections) and the Terms of Service for ChargePoint Accounts (last updated 2026-03-25, all 23 sections), looking for automated access, robots, scraping, crawling, data mining, rate limits, reverse engineering and any restriction on station status data; and robots.txt on driver.chargepoint.com, www.chargepoint.com and mc.chargepoint.com.',
  eligibilityBasis:
    'Neither document restricts automated reading of the public station page. The driver terms grant a personal, non-commercial licence and prohibit circumventing any security or access-control mechanism; ChargeWatch is a personal, local observation tool that never signs in and pauses on any challenge. driver.chargepoint.com/robots.txt is "User-agent: * / Disallow:" (everything allowed); mc.chargepoint.com has none; www.chargepoint.com disallows only its CMS internals. No documented public API exists for station status. Rate limit basis: none published, so the 30-second navigation floor and 15-minute cadence in src/domain/thresholds.ts apply.',
  eligibilityState: 'enabled',
  verificationState: 'verified',
  notes:
    'Verified against the live page on 2026-09-21: stations 11502161 (2 × L2, one Available, one In Use), 17560121 (2 × DC, both maintenance_required → "Out of Service") and 1804411 (1 × DC, fault → "Out of Service") extracted exactly what the page showed. An unknown station id renders "Failed to load station details" and is reported as a source error, not as data.',
};

/**
 * The in-page extraction script.
 *
 * Runs in the page with NO application preload and no Node bridge, and returns
 * plain data. Every selector below was taken from the real page on
 * 2026-09-21 and is a `data-qa-id` the page sets for its own tests; there is
 * nothing else stable to hold on to. A markup change that removes them
 * degrades to a `layout_changed` outcome rather than silently wrong numbers.
 */
const EXTRACT_SCRIPT = `(() => {
  const textOf = (el) => (el && typeof el.textContent === 'string' ? el.textContent.trim() : null);
  const bodyText = (document.body && document.body.innerText) || '';
  const lower = bodyText.toLowerCase();

  // The station detail dialog. Absent until the app has routed to a station.
  const dialog = document.querySelector('#slideout_station_details');
  const dialogText = dialog ? ((dialog.innerText || dialog.textContent || '')) : '';
  const dialogLower = dialogText.toLowerCase();

  // Page condition, checked before any extraction.
  let pageState = 'status_present';
  if (/verify (you are|you're) human|unusual traffic|are you a robot|captcha/.test(lower)) {
    pageState = 'challenge';
  } else if (/sign in to (see|view)|log in to continue|please sign in/.test(lower)) {
    pageState = 'login_required';
  } else if (
    /failed to load station details|something went wrong|we could not load|service unavailable|try again later/.test(dialogLower || lower)
  ) {
    pageState = 'source_error';
  }

  const portNodes = dialog
    ? Array.from(dialog.querySelectorAll('[data-qa-id]')).filter((node) =>
        /^port_\\d+$/.test(node.getAttribute('data-qa-id') || ''),
      )
    : [];

  const portRows = portNodes.map((node) => {
    const qa = node.getAttribute('data-qa-id') || '';
    const outlet = qa.replace(/^port_/, '');
    const pill = node.querySelector('[data-qa-id^="port_status_pill"]');
    const pillQa = pill ? pill.getAttribute('data-qa-id') || '' : '';
    const statusCode = pillQa.startsWith('port_status_pill_') ? pillQa.slice('port_status_pill_'.length) : null;
    // The pill's aria-label is "Station Status: <words>"; its text is the words.
    const statusText = textOf(pill);
    // The lines under the pill, in page order: an optional outlet label, the
    // range ("19.8 mi / hour"), the power ("6.6 kW") and the plug ("(J1772)").
    const lines = Array.from(node.querySelectorAll('p')).map(textOf).filter(Boolean);
    const powerText = lines.find((line) => /\\d\\s*kw\\b/i.test(line)) || null;
    const connectorText = lines.find((line) => /^\\(.*\\)$/.test(line)) || null;
    const label = lines.find((line) => line !== powerText && line !== connectorText && !/mi \\/ hour|km \\/ hour/i.test(line)) || null;
    return {
      label: label || ('Outlet ' + outlet),
      statusText,
      statusCode,
      connectorText,
      powerText,
      lastUsedText: null,
      durablePortId: /^\\d+$/.test(outlet) ? outlet : null,
    };
  });

  // The station page has no aggregate "N of M available" summary; counts come
  // from the rows. Left null so the parser never invents one.
  const summaryText = null;

  // The page shows no "updated N minutes ago" for status. Null means the
  // parser records source freshness as unknown, which is the honest value.
  const updatedText = null;

  const heading = dialog ? dialog.querySelector('h2') : null;
  const stationName = textOf(heading) || (dialog ? dialog.getAttribute('title') : null);

  // "Last Used · 2 days ago" is a station-level accordion, not a port row. It
  // goes into the evidence blocks only; it is never a count of anything.
  const lastUsed = dialog ? dialog.querySelector('[data-qa-id="last_used-accordion-heading"]') : null;
  // innerText keeps the line break between "Last Used" and "2 days ago".
  const lastUsedText = lastUsed && typeof lastUsed.innerText === 'string' ? lastUsed.innerText.trim() : textOf(lastUsed);

  const loadingPresent = !!document.querySelector('[aria-busy="true"], [role="progressbar"], [class*="spinner" i], [class*="skeleton" i]');
  if (pageState === 'status_present' && portRows.length === 0) {
    if (!dialog || loadingPresent) pageState = 'loading';
    else pageState = 'empty_status';
  }

  const statusBlocks = [];
  const networkLine = dialogText.split('\\n').map((s) => s.trim()).find((s) => /network$/i.test(s));
  if (networkLine) statusBlocks.push(networkLine);
  if (lastUsedText) statusBlocks.push(lastUsedText.replace(/\\s+/g, ' '));

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

/**
 * Readiness: the port blocks are rendered, or the page has reached one of its
 * terminal conditions. `networkidle` is never used because the map page holds
 * connections open.
 */
const READY_SCRIPT = `(() => {
  const dialog = document.querySelector('#slideout_station_details');
  if (dialog) {
    const hasPorts = Array.from(dialog.querySelectorAll('[data-qa-id]')).some((node) =>
      /^port_\\d+$/.test(node.getAttribute('data-qa-id') || ''),
    );
    if (hasPorts) return true;
    const text = ((dialog.innerText || '')).toLowerCase();
    if (/failed to load station details|something went wrong|try again later/.test(text)) return true;
  }
  const body = ((document.body && document.body.innerText) || '').toLowerCase();
  return /verify (you are|you're) human|are you a robot|captcha|sign in to (see|view)|please sign in/.test(body);
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
   * A timeout here is not an error: the extraction script then reports the
   * page's real condition (`loading`), which the parser maps to a transient
   * outcome.
   */
  async function waitForStatusContent(page: Page): Promise<void> {
    await page
      .waitForFunction(READY_SCRIPT, undefined, { timeout: readinessTimeoutMs })
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
          detail: 'ChargePoint collection is not enabled.',
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
      const outcomes: CollectionBatch['outcomes'][number][] = [];
      const warnings: string[] = [];
      let retryAfterMs: number | null = null;

      for (const binding of bindings) {
        const bindingStarted = context.nowMs();
        let navigationCount = 0;

        if (abortSignal.aborted) {
          outcomes.push({
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
          outcomes.push({
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

          const navigation = await options.runtime.navigate(
            page,
            binding.canonicalUrl,
            abortSignal,
          );
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
            outcomes.push({
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
          // `evaluate` is generic over its return type and infers `unknown` for
          // a string script, so this assertion is what gives `raw` a shape.
          // eslint reads it as redundant because the assertion is itself what
          // it infers the call's type from; removing it fails typecheck.
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
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
            outcomes.push({
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

          outcomes.push({
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
          outcomes.push({
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

export { EXTRACT_SCRIPT, READY_SCRIPT, PARSER_VERSION, REQUESTED_LOCALE };
