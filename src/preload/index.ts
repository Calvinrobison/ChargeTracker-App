/**
 * The preload bridge: the entire surface the renderer can reach.
 *
 * It exposes exactly three things — a typed `invoke`, a `cancel`, and an event
 * subscription. No `ipcRenderer`, no `require`, no file access, no process
 * object. Everything else the renderer needs arrives as a view model.
 *
 * Collector pages never get this preload; they run in the bundled browser with
 * no bridge at all.
 */

import { contextBridge, ipcRenderer } from 'electron';

import {
  IPC_CHANNEL_EVENT,
  IPC_CHANNEL_REQUEST,
  IPC_CONTRACT_VERSION,
  isEventName,
  type EventEnvelope,
  type EventName,
  type EventPayloads,
  type OperationName,
  type RequestOf,
  type ResponseEnvelope,
  type ResponseOf,
} from '../shared/ipc.ts';

/** Generates a request id in the shape the envelope schema requires. */
function newRequestId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export class ChargeWatchIpcError extends Error {
  readonly code: string;
  readonly detail: string | undefined;

  constructor(code: string, message: string, detail?: string) {
    super(message);
    this.name = 'ChargeWatchIpcError';
    this.code = code;
    this.detail = detail;
  }
}

const listeners = new Map<EventName, Set<(payload: unknown) => void>>();

ipcRenderer.on(IPC_CHANNEL_EVENT, (_event, raw: unknown) => {
  if (typeof raw !== 'object' || raw === null) return;
  const envelope = raw as Partial<EventEnvelope>;
  if (envelope.contractVersion !== IPC_CONTRACT_VERSION) return;
  if (!isEventName(envelope.event)) return;
  const set = listeners.get(envelope.event);
  if (!set) return;
  for (const listener of set) {
    try {
      listener(envelope.payload);
    } catch {
      // A throwing listener must not break delivery to the others.
    }
  }
});

const api = {
  contractVersion: IPC_CONTRACT_VERSION,

  /** Calls a named operation. Rejects with a ChargeWatchIpcError on failure. */
  async invoke<N extends OperationName>(
    operation: N,
    payload: RequestOf<N>,
  ): Promise<ResponseOf<N>> {
    const requestId = newRequestId();
    const response = (await ipcRenderer.invoke(IPC_CHANNEL_REQUEST, {
      contractVersion: IPC_CONTRACT_VERSION,
      requestId,
      operation,
      payload,
    })) as ResponseEnvelope<ResponseOf<N>>;

    if (!response || typeof response !== 'object') {
      throw new ChargeWatchIpcError('internal_error', 'The background service gave no answer.');
    }
    if (!response.ok || response.value === undefined) {
      throw new ChargeWatchIpcError(
        response.error?.code ?? 'internal_error',
        response.error?.message ?? 'Something went wrong.',
        response.error?.detail,
      );
    }
    return response.value;
  },

  /** Requests cancellation of a cancellable in-flight operation. */
  cancel(requestId: string): void {
    void ipcRenderer.invoke(`${IPC_CHANNEL_REQUEST}:cancel`, requestId);
  },

  /** Subscribes to an event. Returns an unsubscribe function. */
  on<N extends EventName>(event: N, listener: (payload: EventPayloads[N]) => void): () => void {
    const set = listeners.get(event) ?? new Set();
    set.add(listener as (payload: unknown) => void);
    listeners.set(event, set);
    return () => {
      set.delete(listener as (payload: unknown) => void);
    };
  },
};

export type ChargeWatchApi = typeof api;

contextBridge.exposeInMainWorld('chargewatch', api);
