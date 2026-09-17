/**
 * SYNTHETIC ChargePoint page readings. See README.md in this directory.
 *
 * These model page shapes. They are not captured provider content and are not
 * evidence that the live source can be collected from.
 */

import type { PageReading, PortRowReading } from '../../../src/collector/adapters/chargepoint/parse.ts';

export const SYNTHETIC = true as const;

/** 2026-09-17T07:42:00Z, a fixed instant so fixtures are deterministic. */
export const READ_AT = Date.UTC(2026, 8, 17, 7, 42, 0, 0);

const BASE: PageReading = {
  url: 'https://driver.chargepoint.com/stations/11502081',
  pageState: 'status_present',
  stationIdOnPage: '11502081',
  stationNameOnPage: 'SYNTHETIC HEALTH / BAYWOOD 2',
  summaryText: null,
  updatedText: null,
  portRows: [],
  statusBlocks: [],
  readAtUtcMs: READ_AT,
  documentLocale: 'en-US',
};

function row(overrides: Partial<PortRowReading> = {}): PortRowReading {
  return {
    label: 'Port 1',
    statusText: 'Available',
    connectorText: 'J1772',
    powerText: '6.6 kW',
    lastUsedText: null,
    durablePortId: null,
    ...overrides,
  };
}

export function reading(overrides: Partial<PageReading> = {}): PageReading {
  return { ...BASE, ...overrides };
}

/**
 * Models the shape the brief's spot check described: two J1772 port entries
 * with no durable port identifiers.
 */
export const twoPortJ1772 = reading({
  summaryText: '1 of 2 ports available',
  updatedText: 'Updated 9 minutes ago',
  portRows: [
    row({ label: 'Port 1', statusText: 'Available' }),
    row({ label: 'Port 2', statusText: 'In use' }),
  ],
  statusBlocks: ['Public station', '24 hours'],
});

/** Same site, but the provider exposes stable per-port identifiers. */
export const twoPortWithDurableIds = reading({
  portRows: [
    row({ label: 'Port 1', statusText: 'Available', durablePortId: 'CP-11502081-1' }),
    row({ label: 'Port 2', statusText: 'Charging', durablePortId: 'CP-11502081-2' }),
  ],
});

/** A DC fast site with one port out of service. */
export const dcFastWithOutage = reading({
  stationIdOnPage: '20001',
  stationNameOnPage: 'SYNTHETIC RIVERVIEW DC',
  portRows: [
    row({ label: 'Port 1', statusText: 'Available', connectorText: 'CCS', powerText: '62.5 kW' }),
    row({ label: 'Port 2', statusText: 'In use', connectorText: 'CCS', powerText: '62.5 kW' }),
    row({ label: 'Port 3', statusText: 'Out of service', connectorText: 'CHAdeMO', powerText: '50 kW' }),
  ],
});

/** Only an aggregate availability summary rendered; no per-port rows. */
export const aggregateOnly = reading({
  summaryText: '2 of 6 ports available',
  portRows: [],
});

/** An unrecognised status word must become unknown, not available. */
export const unrecognisedStatus = reading({
  portRows: [
    row({ label: 'Port 1', statusText: 'Estado desconocido' }),
    row({ label: 'Port 2', statusText: 'Available' }),
  ],
  documentLocale: 'es-MX',
});

/** The page lists alternative connectors on one unit, not two ports. */
export const connectorsNotPorts = reading({
  portRows: [
    row({ label: 'Connector 1', statusText: 'Available', connectorText: 'CCS' }),
    row({ label: 'Connector 2', statusText: 'Available', connectorText: 'CHAdeMO' }),
  ],
});

/** "Last used" text is present and must not be counted as anything. */
export const withLastUsed = reading({
  portRows: [
    row({ label: 'Port 1', statusText: 'Available', lastUsedText: 'Last used 3 hours ago' }),
    row({ label: 'Port 2', statusText: 'In use', lastUsedText: 'Last used 12 minutes ago' }),
  ],
});

/** A redirect landed us on a different station. */
export const identityMismatch = reading({
  stationIdOnPage: '99999',
  portRows: [row({ statusText: 'Available' })],
});

/** The status region rendered but has no recognisable status content. */
export const layoutChanged = reading({
  summaryText: null,
  portRows: [],
  statusBlocks: ['Find stations near you', 'Get the app'],
});

export const stillLoading = reading({ pageState: 'loading', portRows: [] });
export const noResults = reading({ pageState: 'no_results', portRows: [] });
export const sourceError = reading({ pageState: 'source_error', portRows: [] });
export const emptyStatus = reading({ pageState: 'empty_status', portRows: [] });
export const loginRequired = reading({ pageState: 'login_required', portRows: [] });
export const challenge = reading({ pageState: 'challenge', portRows: [] });
