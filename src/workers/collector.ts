/**
 * Collector worker entry point.
 *
 * Runs as an Electron utility process and supervises an isolated Playwright
 * Chromium. It never writes SQLite: completed runs are posted back to the main
 * process, which forwards them to the database worker.
 */

import { BrowserRuntime, resolveBundledChromium } from '../collector/browser.ts';
import { CollectorService, type RunReport } from '../collector/service.ts';
import { createChargePointAdapter } from '../collector/adapters/chargepoint/index.ts';
import type { BindingDescriptor } from '../collector/contract.ts';
import type { QueueEntry } from '../collector/scheduler.ts';

interface Incoming {
  readonly id: string;
  readonly op: string;
  readonly payload: unknown;
}

interface CollectorWorkerConfig {
  readonly profileDir: string;
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly developmentBrowserDir: string;
  readonly headless: boolean;
  readonly locale: string;
  readonly timezoneId: string;
  readonly appVersion: string;
}

function send(message: unknown): void {
  process.parentPort?.postMessage(message);
}

function notify(name: string, payload: unknown): void {
  send({ notify: name, payload });
}

function log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
  notify('log', { level, message });
}

const raw = process.argv[2];
if (!raw) throw new Error('the collector worker requires its configuration as argv[2]');
const config = JSON.parse(raw) as CollectorWorkerConfig;

const resolved = resolveBundledChromium({
  isPackaged: config.isPackaged,
  resourcesPath: config.resourcesPath,
  developmentBrowserDir: config.developmentBrowserDir,
  platform: process.platform,
});

if (!resolved.found) {
  log(
    'error',
    `the bundled browser was not found. Searched: ${resolved.searched.join(' ; ')}. ` +
      'Run "npm run setup:browser" in development, or reinstall ChargeWatch.',
  );
}

const runtime = new BrowserRuntime({
  executablePath: resolved.path,
  profileDir: config.profileDir,
  headless: config.headless,
  maxPages: 2,
  navigationTimeoutMs: 45_000,
  userAgentSuffix: `ChargeWatch/${config.appVersion}`,
  locale: config.locale,
  timezoneId: config.timezoneId,
  log,
});

const service = new CollectorService({
  runtime,
  host: {
    async submitRun(report: RunReport) {
      notify('run', report);
    },
    async recordGap(gap) {
      notify('gap', gap);
    },
    async persistQueue(entries) {
      notify('queue', entries);
    },
    async persistSourceHealth(health) {
      notify('sourceHealth', health);
    },
    onStatusChange() {
      notify('status', service.status());
    },
    log,
  },
});

// Register every adapter. An adapter whose eligibility is not `enabled` is
// registered so the UI can explain its state, but the scheduler refuses to
// collect from it.
const registered = [service.registerAdapter(createChargePointAdapter({ runtime }))];

async function dispatch(op: string, payload: unknown): Promise<unknown> {
  switch (op) {
    case 'describe':
      return {
        browserFound: resolved.found,
        browserPath: resolved.path,
        searchedPaths: resolved.searched,
        sources: registered,
      };
    case 'load': {
      const input = payload as {
        queue: readonly QueueEntry[];
        bindings: readonly (BindingDescriptor & { sourceId: string; siteId: string })[];
      };
      service.load(input);
      return { loaded: input.bindings.length };
    }
    case 'start':
      await service.start();
      return service.status();
    case 'pause':
      await service.pause(
        (payload as { reason?: 'user_paused' | 'update_install' | 'offline' }).reason,
      );
      return service.status();
    case 'status':
      return service.status();
    case 'sourceHealth':
      return service.sourceHealth();
    case 'refreshNow':
      return service.requestManualRefresh(
        (payload as { bindingIds: readonly string[] }).bindingIds,
      );
    case 'setOnline':
      service.setOnline((payload as { online: boolean }).online);
      return service.status();
    case 'suspend':
      await service.onSuspend();
      return { suspended: true };
    case 'resume':
      await service.onResume();
      return service.status();
    case 'openSourceWindow':
      await runtime.openSourceWindow((payload as { url: string }).url);
      return { opened: true };
    case 'healthCheck': {
      // Does the bundled browser actually launch? This is the check the
      // onboarding screen reports, and it must not be a guess.
      if (!resolved.found) {
        return { ok: false, detail: `the bundled browser is missing at ${resolved.path}` };
      }
      try {
        await runtime.start();
        return { ok: runtime.isRunning, detail: null };
      } catch (error) {
        return { ok: false, detail: error instanceof Error ? error.message : String(error) };
      }
    }
    case 'shutdown': {
      const result = await service.stop({ deadlineMs: 20_000 });
      setTimeout(() => process.exit(0), 50).unref?.();
      return result;
    }
    default:
      throw new Error(`unknown collector worker operation: ${op}`);
  }
}

process.parentPort?.on('message', (event) => {
  const message = event.data as Incoming;
  if (!message || typeof message !== 'object' || !('id' in message)) return;

  void (async () => {
    try {
      const value = await dispatch(message.op, message.payload);
      send({ id: message.id, ok: true, value });
    } catch (error) {
      send({
        id: message.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();
});

process.on('uncaughtException', (error) => {
  console.error(`collector worker uncaught exception: ${error.message}`);
  // Try to release the browser so no orphaned Chromium is left behind.
  void runtime.close().finally(() => process.exit(1));
});
