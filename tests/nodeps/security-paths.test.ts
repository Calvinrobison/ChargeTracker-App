/**
 * Desktop security policy and data-path placement (§22, §23).
 *
 * Run: node --experimental-strip-types --test tests/nodeps/security-paths.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  DOCUMENTED_OUTBOUND_CONNECTIONS,
  RENDERER_WEB_PREFERENCES,
  buildContentSecurityPolicy,
  decideNavigation,
  decidePermission,
  isTrustedSender,
  redactDiagnosticText,
  rendererFileOrigin,
} from '../../src/main/security.ts';
import {
  DATA_DIRECTORY_NAME,
  DIAGNOSTIC_EXCLUDED_DIRS,
  isPermittedWriteDestination,
  resolveDataPaths,
} from '../../src/main/paths.ts';

const APP_ORIGINS = ['file:///C:/Program%20Files/ChargeWatch/resources/app.asar/out/renderer/'];
const TILES = ['https://tile.openstreetmap.org'];
const UPDATES = ['https://api.github.com', 'https://github.com'];

describe('renderer hardening', () => {
  test('context isolation on, sandbox on, node integration off', () => {
    assert.equal(RENDERER_WEB_PREFERENCES.contextIsolation, true);
    assert.equal(RENDERER_WEB_PREFERENCES.sandbox, true);
    assert.equal(RENDERER_WEB_PREFERENCES.nodeIntegration, false);
    assert.equal(RENDERER_WEB_PREFERENCES.nodeIntegrationInWorker, false);
    assert.equal(RENDERER_WEB_PREFERENCES.nodeIntegrationInSubFrames, false);
    assert.equal(RENDERER_WEB_PREFERENCES.webviewTag, false);
    assert.equal(RENDERER_WEB_PREFERENCES.webSecurity, true);
    assert.equal(RENDERER_WEB_PREFERENCES.allowRunningInsecureContent, false);
  });
});

describe('content security policy', () => {
  const production = buildContentSecurityPolicy({
    isDevelopment: false,
    tileOrigins: TILES,
    updateOrigins: UPDATES,
  });

  test('production permits no remote scripts', () => {
    assert.match(production, /script-src 'self'(;|$)/);
    assert.ok(!production.includes("script-src 'self' http"));
    assert.ok(!/script-src[^;]*unsafe-eval/.test(production));
    assert.ok(!/script-src[^;]*unsafe-inline/.test(production));
  });

  test('production permits no remote fonts or stylesheets', () => {
    assert.match(production, /font-src 'self' data:/);
    assert.ok(!/font-src[^;]*fonts\.googleapis/.test(production));
    assert.ok(!/style-src[^;]*http/.test(production));
  });

  test('objects, frames and form submission are forbidden', () => {
    for (const directive of [
      "object-src 'none'",
      "frame-src 'none'",
      "form-action 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ]) {
      assert.ok(production.includes(directive), `${directive} must be present`);
    }
  });

  test('tile and update hosts are the only remote destinations', () => {
    assert.ok(production.includes('img-src'));
    assert.ok(production.includes(TILES[0] as string));
    for (const origin of UPDATES) assert.ok(production.includes(origin));
    assert.ok(!production.includes('chargepoint'), 'the renderer never loads provider pages');
  });

  test('development exceptions are separate and never leak into production', () => {
    const development = buildContentSecurityPolicy({
      isDevelopment: true,
      tileOrigins: TILES,
      updateOrigins: UPDATES,
      devServerOrigin: 'http://localhost:5173',
    });
    assert.ok(development.includes('http://localhost:5173'));
    assert.ok(development.includes('ws://localhost:5173'));
    assert.ok(!production.includes('localhost'));
    assert.ok(
      !production.includes('unsafe-inline') || !/script-src[^;]*unsafe-inline/.test(production),
    );
  });
});

describe('the trusted origin built from the renderer path', () => {
  /**
   * These exist because the rest of this file tested the CONSUMER of the app
   * origin against a hand-written constant, and nothing tested the PRODUCER.
   * The producer was wrong on Windows, and the consequence was total: every
   * IPC message from the application's own window was rejected and a packaged
   * build could not start.
   */

  test('a Windows path yields the three-slash form Electron reports', () => {
    const origin = rendererFileOrigin(
      'C:\\Users\\someone\\AppData\\Local\\Programs\\chargewatch\\resources\\app.asar\\out\\renderer\\index.html',
    );
    assert.equal(
      origin,
      'file:///C:/Users/someone/AppData/Local/Programs/chargewatch/resources/app.asar/out/renderer/',
    );
    // The precise regression: two slashes instead of three.
    assert.ok(!origin.startsWith('file://C:'), 'a drive letter must not follow only two slashes');
  });

  test('a POSIX path keeps the form it already had', () => {
    assert.equal(
      rendererFileOrigin('/opt/chargewatch/resources/app.asar/out/renderer/index.html'),
      'file:///opt/chargewatch/resources/app.asar/out/renderer/',
    );
  });

  test('the sender URL Electron reports for a packaged Windows build is trusted', () => {
    const origin = rendererFileOrigin(
      'C:\\Users\\someone\\AppData\\Local\\Programs\\chargewatch\\resources\\app.asar\\out\\renderer\\index.html',
    );
    const verdict = isTrustedSender({
      senderUrl:
        'file:///C:/Users/someone/AppData/Local/Programs/chargewatch/resources/app.asar/out/renderer/index.html',
      appOrigins: [origin],
      knownWindowIds: [1],
      senderWindowId: 1,
      isMainFrame: true,
    });
    assert.equal(verdict.reason, null);
    assert.equal(verdict.trusted, true);
  });

  test('a path with a space encodes the way Electron encodes it', () => {
    assert.equal(
      rendererFileOrigin(
        'C:\\Program Files\\ChargeWatch\\resources\\app.asar\\out\\renderer\\index.html',
      ),
      'file:///C:/Program%20Files/ChargeWatch/resources/app.asar/out/renderer/',
    );
  });

  test('a sibling directory sharing a name prefix is not trusted', () => {
    const origin = rendererFileOrigin('/opt/app/out/renderer/index.html');
    const verdict = isTrustedSender({
      senderUrl: 'file:///opt/app/out/renderer-evil/index.html',
      appOrigins: [origin],
      knownWindowIds: [1],
      senderWindowId: 1,
      isMainFrame: true,
    });
    assert.equal(verdict.trusted, false);
  });
});

describe('navigation policy', () => {
  const inputs = {
    appOrigins: APP_ORIGINS,
    externalOrigins: ['https://driver.chargepoint.com', 'https://www.openstreetmap.org'],
  };

  test("the application's own document is allowed", () => {
    assert.equal(decideNavigation(`${APP_ORIGINS[0]}index.html`, inputs).action, 'allow');
  });

  test('an allowed external link opens in the system browser, not in-window', () => {
    const decision = decideNavigation('https://driver.chargepoint.com/stations/1', inputs);
    assert.equal(decision.action, 'open_externally');
  });

  test('javascript, data and blob navigation are never permitted', () => {
    for (const hostile of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'blob:https://example.com/abc',
    ]) {
      const decision = decideNavigation(hostile, inputs);
      assert.equal(decision.action, 'deny', `${hostile} must be denied`);
    }
  });

  test('an unexpected host or scheme is denied', () => {
    for (const hostile of [
      'https://evil.example/',
      'http://localhost:9222/json',
      'file:///C:/Users/Calvin/Documents/secrets.txt',
      'ftp://example.com/',
      'chrome://settings',
      'not a url',
    ]) {
      assert.equal(decideNavigation(hostile, inputs).action, 'deny', `${hostile} must be denied`);
    }
  });

  test('a look-alike host is not mistaken for an allowed one', () => {
    assert.equal(
      decideNavigation('https://driver.chargepoint.com.evil.example/stations/1', inputs).action,
      'deny',
    );
  });
});

describe('permissions', () => {
  test('every permission is denied, so no prompt ever appears', () => {
    for (const permission of [
      'geolocation',
      'notifications',
      'media',
      'midi',
      'clipboard-read',
      'display-capture',
      'openExternal',
      'fullscreen',
    ]) {
      const decision = decidePermission(permission);
      assert.equal(decision.granted, false, `${permission} must be denied`);
      assert.match(decision.reason, /does not use/);
    }
  });
});

describe('IPC sender validation', () => {
  const base = {
    appOrigins: APP_ORIGINS,
    knownWindowIds: [1, 2],
    senderWindowId: 1,
    isMainFrame: true,
  };

  test('a message from our own main frame is trusted', () => {
    const result = isTrustedSender({ ...base, senderUrl: `${APP_ORIGINS[0]}index.html` });
    assert.equal(result.trusted, true);
  });

  test('a message from a subframe is refused', () => {
    const result = isTrustedSender({
      ...base,
      isMainFrame: false,
      senderUrl: `${APP_ORIGINS[0]}index.html`,
    });
    assert.equal(result.trusted, false);
    assert.match(result.reason ?? '', /subframe/);
  });

  test('a message from an unknown window is refused', () => {
    const result = isTrustedSender({
      ...base,
      senderWindowId: 99,
      senderUrl: `${APP_ORIGINS[0]}index.html`,
    });
    assert.equal(result.trusted, false);
    assert.match(result.reason ?? '', /unrecognised window/);
  });

  test('a message from a provider page is refused', () => {
    const result = isTrustedSender({
      ...base,
      senderUrl: 'https://driver.chargepoint.com/stations/1',
    });
    assert.equal(result.trusted, false);
    assert.match(result.reason ?? '', /not the application/);
  });
});

describe('data directory placement', () => {
  const windowsInputs = {
    localAppDataDir: 'C:\\Users\\Calvin Robison\\AppData\\Local',
    installDir: 'C:\\Users\\Calvin Robison\\AppData\\Local\\Programs\\chargewatch',
    platform: 'win32' as NodeJS.Platform,
  };

  test('history lives under local app data, outside the install directory', () => {
    const { paths, warnings } = resolveDataPaths(windowsInputs);
    assert.ok(paths.root.includes(DATA_DIRECTORY_NAME));
    assert.ok(paths.databaseFile.endsWith('history.sqlite'));
    assert.equal(
      warnings.some((w) => w.code === 'inside_install_dir'),
      false,
      'the default placement is outside the install directory',
    );
  });

  test('a data directory inside the install directory is flagged', () => {
    const { warnings } = resolveDataPaths({
      localAppDataDir: 'C:\\Program Files\\ChargeWatch\\resources',
      installDir: 'C:\\Program Files\\ChargeWatch',
      platform: 'win32',
    });
    assert.ok(warnings.some((w) => w.code === 'inside_install_dir'));
  });

  test('a cloud-roaming directory is flagged as a corruption risk', () => {
    for (const dir of [
      'C:\\Users\\Calvin\\OneDrive\\AppData',
      'C:\\Users\\Calvin\\AppData\\Roaming',
      'C:\\Users\\Calvin\\Dropbox',
    ]) {
      const { warnings } = resolveDataPaths({
        localAppDataDir: dir,
        installDir: null,
        platform: 'win32',
      });
      assert.ok(
        warnings.some((w) => w.code === 'cloud_roaming_directory'),
        `${dir} should be flagged`,
      );
    }
  });

  test('collection data, profiles, backups, logs and the update cache are separate', () => {
    const { paths } = resolveDataPaths(windowsInputs);
    const dirs = [
      paths.databaseDir,
      paths.browserProfilesDir,
      paths.backupsDir,
      paths.logsDir,
      paths.updateCacheDir,
      paths.diagnosticsDir,
      paths.stagingDir,
    ];
    assert.equal(new Set(dirs).size, dirs.length, 'every subdirectory is distinct');
  });

  test('the directory name is a constant so rebranding cannot strand data', () => {
    assert.equal(DATA_DIRECTORY_NAME, 'ChargeWatch');
  });

  test('diagnostics exclude the database, backups, profiles and update cache', () => {
    for (const excluded of ['browserProfilesDir', 'updateCacheDir', 'databaseDir', 'backupsDir']) {
      assert.ok(
        DIAGNOSTIC_EXCLUDED_DIRS.includes(excluded as (typeof DIAGNOSTIC_EXCLUDED_DIRS)[number]),
        `${excluded} must be excluded`,
      );
    }
  });
});

describe('write destinations', () => {
  const { paths } = resolveDataPaths({
    localAppDataDir: 'C:\\Users\\Calvin\\AppData\\Local',
    installDir: 'C:\\Program Files\\ChargeWatch',
    platform: 'win32',
  });

  test('an ordinary user destination is permitted', () => {
    const result = isPermittedWriteDestination(
      'C:\\Users\\Calvin\\Documents\\chargewatch-export.csv',
      paths,
      'C:\\Program Files\\ChargeWatch',
    );
    assert.equal(result.permitted, true);
  });

  test('writing into the live history directory is refused', () => {
    const result = isPermittedWriteDestination(
      `${paths.databaseDir}\\history.sqlite`,
      paths,
      'C:\\Program Files\\ChargeWatch',
    );
    assert.equal(result.permitted, false);
    assert.match(result.reason ?? '', /live history/);
  });

  test('writing into the install directory or profile directory is refused', () => {
    for (const destination of [
      'C:\\Program Files\\ChargeWatch\\ChargeWatch.exe',
      `${paths.browserProfilesDir}\\chargepoint\\Cookies`,
      `${paths.updateCacheDir}\\installer.exe`,
    ]) {
      const result = isPermittedWriteDestination(
        destination,
        paths,
        'C:\\Program Files\\ChargeWatch',
      );
      assert.equal(result.permitted, false, `${destination} must be refused`);
    }
  });
});

describe('diagnostic redaction', () => {
  test('tokens, cookies and authorization headers are removed', () => {
    const redacted = redactDiagnosticText(
      [
        'Authorization: Bearer abc123def456',
        'Cookie: session=deadbeef; other=1',
        'api_key=sk-live-1234567890',
        'token: ghp_abcdefghijklmnopqrst',
        'contact driver@example.com',
      ].join('\n'),
      null,
    );
    for (const secret of [
      'abc123def456',
      'deadbeef',
      'sk-live-1234567890',
      'ghp_abcdefghijklmnopqrst',
      'driver@example.com',
    ]) {
      assert.ok(!redacted.includes(secret), `${secret} must not survive redaction`);
    }
    assert.ok(redacted.includes('[redacted]'));
  });

  test('the user home path is replaced', () => {
    const redacted = redactDiagnosticText(
      'failed to open C:\\Users\\Calvin Robison\\AppData\\Local\\ChargeWatch\\db\\history.sqlite',
      'C:\\Users\\Calvin Robison',
    );
    assert.ok(!redacted.includes('Calvin Robison'));
    assert.ok(redacted.includes('<user home>'));
  });

  test('a forward-slash spelling of the home path is also replaced', () => {
    const redacted = redactDiagnosticText(
      'path C:/Users/Calvin Robison/AppData/Local/ChargeWatch',
      'C:\\Users\\Calvin Robison',
    );
    assert.ok(!redacted.includes('Calvin Robison'));
  });

  test('ordinary log text is preserved', () => {
    const text = 'collector: 13 bindings due, effective interval 15m, source healthy';
    assert.equal(redactDiagnosticText(text, null), text);
  });
});

describe('documented outbound connections', () => {
  test('every outbound connection is documented with a purpose', () => {
    assert.ok(DOCUMENTED_OUTBOUND_CONNECTIONS.length >= 3);
    for (const entry of DOCUMENTED_OUTBOUND_CONNECTIONS) {
      assert.ok(entry.purpose.length > 5);
      assert.ok(entry.origins.length > 0);
      for (const origin of entry.origins) assert.match(origin, /^https:\/\//);
    }
  });

  test('there is no analytics or crash-reporting destination', () => {
    const all = DOCUMENTED_OUTBOUND_CONNECTIONS.flatMap((e) => e.origins).join(' ');
    for (const forbidden of [
      'sentry',
      'analytics',
      'telemetry',
      'segment',
      'mixpanel',
      'datadog',
    ]) {
      assert.ok(!all.toLowerCase().includes(forbidden), `${forbidden} must not be contacted`);
    }
  });
});
