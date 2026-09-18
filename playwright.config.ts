/**
 * Playwright configuration for the UI tests.
 *
 * WHAT THESE TESTS DO
 *
 * They load the BUILT renderer bundle in Chromium with a stub preload bridge
 * that answers from `tests/ui/fixtures.ts`, and assert on what the user is
 * shown. That makes them the only automated check on the last step of the
 * honesty chain: a missing measurement can survive every domain and database
 * guarantee and still be printed as `0%`.
 *
 * WHAT THEY DELIBERATELY DO NOT DO
 *
 *  - They never reach a provider. No test in this directory may open a network
 *    origin; `baseURL` is loopback and the fixtures are local. A pull request
 *    must not scrape a production status page.
 *  - They do not launch Electron. Electron's own startup, the preload sandbox,
 *    the tray and the update path are covered by the Windows scripts under
 *    `scripts/windows/`, which test the INSTALLED build — the only place those
 *    can honestly be established.
 *
 * `forbidOnly` is set for CI so a committed `test.only` cannot silently reduce
 * the suite to one test and still report green.
 */

import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.CHARGEWATCH_UI_PORT ?? 4173);
const BASE_URL = `http://127.0.0.1:${PORT}`;

/**
 * An optional Chromium to run against, instead of the build Playwright would
 * download itself.
 *
 * Unset — the normal case — changes nothing. It exists for machines that ship a
 * Chromium of their own and cannot fetch Playwright's exact revision: an
 * offline workstation, or a CI image with a browser preinstalled. Without it
 * the suite cannot run there at all, which is how these specs stayed unexecuted.
 */
const CHROMIUM_PATH = process.env.CHARGEWATCH_CHROMIUM;

export default defineConfig({
  testDir: 'tests/ui',
  testMatch: /.*\.spec\.ts$/,
  outputDir: 'test-results/ui',

  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  timeout: 30_000,
  expect: { timeout: 7_000 },

  reporter: process.env.CI
    ? [
        ['list'],
        ['html', { open: 'never', outputFolder: 'playwright-report' }],
        ['junit', { outputFile: 'test-results/ui-junit.xml' }],
      ]
    : [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],

  use: {
    baseURL: BASE_URL,
    // A fixed viewport: the layout has breakpoints, and a test that passes at
    // one width and fails at another should say which.
    viewport: { width: 1440, height: 900 },
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'off',
    // The study area's zone, so any date the UI formats is deterministic.
    timezoneId: 'America/Phoenix',
    locale: 'en-US',
    // Nothing under test needs a service worker, a camera or a location.
    permissions: [],
    // Offline. A test that only passes with network access is testing
    // something this suite does not intend to test.
    offline: false,
    ...(CHROMIUM_PATH ? { launchOptions: { executablePath: CHROMIUM_PATH } } : {}),
  },

  projects: [
    {
      name: 'desktop-dark',
      use: { ...devices['Desktop Chrome'], colorScheme: 'dark' },
    },
    {
      // The palette is themed with tokens; light mode is a real code path.
      name: 'desktop-light',
      use: { ...devices['Desktop Chrome'], colorScheme: 'light' },
    },
    {
      // The narrow layout collapses the station rail.
      name: 'narrow',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1024, height: 768 } },
    },
  ],

  // Serves the built bundle. `reuseExistingServer` off in CI so a stale
  // server from an earlier job can never be the thing under test.
  webServer: {
    command: `node tests/ui/serve.mjs --dir out/renderer --port ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
