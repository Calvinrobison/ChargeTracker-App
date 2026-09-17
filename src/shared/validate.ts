/**
 * Runtime validation for everything crossing a trust boundary: IPC messages,
 * collector output, CSV imports and settings.
 *
 * This is a small, dependency-free schema validator with a Zod-shaped API
 * (`parse`, `safeParse`, inferred types). ADR-0002 records why it is
 * hand-written rather than a dependency.
 *
 * What it guarantees, and why each matters here:
 *  - Unknown keys are STRIPPED by default, so a renderer cannot smuggle extra
 *    fields into a worker call.
 *  - `null` and `undefined` are distinct. A nullable field accepts null; an
 *    optional field accepts absence. Nothing coerces one into the other, and
 *    nothing coerces a missing number into zero.
 *  - Numbers are rejected unless finite, and integer schemas reject 1.5 rather
 *    than rounding it.
 *  - Errors carry the full path to the offending value, so a rejected message
 *    produces a usable diagnostic instead of "invalid input".
 */

export interface Issue {
  /** Property path, e.g. `["counts", "occupied"]`. */
  readonly path: readonly (string | number)[];
  readonly message: string;
}

export class ValidationError extends Error {
  readonly issues: readonly Issue[];

  constructor(issues: readonly Issue[]) {
    const summary = issues
      .slice(0, 5)
      .map((issue) => `${issue.path.length === 0 ? '<root>' : issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    super(
      issues.length <= 5 ? summary : `${summary} (and ${issues.length - 5} more)`,
    );
    this.name = 'ValidationError';
    this.issues = issues;
  }
}

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly Issue[] };

interface Context {
  readonly path: readonly (string | number)[];
}

const ROOT: Context = { path: [] };

function child(context: Context, key: string | number): Context {
  return { path: [...context.path, key] };
}

function fail(context: Context, message: string): ParseResult<never> {
  return { ok: false, issues: [{ path: context.path, message }] };
}

export abstract class Schema<T> {
  abstract check(value: unknown, context: Context): ParseResult<T>;

  /** Validates, throwing ValidationError on failure. */
  parse(value: unknown): T {
    const result = this.check(value, ROOT);
    if (!result.ok) throw new ValidationError(result.issues);
    return result.value;
  }

  safeParse(value: unknown): ParseResult<T> {
    return this.check(value, ROOT);
  }

  /** Accepts null in addition to T. */
  nullable(): Schema<T | null> {
    return new NullableSchema(this);
  }

  /** Marks the field as permitted to be absent. */
  optional(): OptionalSchema<T> {
    return new OptionalSchema(this);
  }

  /** Adds a predicate with its own message. */
  refine(predicate: (value: T) => boolean, message: string): Schema<T> {
    return new RefinedSchema(this, predicate, message);
  }

  /** Supplies a value when the field is absent. */
  withDefault(defaultValue: T): Schema<T> {
    return new DefaultSchema(this, defaultValue);
  }
}

class NullableSchema<T> extends Schema<T | null> {
  private readonly inner: Schema<T>;
  constructor(inner: Schema<T>) {
    super();
    this.inner = inner;
  }
  check(value: unknown, context: Context): ParseResult<T | null> {
    if (value === null) return { ok: true, value: null };
    return this.inner.check(value, context);
  }
}

export class OptionalSchema<T> extends Schema<T | undefined> {
  readonly inner: Schema<T>;
  constructor(inner: Schema<T>) {
    super();
    this.inner = inner;
  }
  check(value: unknown, context: Context): ParseResult<T | undefined> {
    if (value === undefined) return { ok: true, value: undefined };
    return this.inner.check(value, context);
  }
}

class DefaultSchema<T> extends Schema<T> {
  private readonly inner: Schema<T>;
  private readonly defaultValue: T;
  constructor(inner: Schema<T>, defaultValue: T) {
    super();
    this.inner = inner;
    this.defaultValue = defaultValue;
  }
  check(value: unknown, context: Context): ParseResult<T> {
    if (value === undefined) return { ok: true, value: this.defaultValue };
    return this.inner.check(value, context);
  }
}

class RefinedSchema<T> extends Schema<T> {
  private readonly inner: Schema<T>;
  private readonly predicate: (value: T) => boolean;
  private readonly message: string;
  constructor(inner: Schema<T>, predicate: (value: T) => boolean, message: string) {
    super();
    this.inner = inner;
    this.predicate = predicate;
    this.message = message;
  }
  check(value: unknown, context: Context): ParseResult<T> {
    const result = this.inner.check(value, context);
    if (!result.ok) return result;
    if (!this.predicate(result.value)) return fail(context, this.message);
    return result;
  }
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

interface StringOptions {
  readonly min?: number;
  readonly max?: number;
  readonly pattern?: RegExp;
}

class StringSchema extends Schema<string> {
  private readonly opts: StringOptions;
  constructor(opts: StringOptions = {}) {
    super();
    this.opts = opts;
  }
  check(value: unknown, context: Context): ParseResult<string> {
    if (typeof value !== 'string') return fail(context, `expected a string, received ${describe(value)}`);
    if (this.opts.min !== undefined && value.length < this.opts.min) {
      return fail(context, `expected at least ${this.opts.min} characters`);
    }
    if (this.opts.max !== undefined && value.length > this.opts.max) {
      return fail(context, `expected at most ${this.opts.max} characters`);
    }
    if (this.opts.pattern && !this.opts.pattern.test(value)) {
      return fail(context, `does not match ${this.opts.pattern.source}`);
    }
    return { ok: true, value };
  }
}

interface NumberOptions {
  readonly integer?: boolean;
  readonly min?: number;
  readonly max?: number;
}

class NumberSchema extends Schema<number> {
  private readonly opts: NumberOptions;
  constructor(opts: NumberOptions = {}) {
    super();
    this.opts = opts;
  }
  check(value: unknown, context: Context): ParseResult<number> {
    if (typeof value !== 'number') return fail(context, `expected a number, received ${describe(value)}`);
    if (!Number.isFinite(value)) return fail(context, 'expected a finite number');
    if (this.opts.integer && !Number.isInteger(value)) {
      return fail(context, `expected an integer, received ${value}`);
    }
    if (this.opts.min !== undefined && value < this.opts.min) {
      return fail(context, `expected >= ${this.opts.min}, received ${value}`);
    }
    if (this.opts.max !== undefined && value > this.opts.max) {
      return fail(context, `expected <= ${this.opts.max}, received ${value}`);
    }
    return { ok: true, value };
  }
}

class BooleanSchema extends Schema<boolean> {
  check(value: unknown, context: Context): ParseResult<boolean> {
    if (typeof value !== 'boolean') return fail(context, `expected a boolean, received ${describe(value)}`);
    return { ok: true, value };
  }
}

class LiteralSchema<T extends string | number | boolean> extends Schema<T> {
  private readonly expected: T;
  constructor(expected: T) {
    super();
    this.expected = expected;
  }
  check(value: unknown, context: Context): ParseResult<T> {
    if (value !== this.expected) {
      return fail(context, `expected ${JSON.stringify(this.expected)}, received ${describe(value)}`);
    }
    return { ok: true, value: this.expected };
  }
}

class EnumSchema<T extends string> extends Schema<T> {
  private readonly values: readonly T[];
  constructor(values: readonly T[]) {
    super();
    this.values = values;
  }
  check(value: unknown, context: Context): ParseResult<T> {
    if (typeof value !== 'string' || !this.values.includes(value as T)) {
      return fail(
        context,
        `expected one of ${this.values.map((v) => JSON.stringify(v)).join(', ')}, received ${describe(value)}`,
      );
    }
    return { ok: true, value: value as T };
  }
}

class UnknownSchema extends Schema<unknown> {
  check(value: unknown): ParseResult<unknown> {
    return { ok: true, value };
  }
}

// ---------------------------------------------------------------------------
// Composites
// ---------------------------------------------------------------------------

class ArraySchema<T> extends Schema<T[]> {
  private readonly element: Schema<T>;
  private readonly opts: { readonly min?: number; readonly max?: number };
  constructor(element: Schema<T>, opts: { readonly min?: number; readonly max?: number } = {}) {
    super();
    this.element = element;
    this.opts = opts;
  }
  check(value: unknown, context: Context): ParseResult<T[]> {
    if (!Array.isArray(value)) return fail(context, `expected an array, received ${describe(value)}`);
    if (this.opts.min !== undefined && value.length < this.opts.min) {
      return fail(context, `expected at least ${this.opts.min} items`);
    }
    if (this.opts.max !== undefined && value.length > this.opts.max) {
      return fail(context, `expected at most ${this.opts.max} items`);
    }
    const issues: Issue[] = [];
    const out: T[] = [];
    value.forEach((item, index) => {
      const result = this.element.check(item, child(context, index));
      if (result.ok) out.push(result.value);
      else issues.push(...result.issues);
    });
    if (issues.length > 0) return { ok: false, issues };
    return { ok: true, value: out };
  }
}

type ShapeOf<S extends Record<string, Schema<unknown>>> = {
  [K in keyof S]: S[K] extends Schema<infer T> ? T : never;
};

/** Keys whose schema is optional become optional properties. */
type WithOptional<T> = {
  [K in keyof T as undefined extends T[K] ? never : K]: T[K];
} & {
  [K in keyof T as undefined extends T[K] ? K : never]?: T[K];
};

class ObjectSchema<S extends Record<string, Schema<unknown>>> extends Schema<
  WithOptional<ShapeOf<S>>
> {
  readonly shape: S;
  private readonly strict: boolean;

  constructor(shape: S, strict = false) {
    super();
    this.shape = shape;
    this.strict = strict;
  }

  /** Rejects unknown keys instead of stripping them. */
  strictKeys(): ObjectSchema<S> {
    return new ObjectSchema(this.shape, true);
  }

  check(value: unknown, context: Context): ParseResult<WithOptional<ShapeOf<S>>> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return fail(context, `expected an object, received ${describe(value)}`);
    }
    const input = value as Record<string, unknown>;
    const issues: Issue[] = [];
    const out: Record<string, unknown> = {};

    for (const [key, schema] of Object.entries(this.shape)) {
      const present = Object.prototype.hasOwnProperty.call(input, key);
      const raw = present ? input[key] : undefined;
      const result = schema.check(raw, child(context, key));
      if (!result.ok) {
        issues.push(...result.issues);
        continue;
      }
      // An optional key that was absent stays absent rather than becoming
      // an explicit undefined, so `in` checks behave as callers expect.
      if (result.value === undefined && !present) continue;
      out[key] = result.value;
    }

    if (this.strict) {
      for (const key of Object.keys(input)) {
        if (!Object.prototype.hasOwnProperty.call(this.shape, key)) {
          issues.push({ path: [...context.path, key], message: 'unexpected key' });
        }
      }
    }

    if (issues.length > 0) return { ok: false, issues };
    return { ok: true, value: out as WithOptional<ShapeOf<S>> };
  }
}

class UnionSchema<T> extends Schema<T> {
  private readonly options: readonly Schema<unknown>[];
  constructor(options: readonly Schema<unknown>[]) {
    super();
    this.options = options;
  }
  check(value: unknown, context: Context): ParseResult<T> {
    const collected: Issue[] = [];
    for (const option of this.options) {
      const result = option.check(value, context);
      if (result.ok) return { ok: true, value: result.value as T };
      collected.push(...result.issues);
    }
    return {
      ok: false,
      issues: [
        {
          path: context.path,
          message: `did not match any permitted shape (${collected.length} candidate issues)`,
        },
        ...collected,
      ],
    };
  }
}

class RecordSchema<T> extends Schema<Record<string, T>> {
  private readonly valueSchema: Schema<T>;
  constructor(valueSchema: Schema<T>) {
    super();
    this.valueSchema = valueSchema;
  }
  check(value: unknown, context: Context): ParseResult<Record<string, T>> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return fail(context, `expected an object, received ${describe(value)}`);
    }
    const issues: Issue[] = [];
    const out: Record<string, T> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      const result = this.valueSchema.check(raw, child(context, key));
      if (result.ok) out[key] = result.value;
      else issues.push(...result.issues);
    }
    if (issues.length > 0) return { ok: false, issues };
    return { ok: true, value: out };
  }
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  if (typeof value === 'object') return 'an object';
  if (typeof value === 'string') return `a string (${JSON.stringify(value.slice(0, 32))})`;
  return typeof value;
}

// ---------------------------------------------------------------------------
// Public builders
// ---------------------------------------------------------------------------

export const v = {
  string(opts?: { min?: number; max?: number; pattern?: RegExp }): Schema<string> {
    return new StringSchema(opts);
  },
  number(opts?: { min?: number; max?: number }): Schema<number> {
    return new NumberSchema(opts);
  },
  integer(opts?: { min?: number; max?: number }): Schema<number> {
    return new NumberSchema({ ...opts, integer: true });
  },
  /**
   * A UTC instant in integer milliseconds, range-checked so a seconds value
   * or a 2100+ value is rejected at the boundary rather than shifting history.
   */
  instant(): Schema<number> {
    return new NumberSchema({ integer: true, min: 0, max: 4_102_444_800_000 });
  },
  /** A non-negative port count within the product's sanity bound. */
  portCount(): Schema<number> {
    return new NumberSchema({ integer: true, min: 0, max: 10_000 });
  },
  latitude(): Schema<number> {
    return new NumberSchema({ min: -90, max: 90 });
  },
  longitude(): Schema<number> {
    return new NumberSchema({ min: -180, max: 180 });
  },
  boolean(): Schema<boolean> {
    return new BooleanSchema();
  },
  literal<T extends string | number | boolean>(expected: T): Schema<T> {
    return new LiteralSchema(expected);
  },
  enumOf<T extends string>(values: readonly T[]): Schema<T> {
    return new EnumSchema(values);
  },
  array<T>(element: Schema<T>, opts?: { min?: number; max?: number }): Schema<T[]> {
    return new ArraySchema(element, opts);
  },
  object<S extends Record<string, Schema<unknown>>>(shape: S): ObjectSchema<S> {
    return new ObjectSchema(shape);
  },
  union<T>(options: readonly Schema<unknown>[]): Schema<T> {
    return new UnionSchema<T>(options);
  },
  record<T>(valueSchema: Schema<T>): Schema<Record<string, T>> {
    return new RecordSchema(valueSchema);
  },
  /** Deliberately unvalidated. Used only for opaque JSON blobs we re-emit. */
  unknown(): Schema<unknown> {
    return new UnknownSchema();
  },
};

export type Infer<S> = S extends Schema<infer T> ? T : never;
