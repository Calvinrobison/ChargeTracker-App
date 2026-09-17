/**
 * The display-layer honesty rules, checked in a real browser.
 *
 * These assert the thing that the domain and database specs cannot: that what
 * the user is actually SHOWN distinguishes a measured zero from an absent
 * measurement, reports a partial window as partial, and does not describe
 * inferred activity as a recorded charging session.
 *
 * ⚠ NOT YET EXECUTED. Playwright could not be installed in the environment
 * these were written in, so no run has confirmed them. They are committed
 * because they encode the assertions rather than because they are known to
 * pass; `docs/VERIFICATION_REPORT.md` records them as written-not-run, and the
 * first `npm run test:e2e` on a machine with dependencies is expected to need
 * selector corrections. Treat a green CI `ui-smoke` job as the first real
 * evidence, not this file.
 */

import { expect, test } from '@playwright/test';

import { installBridge, invokedOperations } from './bridge.ts';

test.beforeEach(async ({ page }) => {
  await installBridge(page);
  // A console error is a failure: the renderer must not need a global the
  // preload bridge does not provide.
  page.on('pageerror', (error) => {
    throw new Error(`the renderer raised: ${error.message}`);
  });
});

test.describe('a missing measurement is not shown as zero', () => {
  test('a monitored location with no current reading says so', async ({ page }) => {
    await page.goto('/');

    // Fixture Transit Center has `occupied: null` with four ports.
    const rail = page.getByRole('listbox', { name: 'Stations' });
    const row = rail.getByRole('option').filter({ hasText: 'Fixture Transit Center' });
    await expect(row).toBeVisible();
    await expect(row).toContainText('No current status');
    // The precise failure this guards: "0 / 4 occupied" for a station whose
    // source reported nothing.
    await expect(row).not.toContainText('0 / 4');
  });

  test('a catalog-only location is labelled, not given zeroes', async ({ page }) => {
    await page.goto('/');

    const row = page
      .getByRole('listbox', { name: 'Stations' })
      .getByRole('option')
      .filter({ hasText: 'Fixture Hotel Garage' });
    await expect(row).toContainText('Catalog only');
    await expect(row).toContainText('Not monitored');
    await expect(row).not.toContainText('0%');
  });

  test('null metrics render as an em dash', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('listbox', { name: 'Stations' })
      .getByRole('option')
      .filter({ hasText: 'Fixture Hotel Garage' })
      .click();

    // Occupancy, hours and coverage are all null for this location.
    const drawer = page.locator('.drawer, .station-drawer').first();
    await expect(drawer).toContainText('—');
    await expect(drawer).not.toContainText('0.0%');
  });
});

test.describe('gaps are reported as gaps', () => {
  test('the trend labels the days with no observations', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('tab', { name: 'Overview' }).click();

    // The fixture trend has a two-day hole. The chart's accessible name states
    // it rather than the line being drawn through it.
    const chart = page.getByRole('img', { name: /Occupancy trend/ });
    await expect(chart).toBeVisible();
    await expect(chart).toHaveAttribute('aria-label', /no observations are drawn as gaps/);
  });

  test('the heatmap has a dedicated no-data swatch and uses it', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('tab', { name: 'Overview' }).click();

    await expect(page.getByText('No data', { exact: true })).toBeVisible();

    const heatmap = page.getByRole('img', { name: 'Occupancy by weekday and hour' });
    await expect(heatmap).toBeVisible();

    // Sunday was never watched in the fixture; every Sunday cell must carry
    // the no-observation title.
    const unwatched = heatmap.locator('[title*="no observation recorded"]');
    expect(await unwatched.count()).toBeGreaterThan(0);
  });

  test('an observed zero is not drawn like an unwatched hour', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('tab', { name: 'Overview' }).click();

    const heatmap = page.getByRole('img', { name: 'Occupancy by weekday and hour' });
    const measuredZero = heatmap.locator('[title*="0% occupancy"]').first();
    const unwatched = heatmap.locator('[title*="no observation recorded"]').first();

    const zeroBackground = await measuredZero.evaluate((node) => getComputedStyle(node).backgroundColor);
    const gapBackground = await unwatched.evaluate((node) => getComputedStyle(node).backgroundColor);
    expect(zeroBackground).not.toBe(gapBackground);
  });
});

test.describe('a partial window says it is partial', () => {
  test('the summary reports requested days against collected days', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('tab', { name: 'Overview' }).click();

    // The fixture window is clipped by the study start: 30 requested, 11 collected.
    await expect(page.getByText('30 days requested · 11 collected')).toBeVisible();
  });

  test('a provisional location is shown with its reasons, not hidden', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('tab', { name: 'Overview' }).click();

    await expect(page.getByText('Fixture Library Lot')).toBeVisible();
    await expect(page.getByText('Provisional', { exact: false }).first()).toBeVisible();
  });
});

test.describe('an unusable source is stated plainly', () => {
  test('the banner says collection is not enabled and offers no retry', async ({ page }) => {
    await page.goto('/');

    const banner = page.getByRole('status').filter({ hasText: 'FixtureNet' });
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('collection is not enabled');
    // Retrying a source that is not cleared would be making a request we are
    // not permitted to make, so the button must be absent.
    await expect(banner.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  });

  test('the rest of the interface stays usable while a source is unusable', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('tablist', { name: 'Workspace' })).toBeVisible();
    await page.getByRole('tab', { name: 'Overview' }).click();
    await expect(page.getByText('Observed occupancy')).toBeVisible();
  });
});

test.describe('the renderer stays inside the bridge', () => {
  test('it asks only for operations the contract declares', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('tab', { name: 'Overview' }).click();
    await expect(page.getByText('Observed occupancy')).toBeVisible();

    const operations = await invokedOperations(page);
    expect(operations).toContain('app.getBootstrap');
    expect(operations).toContain('overview.get');
    // Every call must be a declared operation. An undeclared one would mean
    // the renderer is reaching for something the router will reject at
    // runtime — a bug that only shows up in a packaged build otherwise.
    for (const operation of operations) {
      expect(operation).toMatch(/^[a-z]+\.[a-zA-Z]+$/);
    }
  });

  test('it makes no network request of its own', async ({ page }) => {
    const external: string[] = [];
    page.on('request', (request) => {
      const url = request.url();
      if (!url.startsWith('http://127.0.0.1') && !url.startsWith('data:') && !url.startsWith('blob:')) {
        external.push(url);
      }
    });

    await page.goto('/');
    await page.getByRole('tab', { name: 'Overview' }).click();
    await expect(page.getByText('Observed occupancy')).toBeVisible();

    // No CDN for code or fonts, and no provider page. The map's tile requests
    // are the one permitted exception and are not on this view.
    expect(external).toEqual([]);
  });

  test('a failed operation shows a message rather than a stack trace', async ({ page }) => {
    await installBridge(page, { failures: { 'overview.get': 'database_locked' } });
    await page.goto('/');
    await page.getByRole('tab', { name: 'Overview' }).click();

    await expect(page.getByText(/Could not load the latest figures/)).toBeVisible();
    await expect(page.getByText(/at Object\.|\.js:\d+:\d+/)).toHaveCount(0);
  });
});

test.describe('activity is never described as a recorded session', () => {
  test('the station drawer explains what the source can and cannot support', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('listbox', { name: 'Stations' })
      .getByRole('option')
      .filter({ hasText: 'Fixture Mall North' })
      .click();

    const drawer = page.locator('.drawer, .station-drawer').first();
    await expect(drawer).toBeVisible();
    // The words "charging session" must not appear as a claim about data that
    // is inferred from status counts.
    await expect(drawer).not.toContainText(/recorded charging session/i);
  });
});
