/**
 * Runtime validation at trust boundaries (§9, §22).
 *
 * Run: node --experimental-strip-types --test tests/nodeps/validate.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { ValidationError, v } from '../../src/shared/validate.ts';

describe('primitives', () => {
  test('strings reject non-strings and honour bounds', () => {
    assert.equal(v.string().parse('ok'), 'ok');
    assert.throws(() => v.string().parse(42), ValidationError);
    assert.throws(() => v.string().parse(null), ValidationError);
    assert.throws(() => v.string({ min: 2 }).parse('a'), ValidationError);
    assert.throws(() => v.string({ max: 2 }).parse('abc'), ValidationError);
    assert.throws(() => v.string({ pattern: /^\d+$/ }).parse('abc'), ValidationError);
  });

  test('numbers reject NaN, Infinity and strings', () => {
    assert.equal(v.number().parse(1.5), 1.5);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, '5', null, undefined]) {
      assert.throws(
        () => v.number().parse(bad),
        ValidationError,
        `${String(bad)} must be rejected`,
      );
    }
  });

  test('integer schemas reject fractions rather than rounding', () => {
    assert.equal(v.integer().parse(3), 3);
    assert.throws(() => v.integer().parse(1.5), ValidationError);
  });

  test('a port count rejects negatives and absurd values', () => {
    assert.equal(v.portCount().parse(0), 0);
    assert.throws(() => v.portCount().parse(-1), ValidationError);
    assert.throws(() => v.portCount().parse(10_001), ValidationError);
  });

  test('an instant rejects a seconds value posing as milliseconds', () => {
    const nowMs = Date.UTC(2026, 8, 17);
    assert.equal(v.instant().parse(nowMs), nowMs);
    assert.throws(() => v.instant().parse(-1), ValidationError);
    assert.throws(() => v.instant().parse(9_999_999_999_999), ValidationError);
    assert.throws(() => v.instant().parse(1.5), ValidationError);
  });

  test('coordinates are range-checked', () => {
    assert.equal(v.latitude().parse(33.4152), 33.4152);
    assert.throws(() => v.latitude().parse(91), ValidationError);
    assert.throws(() => v.longitude().parse(-181), ValidationError);
  });

  test('enums and literals accept only their members', () => {
    const level = v.enumOf(['level_2', 'dc_fast'] as const);
    assert.equal(level.parse('dc_fast'), 'dc_fast');
    assert.throws(() => level.parse('level_3'), ValidationError);
    assert.equal(v.literal(1).parse(1), 1);
    assert.throws(() => v.literal(1).parse(2), ValidationError);
  });
});

describe('null versus undefined', () => {
  const schema = v.object({
    required: v.integer(),
    nullableField: v.integer().nullable(),
    optionalField: v.integer().optional(),
  });

  test('a nullable field accepts null but not absence', () => {
    const parsed = schema.parse({ required: 1, nullableField: null });
    assert.equal(parsed.nullableField, null);
    assert.throws(() => schema.parse({ required: 1 }), ValidationError);
  });

  test('an optional field accepts absence but the key stays absent', () => {
    const parsed = schema.parse({ required: 1, nullableField: 2 });
    assert.equal('optionalField' in parsed, false, 'absent means absent, not undefined');
  });

  test('a missing number never becomes zero', () => {
    const result = schema.safeParse({ nullableField: null });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.deepEqual(result.issues[0]?.path, ['required']);
  });

  test('null is not accepted where only a number is allowed', () => {
    assert.throws(() => schema.parse({ required: null, nullableField: null }), ValidationError);
  });
});

describe('objects', () => {
  test('unknown keys are stripped by default', () => {
    const schema = v.object({ a: v.integer() });
    const parsed = schema.parse({ a: 1, smuggled: 'payload', __proto__: 'nope' });
    assert.deepEqual(Object.keys(parsed), ['a']);
  });

  test('strict mode rejects unknown keys with their path', () => {
    const schema = v.object({ a: v.integer() }).strictKeys();
    const result = schema.safeParse({ a: 1, extra: true });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.deepEqual(result.issues[0]?.path, ['extra']);
    assert.match(result.issues[0]?.message ?? '', /unexpected key/);
  });

  test('arrays and objects are not interchangeable', () => {
    assert.throws(() => v.object({ a: v.integer() }).parse([1]), ValidationError);
    assert.throws(() => v.array(v.integer()).parse({ 0: 1 }), ValidationError);
  });

  test('a default fills an absent field only', () => {
    const schema = v.object({ paused: v.boolean().withDefault(false) });
    assert.equal(schema.parse({}).paused, false);
    assert.equal(schema.parse({ paused: true }).paused, true);
  });
});

describe('nested error paths', () => {
  test('the full path to the offending value is reported', () => {
    const schema = v.object({
      observations: v.array(
        v.object({
          scopeKey: v.string(),
          counts: v.object({ occupied: v.portCount().nullable() }),
        }),
      ),
    });
    const result = schema.safeParse({
      observations: [
        { scopeKey: 'a', counts: { occupied: 1 } },
        { scopeKey: 'b', counts: { occupied: -4 } },
      ],
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.deepEqual(result.issues[0]?.path, ['observations', 1, 'counts', 'occupied']);
  });

  test('a thrown error summarises the issues readably', () => {
    const schema = v.object({ a: v.integer(), b: v.string() });
    try {
      schema.parse({ a: 'x', b: 2 });
      assert.fail('should have thrown');
    } catch (error) {
      assert.ok(error instanceof ValidationError);
      assert.equal(error.issues.length, 2);
      assert.match(error.message, /a: expected an integer|a: expected a number/);
    }
  });
});

describe('unions, records and refinements', () => {
  test('a union accepts any permitted shape and rejects others', () => {
    const schema = v.union<
      { kind: 'preset'; preset: string } | { kind: 'custom'; startMs: number }
    >([
      v.object({ kind: v.literal('preset'), preset: v.string() }),
      v.object({ kind: v.literal('custom'), startMs: v.instant() }),
    ]);
    assert.equal(schema.parse({ kind: 'preset', preset: '30d' }).kind, 'preset');
    assert.equal(schema.parse({ kind: 'custom', startMs: 0 }).kind, 'custom');
    assert.throws(() => schema.parse({ kind: 'other' }), ValidationError);
  });

  test('a record validates every value', () => {
    const schema = v.record(v.integer());
    assert.deepEqual(schema.parse({ a: 1, b: 2 }), { a: 1, b: 2 });
    assert.throws(() => schema.parse({ a: 1, b: 'x' }), ValidationError);
  });

  test('a refinement carries its own message', () => {
    const schema = v
      .object({ startMs: v.instant(), endMs: v.instant() })
      .refine((value) => value.endMs > value.startMs, 'endMs must be after startMs');
    assert.ok(schema.parse({ startMs: 0, endMs: 1 }));
    const result = schema.safeParse({ startMs: 10, endMs: 10 });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.issues[0]?.message, 'endMs must be after startMs');
  });

  test('array bounds are enforced so a batch cannot be unbounded', () => {
    const schema = v.array(v.integer(), { max: 2 });
    assert.deepEqual(schema.parse([1, 2]), [1, 2]);
    assert.throws(() => schema.parse([1, 2, 3]), ValidationError);
  });
});

describe('hostile input', () => {
  test('prototype pollution attempts are stripped, not applied', () => {
    const schema = v.object({ a: v.integer() });
    const hostile = JSON.parse(
      '{"a":1,"__proto__":{"polluted":true},"constructor":{"x":1}}',
    ) as unknown;
    const parsed = schema.parse(hostile);
    assert.deepEqual(Object.keys(parsed), ['a']);
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  });

  test('a function or symbol value is rejected', () => {
    const schema = v.object({ a: v.string() });
    assert.throws(() => schema.parse({ a: () => 'x' }), ValidationError);
    assert.throws(() => schema.parse({ a: Symbol('x') }), ValidationError);
  });

  test('a deeply nested payload fails cleanly rather than hanging', () => {
    const schema = v.object({ items: v.array(v.integer(), { max: 10 }) });
    const deep = { items: Array.from({ length: 1000 }, (_, i) => i) };
    const result = schema.safeParse(deep);
    assert.equal(result.ok, false);
  });
});
