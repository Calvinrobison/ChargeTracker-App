/**
 * The renderer's only way to reach the rest of the application.
 *
 * Everything goes through the narrow preload bridge. There is no SQL here, no
 * file access, no process object and no provider page loading. If a value is
 * not on a view model, the renderer does not have it.
 */

import type {
  EventName,
  EventPayloads,
  OperationName,
  RequestOf,
  ResponseOf,
} from '../../shared/ipc.ts';

export interface ApiError {
  readonly code: string;
  readonly message: string;
  readonly detail?: string;
}

function isApiError(value: unknown): value is ApiError & Error {
  return value instanceof Error && 'code' in value;
}

/** Normalises anything thrown by the bridge into a displayable error. */
export function toApiError(error: unknown): ApiError {
  if (isApiError(error)) {
    return {
      code: error.code,
      message: error.message,
      detail: (error as { detail?: string }).detail,
    };
  }
  return {
    code: 'internal_error',
    message: 'Something went wrong.',
    detail: error instanceof Error ? error.message : String(error),
  };
}

function bridge(): Window['chargewatch'] {
  const api = window.chargewatch;
  if (!api) {
    throw new Error(
      'The ChargeWatch bridge is missing. This window was not created by the application.',
    );
  }
  return api;
}

export async function invoke<N extends OperationName>(
  operation: N,
  payload: RequestOf<N>,
): Promise<ResponseOf<N>> {
  return bridge().invoke(operation, payload);
}

export function subscribe<N extends EventName>(
  event: N,
  listener: (payload: EventPayloads[N]) => void,
): () => void {
  return bridge().on(event, listener);
}

export function contractVersion(): number {
  return bridge().contractVersion;
}
