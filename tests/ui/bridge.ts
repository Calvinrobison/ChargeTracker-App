/**
 * The stub preload bridge for UI tests.
 *
 * The renderer's only route to the rest of the application is
 * `window.chargewatch`. Installing a stub there before any application script
 * runs lets the real bundle be tested against the real contract with no
 * Electron, no database and no network.
 *
 * Two rules keep these tests from proving less than they appear to:
 *
 *  1. An operation with no fixture is REJECTED, with the operation name in the
 *     error. A stub that answered `{}` would let a test pass because the
 *     renderer tolerated a response nobody wrote.
 *  2. Every invocation is recorded, so a test can assert what the renderer
 *     asked for — including that it did NOT ask for something.
 */

import type { Page } from '@playwright/test';

import { RESPONSES, STATION_DETAILS } from './fixtures.ts';

export interface BridgeOptions {
  /** Overrides merged over the default fixtures, by operation name. */
  readonly responses?: Readonly<Record<string, unknown>>;
  /** Operations that should fail, mapped to the error code to raise. */
  readonly failures?: Readonly<Record<string, string>>;
  /** Milliseconds to delay every response, for loading-state tests. */
  readonly latencyMs?: number;
  /** Station details by site id, merged over the defaults. */
  readonly details?: Readonly<Record<string, unknown>>;
}

declare global {
  interface Window {
    /** Set by the stub only. Absent in a real build. */
    __chargewatchCalls?: Array<{ operation: string; payload: unknown }>;
  }
}

/**
 * Installs the stub before the page's own scripts run.
 *
 * `addInitScript` serialises its argument, so everything the stub needs is
 * passed as plain data and the function body must not close over anything.
 */
export async function installBridge(page: Page, options: BridgeOptions = {}): Promise<void> {
  const payload = {
    responses: { ...RESPONSES, ...(options.responses ?? {}) },
    failures: options.failures ?? {},
    latencyMs: options.latencyMs ?? 0,
    details: { ...STATION_DETAILS, ...(options.details ?? {}) },
  };

  await page.addInitScript((config: typeof payload) => {
    const calls: Array<{ operation: string; payload: unknown }> = [];
    window.__chargewatchCalls = calls;

    const listeners = new Map<string, Set<(value: unknown) => void>>();

    const wait = (ms: number) =>
      ms > 0 ? new Promise<void>((resolve) => window.setTimeout(resolve, ms)) : Promise.resolve();

    const api = {
      contractVersion: 1,

      async invoke(operation: string, requestPayload: unknown): Promise<unknown> {
        calls.push({ operation, payload: requestPayload });
        await wait(config.latencyMs);

        const failure = (config.failures as Record<string, string>)[operation];
        if (failure) {
          const error = new Error(`fixture failure for ${operation}`) as Error & { code: string };
          error.code = failure;
          throw error;
        }

        // The two operations whose answer depends on the request. Looked up
        // by site id so a test cannot pass by being handed the wrong station.
        if (operation === 'station.getDetail' || operation === 'station.getDetailById') {
          const siteId = (requestPayload as { siteId?: string } | null)?.siteId ?? '';
          const detail = (config.details as Record<string, unknown>)[siteId];
          if (!detail) {
            throw new Error(
              `No fixture detail for site "${siteId}". Add one to tests/ui/fixtures.ts.`,
            );
          }
          return detail;
        }

        if (!Object.prototype.hasOwnProperty.call(config.responses, operation)) {
          // Loud on purpose. See rule 1 in the module comment.
          throw new Error(
            `No fixture for "${operation}". Add one to tests/ui/fixtures.ts rather than ` +
              'letting the renderer receive an empty response.',
          );
        }
        return (config.responses as Record<string, unknown>)[operation];
      },

      cancel(): void {
        // Nothing to cancel: fixtures resolve immediately.
      },

      on(event: string, listener: (value: unknown) => void): () => void {
        const set = listeners.get(event) ?? new Set();
        set.add(listener);
        listeners.set(event, set);
        return () => {
          set.delete(listener);
        };
      },
    };

    Object.defineProperty(window, 'chargewatch', { value: api, configurable: false, writable: false });

    // Lets a test push an event the way the main process would.
    Object.defineProperty(window, '__chargewatchEmit', {
      value: (event: string, value: unknown) => {
        for (const listener of listeners.get(event) ?? []) listener(value);
      },
      configurable: false,
      writable: false,
    });
  }, payload);
}

/** The operations the renderer actually invoked, in order. */
export async function invokedOperations(page: Page): Promise<string[]> {
  return page.evaluate(() => (window.__chargewatchCalls ?? []).map((call) => call.operation));
}
