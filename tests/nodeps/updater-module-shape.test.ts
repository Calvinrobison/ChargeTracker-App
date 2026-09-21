/**
 * Automatic updates have never worked in a packaged build.
 *
 * The installed application logged this on every launch:
 *
 *     WARN the updater could not be initialised: Cannot set properties of
 *     undefined (setting 'autoDownload'). ChargeWatch keeps collecting.
 *
 * electron-updater is CommonJS. `import('electron-updater')` from the bundled
 * ESM main process resolved its exports under `.default`, so reading
 * `module.autoUpdater` gave `undefined`, and the first property assignment in
 * `configureManualControl` threw. The failure was caught and logged as a
 * warning, the application carried on, and nobody noticed — an entire
 * subsystem, including all the signature verification it gates, was dead in
 * every package ever built.
 *
 * Two things had to change. `resolveAutoUpdater` looks in both shapes, and a
 * module that yields nothing usable is now an ERROR that names the
 * consequence, rather than a warning that reads like a passing remark.
 *
 * These specs pin the shapes. They need no dependencies: the whole point is
 * that the module's shape is the variable, so the specs supply it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveAutoUpdater } from '../../src/main/updates-backend.ts';

/** Enough of the real object to be recognisably it. */
function fakeAutoUpdater(): Record<string, unknown> {
  return {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    allowPrerelease: false,
    allowDowngrade: false,
    channel: null,
    setFeedURL: () => undefined,
    checkForUpdates: async () => null,
    downloadUpdate: async () => [],
    quitAndInstall: () => undefined,
    on: () => undefined,
    removeAllListeners: () => undefined,
  };
}

describe('finding autoUpdater in whatever shape the module arrives in', () => {
  it('finds it on the namespace, which is what a true ESM export looks like', () => {
    const updater = fakeAutoUpdater();
    assert.equal(resolveAutoUpdater({ autoUpdater: updater }), updater);
  });

  it('finds it under .default, which is the shape that actually shipped', () => {
    const updater = fakeAutoUpdater();
    assert.equal(resolveAutoUpdater({ default: { autoUpdater: updater } }), updater);
  });

  it('prefers the namespace when both are present and identical', () => {
    const updater = fakeAutoUpdater();
    const resolved = resolveAutoUpdater({
      autoUpdater: updater,
      default: { autoUpdater: updater },
    });
    assert.equal(resolved, updater);
  });

  it('returns the object it found, not a copy, so listeners attach to the real one', () => {
    const updater = fakeAutoUpdater();
    const resolved = resolveAutoUpdater({ default: { autoUpdater: updater } });
    assert.equal(resolved, updater, 'a copy would receive events the library never fires');
  });
});

describe('a module that cannot supply an updater is refused, not half-used', () => {
  it('refuses the exact failure that shipped: the key present and undefined', () => {
    // `{ autoUpdater: undefined }` is what the packaged build saw. Anything
    // that hands this back as usable reproduces the original crash one line
    // later, at `autoUpdater.autoDownload = false`.
    assert.equal(resolveAutoUpdater({ autoUpdater: undefined }), null);
  });

  it('refuses an empty module, a null default and a default without the key', () => {
    assert.equal(resolveAutoUpdater({}), null);
    assert.equal(resolveAutoUpdater({ default: null }), null);
    assert.equal(resolveAutoUpdater({ default: {} }), null);
  });

  it('refuses non-objects rather than throwing on them', () => {
    for (const value of [null, undefined, 'electron-updater', 42, true]) {
      assert.equal(resolveAutoUpdater(value), null, `${String(value)} should resolve to null`);
    }
  });

  it('refuses a non-object autoUpdater, which cannot be configured', () => {
    assert.equal(resolveAutoUpdater({ autoUpdater: 'yes' }), null);
    assert.equal(resolveAutoUpdater({ default: { autoUpdater: 0 } }), null);
  });

  it('says no with null specifically, so a caller cannot read it as "not checked yet"', () => {
    // undefined would be ambiguous between "no updater" and "never looked".
    // The caller turns this into an error that names the consequence, so the
    // distinction has to survive the return.
    const resolved = resolveAutoUpdater({});
    assert.strictEqual(resolved, null);
    assert.notStrictEqual(resolved, undefined);
  });
});
