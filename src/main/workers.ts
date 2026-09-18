/**
 * Worker supervision.
 *
 * The database worker and the collector worker each run as an Electron
 * utility process — a real Node process, not a renderer — so:
 *  - expensive SQL and aggregation stay off the main process event loop,
 *  - the native SQLite binding is loaded in exactly one place,
 *  - a Playwright/Chromium crash cannot take down the window.
 *
 * Messages are correlated request/response pairs with timeouts. A worker that
 * exits unexpectedly is restarted with bounded backoff, and every in-flight
 * request is rejected rather than left hanging.
 */

import { utilityProcess, type MessageChannelMain, type UtilityProcess } from 'electron';
import { randomUUID } from 'node:crypto';

export interface WorkerRequest {
  readonly id: string;
  readonly op: string;
  readonly payload: unknown;
}

export type WorkerResponse =
  | { readonly id: string; readonly ok: true; readonly value: unknown }
  | { readonly id: string; readonly ok: false; readonly error: string; readonly code?: string };

export interface WorkerNotification {
  readonly notify: string;
  readonly payload: unknown;
}

export interface SupervisedWorkerOptions {
  readonly name: string;
  /** Absolute path to the built worker entry script. */
  readonly entryPath: string;
  /** Passed as argv to the worker. */
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
  readonly onNotification: (notification: WorkerNotification) => void;
  /** Called after a restart so the caller can re-establish state. */
  readonly onRestarted?: () => void | Promise<void>;
  readonly maxRestarts?: number;
  readonly defaultTimeoutMs?: number;
}

const RESTART_BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 30_000];

export class SupervisedWorker {
  private readonly options: SupervisedWorkerOptions;
  private child: UtilityProcess | null = null;
  private readonly pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  private restarts = 0;
  private stopping = false;
  private starting: Promise<void> | null = null;

  constructor(options: SupervisedWorkerOptions) {
    this.options = options;
  }

  get isRunning(): boolean {
    return this.child !== null;
  }

  async start(): Promise<void> {
    if (this.child) return;
    if (this.starting) return this.starting;

    this.starting = new Promise<void>((resolve, reject) => {
      const child = utilityProcess.fork(this.options.entryPath, [...this.options.args], {
        serviceName: this.options.name,
        stdio: 'pipe',
        env: { ...process.env, ...(this.options.env ?? {}) },
      });

      let settled = false;

      child.on('spawn', () => {
        this.child = child;
        settled = true;
        this.options.log('info', `${this.options.name} worker started (pid ${String(child.pid)})`);
        resolve();
      });

      child.on('message', (message: unknown) => {
        this.onMessage(message);
      });

      child.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8').trimEnd();
        if (text.length > 0) this.options.log('debug', `[${this.options.name}] ${text}`);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8').trimEnd();
        if (text.length > 0) this.options.log('warn', `[${this.options.name}] ${text}`);
      });

      child.on('exit', (code) => {
        this.child = null;
        const reason = `${this.options.name} worker exited with code ${String(code)}`;
        this.options.log(this.stopping ? 'info' : 'error', reason);

        // Nothing is left hanging: every in-flight request fails now.
        for (const [, entry] of this.pending) {
          clearTimeout(entry.timer);
          entry.reject(new Error(reason));
        }
        this.pending.clear();

        if (!settled) {
          settled = true;
          reject(new Error(reason));
        }
        if (!this.stopping) void this.restart();
      });
    }).finally(() => {
      this.starting = null;
    });

    return this.starting;
  }

  private async restart(): Promise<void> {
    const max = this.options.maxRestarts ?? 10;
    if (this.restarts >= max) {
      this.options.log(
        'error',
        `${this.options.name} worker has failed ${this.restarts} times and will not be restarted again`,
      );
      return;
    }
    const delay =
      RESTART_BACKOFF_MS[Math.min(this.restarts, RESTART_BACKOFF_MS.length - 1)] ?? 30_000;
    this.restarts += 1;
    this.options.log('warn', `restarting ${this.options.name} worker in ${delay}ms`);
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, delay);
      timer.unref?.();
    });
    if (this.stopping) return;
    try {
      await this.start();
      await this.options.onRestarted?.();
    } catch (error) {
      this.options.log(
        'error',
        `${this.options.name} worker failed to restart: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private onMessage(message: unknown): void {
    if (typeof message !== 'object' || message === null) return;

    if ('notify' in message) {
      this.options.onNotification(message as WorkerNotification);
      return;
    }
    if (!('id' in message)) return;
    const response = message as WorkerResponse;
    const entry = this.pending.get(response.id);
    if (!entry) return;
    this.pending.delete(response.id);
    clearTimeout(entry.timer);
    if (response.ok) entry.resolve(response.value);
    else entry.reject(new Error(response.error));
  }

  /** Sends a request and waits for its response. */
  async request<T>(op: string, payload: unknown, timeoutMs?: number): Promise<T> {
    if (!this.child) await this.start();
    const child = this.child;
    if (!child) throw new Error(`${this.options.name} worker is unavailable`);

    const id = randomUUID();
    const limit = timeoutMs ?? this.options.defaultTimeoutMs ?? 60_000;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.options.name}.${op} timed out after ${limit}ms`));
      }, limit);
      timer.unref?.();
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      child.postMessage({ id, op, payload } satisfies WorkerRequest);
    });
  }

  /** Hands a MessagePort to the worker, for worker-to-worker traffic. */
  postPort(channel: MessageChannelMain, note: string): void {
    this.child?.postMessage({ notify: 'port', payload: note }, [channel.port1]);
  }

  /** Graceful stop with a deadline, then a forced kill of OUR child only. */
  async stop(deadlineMs = 15_000): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (!child) return;
    try {
      await this.request('shutdown', {}, deadlineMs);
    } catch {
      // A worker that will not answer is killed; it is a process we started.
    }
    if (this.child) {
      this.child.kill();
      this.child = null;
    }
  }
}
