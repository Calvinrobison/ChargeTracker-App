/**
 * Database worker entry point.
 *
 * Runs as an Electron utility process, and is the only process that writes the
 * database.
 *
 * SQLite comes from `node:sqlite`, which ships inside Node and therefore inside
 * Electron. There is no native module to rebuild for the Electron ABI and
 * nothing to unpack from the asar. See src/database/drivers/node-sqlite.ts.
 *
 * Message shape: { id, op, payload } in, { id, ok, value | error } out, plus
 * unsolicited { notify, payload } for status changes.
 */

import { DatabaseSync as DatabaseSyncAvailable } from 'node:sqlite';

import { openNodeSqlite } from '../database/drivers/node-sqlite.ts';
import { DatabaseWorker, type DatabaseWorkerConfig } from '../database/worker.ts';
import type { FilterState, WindowRequest } from '../shared/ipc.ts';
import type { RankSort } from '../domain/ranking.ts';

interface Incoming {
  readonly id: string;
  readonly op: string;
  readonly payload: unknown;
}

function readConfigFromArgv(): Omit<DatabaseWorkerConfig, 'openDriver'> {
  const raw = process.argv[2];
  if (!raw) throw new Error('the database worker requires its configuration as argv[2]');
  const parsed = JSON.parse(raw) as Omit<DatabaseWorkerConfig, 'openDriver'>;
  return parsed;
}

/**
 * Confirms SQLite is actually available before anything depends on it.
 *
 * `node:sqlite` is built into Node, but it arrived recently and spent several
 * releases behind `--experimental-sqlite`. Electron chooses its own Node
 * version, so this is checked rather than assumed — and if it is ever missing,
 * the user gets one clear sentence instead of a utility process that dies
 * during module loading with nothing useful attached to it.
 */
function assertSqliteAvailable(): void {
  if (typeof DatabaseSyncAvailable !== 'function') {
    throw new Error(
      'This build of Electron does not provide node:sqlite, so ChargeWatch cannot open its ' +
        `history file. Electron ships Node ${process.versions.node}. Your data has not been ` +
        'changed. See docs/BUILDING.md.',
    );
  }
}

const config = readConfigFromArgv();
assertSqliteAvailable();
const worker = new DatabaseWorker({
  ...config,
  // The same driver the specs run against, so what is tested is what ships.
  openDriver: (path: string) => openNodeSqlite(path),
  log: (level, message) => notify('log', { level, message }),
});

function send(message: unknown): void {
  process.parentPort?.postMessage(message);
}

function notify(name: string, payload: unknown): void {
  send({ notify: name, payload });
}

let ready = false;

async function dispatch(op: string, payload: unknown): Promise<unknown> {
  switch (op) {
    case 'open': {
      const state = await worker.open();
      ready = state.status === 'ready';
      return state;
    }
    case 'shutdown': {
      await worker.close();
      ready = false;
      // Give the response a chance to flush before the process exits.
      setTimeout(() => process.exit(0), 50).unref?.();
      return { closed: true };
    }
    default:
      break;
  }

  if (!ready) throw new Error('the database is not open');

  switch (op) {
    case 'counts':
      return worker.counts();
    case 'getSettings':
      return worker.getSettings();
    case 'updateSettings':
      return worker.updateSettings((payload as { entries: Record<string, unknown> }).entries);
    case 'overview': {
      const input = payload as { window: WindowRequest; filters: FilterState; sort: RankSort };
      return worker.getOverview(input.window, input.filters, input.sort);
    }
    case 'mapMarkers': {
      const input = payload as {
        window: WindowRequest;
        filters: FilterState;
        sort: RankSort;
        metric: 'occupancy' | 'current' | 'coverage' | 'visits';
      };
      return worker.getMapMarkers(input.window, input.filters, input.sort, input.metric);
    }
    case 'stationDetail': {
      const input = payload as { siteId: string; window: WindowRequest };
      return worker.getStationDetail(input.siteId, input.window);
    }
    case 'setSaved': {
      const input = payload as { siteId: string; saved: boolean };
      worker.setSaved(input.siteId, input.saved);
      return { saved: input.saved };
    }
    case 'ingestRun': {
      const result = worker.ingestRun(payload as Parameters<DatabaseWorker['ingestRun']>[0]);
      if (result.written > 0) notify('dataChanged', { reason: 'observations' });
      return result;
    }
    case 'recordGap':
      worker.recordGap(payload as Parameters<DatabaseWorker['recordGap']>[0]);
      return { recorded: true };
    case 'exportCurrentView':
      return worker.exportCurrentView(payload as Parameters<DatabaseWorker['exportCurrentView']>[0]);
    case 'exportRawObservations':
      return worker.exportRawObservations(
        payload as Parameters<DatabaseWorker['exportRawObservations']>[0],
      );
    case 'createBackup':
      return worker.createBackupNow((payload as { kind?: 'daily' | 'manual' | 'pre_update' }).kind);
    case 'listBackups':
      return worker.listBackups();
    case 'previewRestore':
      return worker.previewRestore((payload as { filePath: string }).filePath);
    case 'performRestore': {
      const result = await worker.performRestore((payload as { filePath: string }).filePath);
      if (result.ok) notify('dataChanged', { reason: 'restore' });
      return result;
    }
    case 'deleteObservationsBefore': {
      const deleted = worker.deleteObservationsBefore((payload as { beforeMs: number }).beforeMs);
      notify('dataChanged', { reason: 'observations' });
      return { deleted };
    }
    case 'suggestExportFileName': {
      const input = payload as { kind: string; window: { startMs: number; endMs: number } };
      return { fileName: worker.suggestExportFileName(input.kind, input.window) };
    }

    // --- collector state ---
    case 'collectionStatus':
      return worker.collectionStatus(payload as Parameters<DatabaseWorker['collectionStatus']>[0]);
    case 'studyStartMs':
      return worker.studyStartMs();
    case 'diskUsageBytes':
      return worker.diskUsageBytes();
    case 'upsertSources':
      return worker.upsertSources(
        (payload as { sources: Parameters<DatabaseWorker['upsertSources']>[0] }).sources,
      );
    case 'loadCollectorState':
      return worker.loadCollectorState();
    case 'persistQueue':
      return worker.persistQueue(
        (payload as { entries: Parameters<DatabaseWorker['persistQueue']>[0] }).entries,
      );
    case 'persistSourceHealth':
      worker.persistSourceHealth(payload as Parameters<DatabaseWorker['persistSourceHealth']>[0]);
      return { recorded: true };
    case 'setMonitored':
      return worker.setMonitored(payload as Parameters<DatabaseWorker['setMonitored']>[0]);
    case 'addManualLink':
      return worker.addManualLink(payload as Parameters<DatabaseWorker['addManualLink']>[0]);
    case 'bindingIdsForSites':
      return worker.bindingIdsForSites(
        payload as Parameters<DatabaseWorker['bindingIdsForSites']>[0],
      );
    case 'sourceUrlForSite':
      return worker.sourceUrlForSite(payload as Parameters<DatabaseWorker['sourceUrlForSite']>[0]);

    // --- visits ---
    case 'previewVisitImport':
      return worker.previewVisitImport(
        payload as Parameters<DatabaseWorker['previewVisitImport']>[0],
      );
    case 'commitVisitImport': {
      const result = worker.commitVisitImport(
        payload as Parameters<DatabaseWorker['commitVisitImport']>[0],
      );
      notify('dataChanged', { reason: 'visits' });
      return result;
    }
    case 'addManualVisit': {
      const result = worker.addManualVisit(
        payload as Parameters<DatabaseWorker['addManualVisit']>[0],
      );
      if (result.ok) notify('dataChanged', { reason: 'visits' });
      return result;
    }

    // --- update bookkeeping ---
    case 'recordUpdateEvent':
      worker.recordUpdateEvent(payload as Parameters<DatabaseWorker['recordUpdateEvent']>[0]);
      return { recorded: true };
    case 'readHighestAcceptedSequence':
      return worker.readHighestAcceptedSequence();
    case 'writeHighestAcceptedSequence':
      worker.writeHighestAcceptedSequence(
        payload as Parameters<DatabaseWorker['writeHighestAcceptedSequence']>[0],
      );
      return { written: true };

    default:
      throw new Error(`unknown database worker operation: ${op}`);
  }
}

process.parentPort?.on('message', (event) => {
  const message = event.data as Incoming | { notify: string };
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
  // Report and exit: the supervisor restarts us, and committed data is safe
  // because every write is a transaction.
  console.error(`database worker uncaught exception: ${error.message}`);
  process.exit(1);
});
