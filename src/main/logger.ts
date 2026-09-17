/**
 * Bounded local logging.
 *
 * Logs are a diagnostic aid, not a data store. They are capped, rotated
 * oldest-first, redacted on the way out, and never uploaded anywhere.
 */

import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  type WriteStream,
} from 'node:fs';
import { join } from 'node:path';

import { redactDiagnosticText } from './security.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
  readonly logsDir: string;
  readonly minLevel?: LogLevel;
  /** Maximum bytes per file before rotation. */
  readonly maxFileBytes?: number;
  /** Number of rotated files to keep. */
  readonly maxFiles?: number;
  readonly homeDirectory: string | null;
  /** Also mirror to stdout. Development only. */
  readonly mirrorToConsole?: boolean;
}

const DEFAULT_MAX_FILE_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_FILES = 5;

export class Logger {
  private readonly options: LoggerOptions;
  private readonly minLevel: number;
  private stream: WriteStream | null = null;
  private currentPath: string | null = null;
  private bytesWritten = 0;
  private readonly recent: string[] = [];

  constructor(options: LoggerOptions) {
    this.options = options;
    this.minLevel = LEVEL_ORDER[options.minLevel ?? 'info'];
    mkdirSync(options.logsDir, { recursive: true });
    this.rotateIfNeeded(true);
  }

  private currentFileName(): string {
    const stamp = new Date().toISOString().slice(0, 10);
    return `chargewatch-${stamp}.log`;
  }

  private rotateIfNeeded(force = false): void {
    const target = join(this.options.logsDir, this.currentFileName());
    const maxBytes = this.options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;

    if (!force && this.currentPath === target && this.bytesWritten < maxBytes) return;

    this.stream?.end();
    this.stream = null;

    if (this.currentPath === target && this.bytesWritten >= maxBytes) {
      // Same day, file too large: move it aside with a counter suffix.
      let counter = 1;
      let rotated = `${target}.${counter}`;
      while (existsSync(rotated)) {
        counter += 1;
        rotated = `${target}.${counter}`;
      }
      try {
        renameSync(target, rotated);
      } catch {
        /* if rotation fails we keep appending; the cap is advisory */
      }
    }

    this.currentPath = target;
    this.bytesWritten = existsSync(target) ? statSync(target).size : 0;
    this.stream = createWriteStream(target, { flags: 'a', encoding: 'utf8' });
    this.prune();
  }

  private prune(): void {
    const keep = this.options.maxFiles ?? DEFAULT_MAX_FILES;
    try {
      const files = readdirSync(this.options.logsDir)
        .filter((name) => name.startsWith('chargewatch-') && name.includes('.log'))
        .map((name) => ({ name, mtime: statSync(join(this.options.logsDir, name)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      for (const file of files.slice(keep)) {
        unlinkSync(join(this.options.logsDir, file.name));
      }
    } catch {
      /* pruning is best-effort */
    }
  }

  log(level: LogLevel, message: string): void {
    if (LEVEL_ORDER[level] < this.minLevel) return;

    const redacted = redactDiagnosticText(message, this.options.homeDirectory);
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${redacted}\n`;

    // Keep a small in-memory tail for the diagnostics export and the recovery
    // screen, so a user can see what happened without opening a file.
    this.recent.push(line);
    if (this.recent.length > 500) this.recent.shift();

    if (this.options.mirrorToConsole) {
      if (level === 'error' || level === 'warn') console.warn(line.trimEnd());
    }

    this.rotateIfNeeded();
    this.stream?.write(line);
    this.bytesWritten += Buffer.byteLength(line, 'utf8');
  }

  /** The recent tail, already redacted. */
  tail(lines = 200): string[] {
    return this.recent.slice(-lines);
  }

  close(): void {
    this.stream?.end();
    this.stream = null;
  }

  /** A bound function suitable for passing to modules that take a log callback. */
  bind(): (level: LogLevel, message: string) => void {
    return (level, message) => {
      this.log(level, message);
    };
  }
}
