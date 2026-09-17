/**
 * Source URL safety: the "Add location link" path must not become a general
 * URL fetcher, a file reader or an intranet probe (§22).
 *
 * Run: node --experimental-strip-types --test tests/nodeps/source-url-safety.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseRetryAfter, resolveBundledChromium, safeHttpUrl } from '../../src/collector/browser.ts';
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
  test('the adapter ships not-enabled and unverified, with the reason recorded', () => {
    assert.equal(CAPABILITIES.eligibilityState, 'needs_review');
    assert.equal(CAPABILITIES.verificationState, 'blocked');
    assert.equal(CAPABILITIES.termsReviewedAtMs, null);
    assert.equal(CAPABILITIES.eligibilityBasis, null);
    assert.match(CAPABILITIES.notes ?? '', /not automation permission/);
  });

  test('capability limits are at least as strict as the product defaults', () => {
    assert.ok(CAPABILITIES.minIntervalMs >= 15 * 60_000);
    assert.ok(CAPABILITIES.minNavigationIntervalMs >= 30_000);
  });

  test('no recorded-session or charging-distinction claim is made', () => {
    assert.equal(CAPABILITIES.providesRecordedSessions, false);
    assert.equal(CAPABILITIES.distinguishesCharging, false);
    assert.equal(CAPABILITIES.identityReliability, 'none');
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
    const result = resolveBundledChromium({
      isPackaged: false,
      resourcesPath: 'ignored',
      developmentBrowserDir: '/repo/.playwright-cache/chromium',
      platform: 'linux',
    });
    assert.ok(result.searched.every((p) => p.startsWith('/repo/.playwright-cache/chromium')));
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
