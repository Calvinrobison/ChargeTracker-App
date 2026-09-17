/**
 * IPC routing.
 *
 * Every request is: version-checked, sender-validated, name-resolved against
 * the operation registry, payload-validated, timed out, and answered with a
 * structured error code plus understandable text. There is no path by which a
 * renderer reaches a handler that was not registered here.
 */

import { randomUUID } from 'node:crypto';

import {
  ERROR_MESSAGES,
  IPC_CONTRACT_VERSION,
  OPERATIONS,
  isOperationName,
  requestEnvelopeSchema,
  type ErrorCode,
  type OperationName,
  type RequestOf,
  type ResponseEnvelope,
  type ResponseOf,
} from '../shared/ipc.ts';
import { ValidationError } from '../shared/validate.ts';
import { isTrustedSender } from './security.ts';

export type Handler<N extends OperationName> = (
  payload: RequestOf<N>,
  context: { readonly requestId: string; readonly signal: AbortSignal },
) => Promise<ResponseOf<N>>;

export interface SenderInfo {
  readonly url: string;
  readonly windowId: number | null;
  readonly isMainFrame: boolean;
}

export interface RouterOptions {
  readonly appOrigins: readonly string[];
  readonly knownWindowIds: () => readonly number[];
  readonly log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
}

/** Errors a handler can throw to select a specific code and message. */
export class OperationError extends Error {
  readonly code: ErrorCode;
  readonly detail: string | undefined;

  constructor(code: ErrorCode, detail?: string) {
    super(ERROR_MESSAGES[code]);
    this.name = 'OperationError';
    this.code = code;
    this.detail = detail;
  }
}

export class IpcRouter {
  private readonly handlers = new Map<OperationName, Handler<OperationName>>();
  private readonly inFlight = new Map<string, AbortController>();
  private readonly options: RouterOptions;

  constructor(options: RouterOptions) {
    this.options = options;
  }

  register<N extends OperationName>(name: N, handler: Handler<N>): void {
    this.handlers.set(name, handler as Handler<OperationName>);
  }

  /** Names declared in the contract that have no handler yet. */
  missingHandlers(): OperationName[] {
    return (Object.keys(OPERATIONS) as OperationName[]).filter((name) => !this.handlers.has(name));
  }

  /** Cancels an in-flight cancellable request. */
  cancel(requestId: string): boolean {
    const controller = this.inFlight.get(requestId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  async handle(raw: unknown, sender: SenderInfo): Promise<ResponseEnvelope<unknown>> {
    const fallbackId = randomUUID();

    const trust = isTrustedSender({
      senderUrl: sender.url,
      appOrigins: this.options.appOrigins,
      knownWindowIds: this.options.knownWindowIds(),
      senderWindowId: sender.windowId,
      isMainFrame: sender.isMainFrame,
    });
    if (!trust.trusted) {
      this.options.log('warn', `rejected an IPC message: ${trust.reason ?? 'untrusted sender'}`);
      return this.fail(fallbackId, 'not_permitted', trust.reason ?? undefined);
    }

    const envelope = requestEnvelopeSchema.safeParse(raw);
    if (!envelope.ok) {
      return this.fail(
        fallbackId,
        'invalid_payload',
        envelope.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      );
    }
    const { requestId, operation, payload, contractVersion } = envelope.value;

    if (contractVersion !== IPC_CONTRACT_VERSION) {
      return this.fail(requestId, 'contract_version_mismatch', `renderer sent version ${contractVersion}`);
    }
    if (!isOperationName(operation)) {
      return this.fail(requestId, 'unknown_operation', operation);
    }

    const spec = OPERATIONS[operation];
    const handler = this.handlers.get(operation);
    if (!handler) {
      return this.fail(requestId, 'unknown_operation', `${operation} has no handler`);
    }

    let parsedPayload: unknown;
    try {
      parsedPayload = spec.request.parse(payload);
    } catch (error) {
      if (error instanceof ValidationError) {
        return this.fail(requestId, 'invalid_payload', error.message);
      }
      return this.fail(requestId, 'invalid_payload', String(error));
    }

    const controller = new AbortController();
    if (spec.cancellable) this.inFlight.set(requestId, controller);

    const timeout = setTimeout(() => controller.abort(), spec.timeoutMs);
    timeout.unref?.();

    try {
      const value = await Promise.race([
        handler(parsedPayload as RequestOf<OperationName>, { requestId, signal: controller.signal }),
        new Promise<never>((_resolve, reject) => {
          controller.signal.addEventListener(
            'abort',
            () => reject(new OperationError('timeout', `${operation} exceeded ${spec.timeoutMs}ms`)),
            { once: true },
          );
        }),
      ]);
      return { contractVersion: IPC_CONTRACT_VERSION, requestId, ok: true, value };
    } catch (error) {
      if (error instanceof OperationError) {
        this.options.log('warn', `${operation} failed: ${error.code} ${error.detail ?? ''}`);
        return this.fail(requestId, error.code, error.detail);
      }
      const detail = error instanceof Error ? error.message : String(error);
      // Stack traces stay in diagnostics; the renderer gets friendly text.
      this.options.log('error', `${operation} threw: ${detail}`);
      return this.fail(requestId, 'internal_error', detail);
    } finally {
      clearTimeout(timeout);
      this.inFlight.delete(requestId);
    }
  }

  private fail(requestId: string, code: ErrorCode, detail?: string): ResponseEnvelope<never> {
    return {
      contractVersion: IPC_CONTRACT_VERSION,
      requestId,
      ok: false,
      error: { code, message: ERROR_MESSAGES[code], ...(detail === undefined ? {} : { detail }) },
    };
  }
}
