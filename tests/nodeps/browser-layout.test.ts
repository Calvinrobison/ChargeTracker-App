/**
 * The application shipped a 432 MB Chromium and then could not find it.
 *
 * `resolveBundledChromium` looked at `resources/browser/chrome-win/chrome.exe`
 * and `resources/browser/chrome.exe`. The payload was at
 * `resources/browser/chromium-1243/chrome-win64/chrome.exe`. Both build-time
 * checks passed, because both searched the tree recursively for a file named
 * chrome.exe rather than asking whether it was where the app looks.
 *
 * These specs build that exact directory shape on disk and assert the resolver
 * finds it, and that the .mjs copy the build scripts use agrees path for path.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { chromiumCandidates, resolveBundledChromium } from '../../src/collector/browser.ts';
import { chromiumCandidates as scriptCandidates } from '../../scripts/lib/browser-layout.mjs';

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'cw-browser-'));
  roots.push(root);
  return root;
}

function place(root: string, ...segments: string[]): string {
  const file = join(root, ...segments);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, 'not really chromium');
  return file;
}

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('the packaged browser is found where Playwright actually puts it', () => {
  it('finds chromium-<revision>/chrome-win64/chrome.exe, the layout that shipped', () => {
    const resources = makeRoot();
    const expected = place(resources, 'browser', 'chromium-1243', 'chrome-win64', 'chrome.exe');

    const result = resolveBundledChromium({
      isPackaged: true,
      resourcesPath: resources,
      developmentBrowserDir: join(resources, 'unused'),
      platform: 'win32',
    });

    assert.equal(result.found, true);
    assert.equal(result.path, expected);
  });

  it('still finds the flat chrome-win layout', () => {
    const resources = makeRoot();
    const expected = place(resources, 'browser', 'chrome-win', 'chrome.exe');

    const result = resolveBundledChromium({
      isPackaged: true,
      resourcesPath: resources,
      developmentBrowserDir: join(resources, 'unused'),
      platform: 'win32',
    });

    assert.equal(result.found, true);
    assert.equal(result.path, expected);
  });

  it('prefers the newest revision when two are present', () => {
    const resources = makeRoot();
    place(resources, 'browser', 'chromium-1099', 'chrome-win64', 'chrome.exe');
    const newer = place(resources, 'browser', 'chromium-1243', 'chrome-win64', 'chrome.exe');

    const result = resolveBundledChromium({
      isPackaged: true,
      resourcesPath: resources,
      developmentBrowserDir: join(resources, 'unused'),
      platform: 'win32',
    });

    assert.equal(result.path, newer, 'a stale payload must not win over a current one');
  });

  it('resolves the development cache the same way', () => {
    const cache = makeRoot();
    const expected = place(cache, 'chromium-1243', 'chrome-win64', 'chrome.exe');

    const result = resolveBundledChromium({
      isPackaged: false,
      resourcesPath: join(cache, 'unused'),
      developmentBrowserDir: cache,
      platform: 'win32',
    });

    assert.equal(result.found, true);
    assert.equal(result.path, expected);
  });

  it('reports what it searched when nothing is there, rather than a bare failure', () => {
    const resources = makeRoot();

    const result = resolveBundledChromium({
      isPackaged: true,
      resourcesPath: resources,
      developmentBrowserDir: join(resources, 'unused'),
      platform: 'win32',
    });

    assert.equal(result.found, false);
    assert.ok(result.searched.length >= 2, 'the searched paths are the diagnostic');
    assert.ok(result.searched.every((path) => path.endsWith('chrome.exe')));
  });
});

describe('the build checks look where the application looks', () => {
  it('the script copy produces the same candidates, in the same order', () => {
    const resources = makeRoot();
    place(resources, 'chromium-1243', 'chrome-win64', 'chrome.exe');
    place(resources, 'chromium-1099', 'chrome-win64', 'chrome.exe');

    for (const platform of ['win32', 'linux', 'darwin'] as const) {
      assert.deepEqual(
        scriptCandidates(resources, platform),
        chromiumCandidates(resources, platform),
        `the ${platform} candidate lists have diverged; a passing build check ` +
          'would no longer mean the application can start',
      );
    }
  });

  it('a payload at the wrong path is not treated as present', () => {
    const resources = makeRoot();
    // A chrome.exe that a recursive search would happily have found.
    place(resources, 'browser', 'third_party', 'chrome.exe');

    const candidates = scriptCandidates(join(resources, 'browser'), 'win32');
    assert.ok(
      !candidates.some((candidate) => candidate.includes('third_party')),
      'finding any chrome.exe anywhere is the check that let this ship',
    );
  });
});
