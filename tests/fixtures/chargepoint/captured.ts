/**
 * CAPTURED ChargePoint page readings. See README.md in this directory.
 *
 * Unlike readings.ts, these are not modelled: each one is the exact object the
 * adapter's extraction script returned when it was run against the live
 * station page in a browser on the date recorded, with `readAtUtcMs` taken
 * from the same run. They are structured readings, not raw page content, which
 * is what docs/SOURCE_VERIFICATION.md step 2 asks for.
 *
 * What they establish: that the extraction script finds the port blocks on the
 * real page, and that the parser turns what it found into the counts a person
 * reading the page would write down. What they do not establish: that the
 * page still has this shape today. A layout change shows up as a
 * `layout_changed` outcome in the source health panel, not as a wrong number.
 */

import type { PageReading } from '../../../src/collector/adapters/chargepoint/parse.ts';

export const CAPTURED = true as const;

/**
 * BANNER HEALTH / BAYWOOD 1, 6644 E Baywood Ave, Mesa. Two L2 J1772 outlets,
 * one Available and one In Use at the moment of capture. The page also showed
 * "Last Used · 2 days ago" as a station-level accordion.
 *
 * Captured 2026-09-21T10:39:58.629Z from https://driver.chargepoint.com/stations/11502161
 */
export const baywood1OneInUse: PageReading = {
  url: 'https://driver.chargepoint.com/stations/11502161',
  pageState: 'status_present',
  stationIdOnPage: '11502161',
  stationNameOnPage: 'BANNER HEALTH / BAYWOOD 1',
  summaryText: null,
  updatedText: null,
  portRows: [
    {
      label: 'Outlet 1',
      statusText: 'Available',
      statusCode: 'available',
      connectorText: '(J1772)',
      powerText: '6.6 kW',
      lastUsedText: null,
      durablePortId: '1',
    },
    {
      label: 'Outlet 2',
      statusText: 'In Use',
      statusCode: 'in_use',
      connectorText: '(J1772)',
      powerText: '6.6 kW',
      lastUsedText: null,
      durablePortId: '2',
    },
  ],
  statusBlocks: ['ChargePoint Network', 'Last Used 2 days ago'],
  readAtUtcMs: 1789987198629,
  documentLocale: 'en',
};

/**
 * CHAPMAN FORD / POWER LINK S, 3950 North 89th Street, Scottsdale. Two 120 kW
 * CCS1 outlets, both showing "Out of Service" with the provider code
 * `maintenance_required` behind the pill.
 *
 * Captured 2026-09-21T10:40:33.309Z from https://driver.chargepoint.com/stations/17560121
 */
export const chapmanFordBothOutOfService: PageReading = {
  url: 'https://driver.chargepoint.com/stations/17560121',
  pageState: 'status_present',
  stationIdOnPage: '17560121',
  stationNameOnPage: 'CHAPMAN FORD / POWER LINK S',
  summaryText: null,
  updatedText: null,
  portRows: [
    {
      label: 'Outlet 1',
      statusText: 'Out of Service',
      statusCode: 'maintenance_required',
      connectorText: '(CCS1)',
      powerText: '120 kW',
      lastUsedText: null,
      durablePortId: '1',
    },
    {
      label: 'Outlet 2',
      statusText: 'Out of Service',
      statusCode: 'maintenance_required',
      connectorText: '(CCS1)',
      powerText: '120 kW',
      lastUsedText: null,
      durablePortId: '2',
    },
  ],
  statusBlocks: ['ChargePoint Network'],
  readAtUtcMs: 1789987233309,
  documentLocale: 'en',
};

/**
 * CHARGEPOINT / SCD RTECH DC 1, 7350 N Dobson Rd, Scottsdale. One 62.5 kW
 * outlet whose plug line reads "(DC Fast)" rather than a connector name, with
 * the provider code `fault` behind an "Out of Service" pill.
 *
 * Read by hand 2026-09-21 from https://driver.chargepoint.com/stations/1804411;
 * the row values are what the extraction script's selectors returned for it.
 */
export const scdRtechFault: PageReading = {
  url: 'https://driver.chargepoint.com/stations/1804411',
  pageState: 'status_present',
  stationIdOnPage: '1804411',
  stationNameOnPage: 'CHARGEPOINT / SCD RTECH DC 1',
  summaryText: null,
  updatedText: null,
  portRows: [
    {
      label: 'Outlet 1',
      statusText: 'Out of Service',
      statusCode: 'fault',
      connectorText: '(DC Fast)',
      powerText: '62.5 kW',
      lastUsedText: null,
      durablePortId: '1',
    },
  ],
  statusBlocks: ['ChargePoint Network'],
  readAtUtcMs: 1789987100000,
  documentLocale: 'en',
};

/**
 * A station id the provider does not know. The dialog opens with "Failed to
 * load station details. Please try again later." and no port blocks.
 *
 * Captured 2026-09-21T10:40:56.210Z from https://driver.chargepoint.com/stations/999999999
 */
export const unknownStationError: PageReading = {
  url: 'https://driver.chargepoint.com/stations/999999999',
  pageState: 'source_error',
  stationIdOnPage: '999999999',
  stationNameOnPage: 'Station Details',
  summaryText: null,
  updatedText: null,
  portRows: [],
  statusBlocks: [],
  readAtUtcMs: 1789987256210,
  documentLocale: 'en',
};
