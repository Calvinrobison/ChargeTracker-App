/**
 * The display-layer honesty rules, checked in a real browser.
 *
 * These assert the thing that the domain and database specs cannot: that what
 * the user is actually SHOWN distinguishes a measured zero from an absent
 * measurement, reports a partial window as partial, and does not describe
 * inferred activity as a recorded charging session.
 *
 * 42 of these have been executed: all 42 pass against the built renderer in
 * Chromium, across the three projects in playwright.config.ts. The five at the
 * end of this file, covering the stall filters and the disputed-capacity
 * marking, have NOT been run and are labelled where they start. The first run
 * needed the selector corrections its author expected — a locator that matched
 * a hidden <select> option, an assertion that the basemap tiles are not
 * requested on the opening view, and a second installBridge that tried to
 * redefine the frozen bridge — each fixed in the spec or the stub, not by
 * relaxing what is asserted. They have not run under Electron; that is what
 * the scripts under scripts/windows/ are for.
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

    const zeroBackground = await measuredZero.evaluate(
      (node) => getComputedStyle(node).backgroundColor,
    );
    const gapBackground = await unwatched.evaluate(
      (node) => getComputedStyle(node).backgroundColor,
    );
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
    // Scoped to the section heading rather than the first match for
    // "Provisional": the filter <select> has an option of that name, and an
    // <option> is never visible, so the loose locator resolved to the dropdown
    // and failed on an app that was rendering the section correctly.
    await expect(page.getByText('Provisional locations')).toBeVisible();
    // "with its reasons" is the half of the test name that matters.
    await expect(page.getByText('not enough history or coverage in this period')).toBeVisible();
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
    // The basemap tile origin, and only this one. It is declared in
    // src/main/security.ts, allowed by the CSP, and recorded in
    // THIRD_PARTY_NOTICES.md. The map is the tab the app opens on, so its tiles
    // are requested before this test navigates away — asserting zero external
    // requests here failed on the app behaving exactly as documented.
    const TILE_ORIGIN = 'https://tile.openstreetmap.org/';

    const external: string[] = [];
    page.on('request', (request) => {
      const url = request.url();
      if (
        !url.startsWith('http://127.0.0.1') &&
        !url.startsWith('data:') &&
        !url.startsWith('blob:') &&
        !url.startsWith(TILE_ORIGIN)
      ) {
        external.push(url);
      }
    });

    await page.goto('/');
    await page.getByRole('tab', { name: 'Overview' }).click();
    await expect(page.getByText('Observed occupancy')).toBeVisible();

    // No CDN for code or fonts, and no provider page. This is the check that
    // catches a stylesheet, font or script that quietly moved off the machine.
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

test.describe('monitoring is a stated switch, not an implied state', () => {
  test('a catalog-only location says it has no source page and offers a link box', async ({
    page,
  }) => {
    await page.goto('/');
    await page
      .getByRole('listbox', { name: 'Stations' })
      .getByRole('option')
      .filter({ hasText: 'Fixture Hotel Garage' })
      .click();

    const drawer = page.locator('.drawer, .station-drawer').first();
    await expect(drawer).toContainText('Not linked to a source page');
    await expect(drawer).toContainText('No source page linked');
    // The link button stays disabled until the box holds a single station page.
    const link = drawer.getByRole('button', { name: 'Link', exact: true });
    await expect(link).toBeDisabled();
    await drawer
      .getByRole('textbox', { name: 'ChargePoint station page link' })
      .fill('https://driver.chargepoint.com/stations/11502161');
    await expect(link).toBeEnabled();
    // Nothing that looks like a live count appears for a location nobody reads.
    await expect(drawer.getByRole('switch', { name: 'Monitor this location' })).toHaveCount(0);
  });

  test('a monitored location shows its switch on and names the cadence', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('listbox', { name: 'Stations' })
      .getByRole('option')
      .filter({ hasText: 'Fixture Mall North' })
      .click();

    const drawer = page.locator('.drawer, .station-drawer').first();
    const toggle = drawer.getByRole('switch', { name: 'Monitor this location' });
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect(drawer).toContainText('every 15 minutes');
    await expect(drawer).toContainText('Monitoring on');
  });
});

/**
 * The five specs below have NOT been executed. Playwright cannot run in the
 * environment they were written in, and the repository's own record is that
 * every UI spec written against the source rather than against a running page
 * needed correcting on its first run. Treat them as unverified until
 * `npm run test:e2e` has been run on Windows; if a selector is wrong, correct
 * the selector, not the assertion.
 */

test.describe('a capacity the sources disagree about is marked, not resolved', () => {
  test('the row says which two numbers disagree, in words', async ({ page }) => {
    await page.goto('/');

    // Fixture Airport Deck: the source reported 12 stalls, the catalog lists 6.
    const row = page
      .getByRole('listbox', { name: 'Stations' })
      .getByRole('option')
      .filter({ hasText: 'Fixture Airport Deck' });

    await expect(row).toBeVisible();
    // The marking must survive with colour removed, which is the whole reason
    // both figures are in the badge text rather than only in a blue edge.
    await expect(row).toContainText('Stalls disputed');
    await expect(row).toContainText('12');
    await expect(row).toContainText('6');
  });

  test('a location the sources agree about carries no marking', async ({ page }) => {
    await page.goto('/');

    const row = page
      .getByRole('listbox', { name: 'Stations' })
      .getByRole('option')
      .filter({ hasText: 'Fixture Mall North' });

    await expect(row).toBeVisible();
    await expect(row).not.toContainText('Stalls disputed');
  });

  test('the drawer states both figures and which one is being used', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('listbox', { name: 'Stations' })
      .getByRole('option')
      .filter({ hasText: 'Fixture Airport Deck' })
      .click();

    const drawer = page.locator('.drawer, .station-drawer').first();
    await expect(drawer).toContainText('Stalls disputed');
    await expect(drawer).toContainText('the source reports 12');
    await expect(drawer).toContainText('the catalog lists 6');
    // Which figure is used, and why — not merely that the two differ.
    await expect(drawer).toContainText('use the source figure');
  });
});

test.describe('the availability filter does not claim to cover the map', () => {
  test('it names how many locations can answer it', async ({ page }) => {
    await page.goto('/');

    const rail = page.getByRole('complementary', { name: 'Stations' });
    await expect(rail).toContainText('Stalls free right now');
    await expect(rail).toContainText('monitored location');
    await expect(rail).toContainText('rather than counted as none free');
  });

  test('its boxes start empty, which means no bound rather than zero', async ({ page }) => {
    await page.goto('/');

    // A zero here would be a filter for "no free stalls", which is a claim.
    // An empty box is the absence of one.
    const rail = page.getByRole('complementary', { name: 'Stations' });
    for (const box of await rail.getByRole('spinbutton').all()) {
      await expect(box).toHaveValue('');
    }
  });
});
