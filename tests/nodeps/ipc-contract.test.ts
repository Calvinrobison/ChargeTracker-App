/**
 * IPC contract surface (§9, §22).
 *
 * Run: node --experimental-strip-types --test tests/nodeps/ipc-contract.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  ERROR_MESSAGES,
  EVENT_NAMES,
  IPC_CONTRACT_VERSION,
  OPERATIONS,
  OPERATION_NAMES,
  filterStateSchema,
  isEventName,
  isOperationName,
  requestEnvelopeSchema,
  windowRequestSchema,
} from '../../src/shared/ipc.ts';
import { ValidationError } from '../../src/shared/validate.ts';
import { DAY, T0 } from './helpers.ts';

describe('operation registry', () => {
  test('there is no general-purpose invoke surface: every operation is named', () => {
    assert.ok(OPERATION_NAMES.length > 0);
    for (const name of OPERATION_NAMES) {
      const spec = OPERATIONS[name];
      assert.equal(spec.name, name, 'the key and the declared name agree');
      assert.ok(spec.request, `${name} declares a request schema`);
      assert.ok(spec.timeoutMs > 0, `${name} declares a timeout`);
      assert.equal(typeof spec.mutating, 'boolean');
      assert.equal(typeof spec.cancellable, 'boolean');
    }
  });

  test('unknown operation names are rejected', () => {
    assert.equal(isOperationName('overview.get'), true);
    for (const hostile of [
      'db.query',
      'eval',
      '__proto__',
      'constructor',
      'toString',
      'shell.exec',
      '',
      42,
      null,
    ]) {
      assert.equal(isOperationName(hostile), false, `${String(hostile)} must not be an operation`);
    }
  });

  test('long-running operations are cancellable and read-only ones are not mutating', () => {
    assert.equal(OPERATIONS['export.rawObservations'].cancellable, true);
    assert.equal(OPERATIONS['overview.get'].cancellable, true);
    assert.equal(OPERATIONS['overview.get'].mutating, false);
    assert.equal(OPERATIONS['app.getBootstrap'].mutating, false);
    assert.equal(OPERATIONS['backup.list'].mutating, false);
  });

  test('destructive operations require explicit confirmation in their schema', () => {
    for (const name of [
      'restore.perform',
      'data.deleteRange',
      'update.restartAndInstall',
    ] as const) {
      const spec = OPERATIONS[name];
      assert.equal(spec.mutating, true, `${name} is mutating`);
      const unconfirmed = spec.request.safeParse({
        confirmed: false,
        filePath: 'C:/tmp/backup.sqlite',
        beforeMs: T0,
      });
      assert.equal(unconfirmed.ok, false, `${name} must refuse an unconfirmed request`);
    }
  });

  test('a destructive operation accepts a confirmed request', () => {
    const ok = OPERATIONS['data.deleteRange'].request.safeParse({ beforeMs: T0, confirmed: true });
    assert.equal(ok.ok, true);
  });
});

describe('request envelope', () => {
  test('a well-formed envelope parses', () => {
    const parsed = requestEnvelopeSchema.parse({
      contractVersion: IPC_CONTRACT_VERSION,
      requestId: 'abcd1234efgh',
      operation: 'overview.get',
      payload: {},
    });
    assert.equal(parsed.operation, 'overview.get');
  });

  test('a malformed request id is rejected', () => {
    for (const bad of ['short', 'has spaces here', 'semi;colon;inject', '../../etc/passwd']) {
      const result = requestEnvelopeSchema.safeParse({
        contractVersion: 1,
        requestId: bad,
        operation: 'overview.get',
        payload: {},
      });
      assert.equal(result.ok, false, `${bad} must be rejected`);
    }
  });

  test('extra envelope keys are stripped', () => {
    const parsed = requestEnvelopeSchema.parse({
      contractVersion: 1,
      requestId: 'abcd1234efgh',
      operation: 'overview.get',
      payload: {},
      privileged: true,
      senderOverride: 'main',
    });
    assert.deepEqual(Object.keys(parsed).sort(), [
      'contractVersion',
      'operation',
      'payload',
      'requestId',
    ]);
  });

  test('a missing contract version is rejected rather than defaulted', () => {
    const result = requestEnvelopeSchema.safeParse({
      requestId: 'abcd1234efgh',
      operation: 'overview.get',
      payload: {},
    });
    assert.equal(result.ok, false);
  });
});

describe('window requests', () => {
  test('presets parse without custom bounds', () => {
    assert.equal(windowRequestSchema.parse({ preset: '30d' }).preset, '30d');
    assert.equal(windowRequestSchema.parse({ preset: 'all' }).preset, 'all');
  });

  test('a custom window without both bounds is rejected', () => {
    assert.throws(() => windowRequestSchema.parse({ preset: 'custom' }), ValidationError);
    assert.throws(
      () => windowRequestSchema.parse({ preset: 'custom', customStartMs: T0 }),
      ValidationError,
    );
    assert.ok(
      windowRequestSchema.parse({ preset: 'custom', customStartMs: T0, customEndMs: T0 + DAY }),
    );
  });

  test('an unknown preset is rejected', () => {
    assert.throws(() => windowRequestSchema.parse({ preset: '90d' }), ValidationError);
  });

  test('a seconds-valued instant is rejected', () => {
    assert.throws(
      () =>
        windowRequestSchema.parse({ preset: 'custom', customStartMs: 1.7e9, customEndMs: 1.8e13 }),
      ValidationError,
    );
  });
});

describe('filter state', () => {
  test('filters default to an empty, unfiltered state', () => {
    const parsed = filterStateSchema.parse({});
    assert.equal(parsed.query, '');
    assert.deepEqual(parsed.networks, []);
    assert.equal(parsed.savedOnly, false);
    assert.equal(parsed.cohort, 'dc_fast');
  });

  test('an overlong query or oversized list is rejected', () => {
    assert.throws(() => filterStateSchema.parse({ query: 'x'.repeat(201) }), ValidationError);
    assert.throws(
      () => filterStateSchema.parse({ networks: Array.from({ length: 41 }, (_, i) => `n${i}`) }),
      ValidationError,
    );
  });

  test('an unknown monitoring state is rejected', () => {
    assert.throws(
      () => filterStateSchema.parse({ monitoringStates: ['imaginary'] }),
      ValidationError,
    );
  });
});

describe('manual source links', () => {
  test('only http and https links are accepted at the contract boundary', () => {
    const spec = OPERATIONS['sites.addManualLink'].request;
    assert.ok(
      spec.safeParse({ siteId: 's1', url: 'https://driver.chargepoint.com/stations/1' }).ok,
    );
    for (const hostile of [
      'file:///C:/Users/Calvin/Documents/secrets.txt',
      'javascript:alert(1)',
      'data:text/html,<script>',
      'chrome://settings',
      'ftp://example.com',
      '\\\\server\\share',
    ]) {
      assert.equal(
        spec.safeParse({ siteId: 's1', url: hostile }).ok,
        false,
        `${hostile} must be rejected before it reaches the collector`,
      );
    }
  });

  test('the allowlist check is a second gate, not the only one', () => {
    // The contract accepts any https URL; the adapter's origin allowlist is
    // what refuses non-ChargePoint hosts. Both layers must exist.
    assert.ok(
      OPERATIONS['sites.addManualLink'].request.safeParse({
        siteId: 's1',
        url: 'https://example.com/anything',
      }).ok,
      'the contract permits the shape',
    );
  });
});

describe('visit imports', () => {
  test('a manual visit entry rejects negatives, fractions and inverted periods', () => {
    const spec = OPERATIONS['visits.addManual'].request;
    const base = {
      siteId: 's1',
      periodStartMs: T0,
      periodEndMs: T0 + DAY,
      visitCount: 100,
      countDefinition: 'property_entries',
      method: 'measured',
      sourceName: 'Site owner',
      geographicScope: 'whole_property',
      notes: null,
    };
    assert.ok(spec.safeParse(base).ok);
    assert.equal(spec.safeParse({ ...base, visitCount: -1 }).ok, false);
    assert.equal(spec.safeParse({ ...base, visitCount: 1.5 }).ok, false);
    assert.equal(spec.safeParse({ ...base, periodEndMs: T0 - DAY }).ok, false);
    assert.equal(spec.safeParse({ ...base, periodEndMs: T0 }).ok, false, 'zero-length is rejected');
    assert.equal(spec.safeParse({ ...base, countDefinition: 'popular_times' }).ok, false);
  });

  test('a zero visit count is accepted as real data', () => {
    const spec = OPERATIONS['visits.addManual'].request;
    assert.ok(
      spec.safeParse({
        siteId: 's1',
        periodStartMs: T0,
        periodEndMs: T0 + DAY,
        visitCount: 0,
        countDefinition: 'property_entries',
        method: 'measured',
        sourceName: 'Site owner',
        geographicScope: 'whole_property',
        notes: null,
      }).ok,
    );
  });
});

describe('error presentation', () => {
  test('every error code has understandable user-facing text', () => {
    for (const [code, message] of Object.entries(ERROR_MESSAGES)) {
      assert.ok(message.length > 10, `${code} needs a real message`);
      assert.ok(!/stack|Error:|undefined|null/.test(message), `${code} leaks internals`);
    }
  });

  test('the schema-too-new message tells the user what to do', () => {
    assert.match(ERROR_MESSAGES.database_schema_too_new, /newer version/);
  });

  test('the disk-full message reassures that history is intact', () => {
    assert.match(ERROR_MESSAGES.disk_full, /history is intact/);
  });
});

describe('events', () => {
  test('only declared events are recognised', () => {
    for (const name of EVENT_NAMES) assert.equal(isEventName(name), true);
    for (const hostile of ['eval', '__proto__', 'collection', '', null]) {
      assert.equal(isEventName(hostile), false);
    }
  });
});
