import type {
  EventName,
  EventPayloads,
  OperationName,
  RequestOf,
  ResponseOf,
} from '../shared/ipc.ts';

/**
 * The only global the renderer may use to reach the rest of the application.
 * Anything not on this interface does not exist in the renderer.
 */
export interface ChargeWatchApi {
  readonly contractVersion: number;
  invoke<N extends OperationName>(operation: N, payload: RequestOf<N>): Promise<ResponseOf<N>>;
  cancel(requestId: string): void;
  on<N extends EventName>(event: N, listener: (payload: EventPayloads[N]) => void): () => void;
}

declare global {
  interface Window {
    readonly chargewatch: ChargeWatchApi;
  }
}

export {};
