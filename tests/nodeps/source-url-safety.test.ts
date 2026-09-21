/**
 * Source URL safety: the "Add location link" path must not become a general
 * URL fetcher, a file reader or an intranet probe (§22).
 *
 * Run: node --experimental-strip-types --test tests/nodeps/source-url-safety.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import {
  parseRetryAfter,
  resolveBundledChromium,
  safeHttpUrl,
} from '../../src/collector/browser.ts';
import {
  ALLOWED_ORIGINS,
  CAPABILITIES,
  isAllowedSourceUrl,
  stationIdFromUrl,
} from '../../src/collector/adapters/chargepoint/index.ts';

describe('URL scheme restriction', () => {
  test('only http and https are accepted', () => {
    assert.ok(safeHttpUrl('https://driver.chargepoint.com/stations/1'));
    assert.ok(safeHttpUrl('http://example.com/'));
    for (const hostile of [
      'file:///C:/Users/Calvin/Documents/secrets.txt',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'chrome://settings',
      'about:blank',
      'ftp://example.com/x',
      'not a url at all',
      '',
    ]) {
      assert.equal(safeHttpUrl(hostile), null, `${hostile} must be refused`);
    }
  });
});

describe('source origin allowlist', () => {
  test('only ChargePoint origins are navigable', () => {
    assert.equal(isAllowedSourceUrl('https://driver.chargepoint.com/stations/11502081'), true);
    assert.equal(isAllowedSourceUrl('https://na.chargepoint.com/stations/1'), true);
  });

  test('look-alike and unrelated hosts are refused', () => {
    for (const hostile of [
      'https://driver.chargepoint.com.evil.example/stations/1',
      'https://evil.example/driver.chargepoint.com/stations/1',
      'http://driver.chargepoint.com/stations/1', // http, not the https origin
      'https://192.168.1.1/admin',
      'https://localhost:8080/',
      'https://169.254.169.254/latest/meta-data/',
      'https://intranet.internal/hr',
      'file:///etc/hosts',
    ]) {
      assert.equal(isAllowedSourceUrl(hostile), false, `${hostile} must be refused`);
    }
  });

  test('the allowlist is explicit and https-only', () => {
    assert.ok(ALLOWED_ORIGINS.length > 0);
    for (const origin of ALLOWED_ORIGINS) {
      assert.ok(origin.startsWith('https://'), `${origin} should be https`);
      assert.equal(new URL(origin).pathname, '/', 'origins carry no path');
    }
  });
});

describe('station identity from URL', () => {
  test('a canonical station URL yields its id', () => {
    assert.equal(stationIdFromUrl('https://driver.chargepoint.com/stations/11502081'), '11502081');
    assert.equal(
      stationIdFromUrl('https://driver.chargepoint.com/stations/11502081?view=list'),
      '11502081',
    );
  });

  test('a map or search URL is not a station', () => {
    assert.equal(
      stationIdFromUrl('https://driver.chargepoint.com/mapCenter/33.4152/-111.8315/12?view=list'),
      null,
    );
    assert.equal(stationIdFromUrl('https://driver.chargepoint.com/'), null);
    assert.equal(stationIdFromUrl('https://driver.chargepoint.com/stations/not-a-number'), null);
  });
});

describe('eligibility gating', () => {
  test('an enabled adapter carries the review that enabled it, in the record itself', () => {
    // Until 2026-09-21 this spec asserted `needs_review` / `blocked`, because
    // nobody had been able to read the provider's terms. The review has now
    // been done and recorded (docs/SOURCE_VERIFICATION.md), so the invariant
    // is the general one: `enabled` is only legitimate alongside a dated
    // review with a stated scope and basis. An adapter flipped to enabled
    // without those fails here.
    assert.equal(CAPABILITIES.eligibilityState, 'enabled');
    assert.equal(CAPABILITIES.verificationState, 'verified');
    assert.ok(
      typeof CAPABILITIES.termsReviewedAtMs === 'number' &&
        Number.isFinite(CAPABILITIES.termsReviewedAtMs),
      'an enabled source must record when its terms were reviewed',
    );
    assert.ok(
      (CAPABILITIES.termsReviewScope ?? '').length > 0,
      'an enabled source must say what the review covered',
    );
    assert.ok(
      (CAPABILITIES.eligibilityBasis ?? '').length > 0,
      'an enabled source must say on what basis it is enabled',
    );
    assert.match(CAPABILITIES.eligibilityBasis ?? '', /robots\.txt/);
  });

  test('capability limits are at least as strict as the product defaults', () => {
    assert.ok(CAPABILITIES.minIntervalMs >= 15 * 60_000);
    assert.ok(CAPABILITIES.minNavigationIntervalMs >= 30_000);
  });

  test('no recorded-session or charging-distinction claim is made', () => {
    assert.equal(CAPABILITIES.providesRecordedSessions, false);
    assert.equal(CAPABILITIES.distinguishesCharging, false);
    // Port identity IS claimed, because the page carries the physical outlet
    // number on every port block; tests/nodeps/chargepoint-captured.test.ts
    // shows it on captured readings.
    assert.equal(CAPABILITIES.identityReliability, 'durable');
  });

  test('the terms URLs that must be reviewed are recorded', () => {
    assert.ok(CAPABILITIES.termsUrls.length >= 2);
    for (const url of CAPABILITIES.termsUrls) assert.ok(safeHttpUrl(url));
  });
});

describe('Retry-After parsing', () => {
  test('a seconds value is honoured', () => {
    assert.equal(parseRetryAfter('120'), 120_000);
    assert.equal(parseRetryAfter('0'), 0);
  });

  test('an HTTP-date value is honoured', () => {
    const now = Date.UTC(2026, 8, 17, 12, 0, 0);
    const later = new Date(now + 90_000).toUTCString();
    assert.equal(parseRetryAfter(later, now), 90_000);
  });

  test('a past date does not produce a negative wait', () => {
    const now = Date.UTC(2026, 8, 17, 12, 0, 0);
    assert.equal(parseRetryAfter(new Date(now - 60_000).toUTCString(), now), 0);
  });

  test('a missing or unparseable header yields null', () => {
    assert.equal(parseRetryAfter(null), null);
    assert.equal(parseRetryAfter('soon'), null);
    assert.equal(parseRetryAfter('-5'), null);
  });
});

describe('bundled browser resolution', () => {
  test('packaged builds resolve from resourcesPath, outside app.asar', () => {
    const result = resolveBundledChromium({
      isPackaged: true,
      resourcesPath: 'C:\\Program Files\\ChargeWatch\\resources',
      developmentBrowserDir: 'ignored',
      platform: 'win32',
    });
    assert.ok(result.searched.every((p) => !p.includes('app.asar')));
    assert.ok(result.searched.some((p) => p.includes('resources')));
    assert.ok(result.searched.every((p) => p.endsWith('chrome.exe')));
  });

  test('development builds resolve from the controlled setup directory', () => {
    // The expected prefix is built with `join` rather than written as a
    // literal, because `resolveBundledChromium` uses `join` too and that
    // normalises separators to the host's. A literal POSIX prefix here passes
    // on Linux and fails on Windows — which is the one platform this
    // application actually ships on.
    const developmentBrowserDir = join('repo-root', '.playwright-cache', 'chromium');
    const result = resolveBundledChromium({
      isPackaged: false,
      resourcesPath: 'ignored',
      developmentBrowserDir,
      platform: 'linux',
    });
    assert.ok(result.searched.length > 0, 'a development build reports where it looked');
    assert.ok(
      result.searched.every((p) => p.startsWith(developmentBrowserDir)),
      `every searched path must sit under the configured directory; got ${result.searched.join(', ')}`,
    );
    // The point of the setting: a development build must not fall back to a
    // browser somewhere else on the machine.
    assert.ok(result.searched.every((p) => !p.includes('resources')));
  });

  test('a missing browser is reported rather than guessed at', () => {
    const result = resolveBundledChromium({
      isPackaged: true,
      resourcesPath: '/nonexistent-resources',
      developmentBrowserDir: '/nonexistent-dev',
      platform: 'win32',
    });
    assert.equal(result.found, false);
    assert.ok(result.searched.length >= 1, 'the searched paths are reported for diagnostics');
  });
});
