/**
 * Global UI state.
 *
 * Filters, date range, search and selection are GLOBAL, not per-workspace:
 * changing a filter on Overview must be reflected on the Map and vice versa.
 * That is why they live here rather than inside either workspace.
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useReducer,
  type Dispatch,
  type ReactNode,
} from 'react';

import type { DatePreset, RankSort } from '../../domain/ranking.ts';
import type { FilterState, WindowRequest } from '../../shared/ipc.ts';

export type Workspace = 'map' | 'overview';
export type MapMetric = 'occupancy' | 'current' | 'coverage' | 'visits';
export type DetailChartMode = 'occupancy' | 'hours' | 'coverage';

/** Default: collapse the rail the instant a station is selected. */
export type CollapseMode = 'auto' | 'manual' | 'wide';

export interface UiState {
  readonly tab: Workspace;
  readonly selectedId: string | null;
  readonly metric: MapMetric;
  readonly filters: FilterState;
  readonly sort: RankSort;
  readonly datePreset: DatePreset;
  readonly customStartMs: number | null;
  readonly customEndMs: number | null;
  /** null = follow `collapseMode`; set by the manual chevron. */
  readonly railOverride: boolean | null;
  readonly collapseMode: CollapseMode;
  readonly legendOpen: boolean;
  readonly sourceOpen: boolean;
  /** Session-scoped: dismissing the banner does not persist. */
  readonly warnDismissed: boolean;
  readonly studyCircle: boolean;
  readonly settingsOpen: boolean;
  readonly detailChartMode: DetailChartMode;
}

export const INITIAL_UI_STATE: UiState = {
  tab: 'map',
  selectedId: null,
  metric: 'occupancy',
  filters: {
    query: '',
    chargingTypes: [],
    networks: [],
    monitoringStates: [],
    savedOnly: false,
    cohort: 'dc_fast',
  },
  sort: 'occupancy',
  datePreset: '30d',
  customStartMs: null,
  customEndMs: null,
  railOverride: null,
  collapseMode: 'auto',
  legendOpen: true,
  sourceOpen: false,
  warnDismissed: false,
  studyCircle: true,
  settingsOpen: false,
  detailChartMode: 'occupancy',
};

export type UiAction =
  | { type: 'setTab'; tab: Workspace }
  | { type: 'selectStation'; id: string | null }
  | { type: 'selectStationAndShowMap'; id: string }
  | { type: 'setMetric'; metric: MapMetric }
  | { type: 'setQuery'; query: string }
  | { type: 'toggleSavedOnly' }
  | { type: 'setCohort'; cohort: FilterState['cohort'] }
  | { type: 'setChargingTypes'; types: FilterState['chargingTypes'] }
  | { type: 'setNetworks'; networks: readonly string[] }
  | { type: 'setMonitoringStates'; states: FilterState['monitoringStates'] }
  | { type: 'clearFilters' }
  | { type: 'setSort'; sort: RankSort }
  | { type: 'setDatePreset'; preset: DatePreset; startMs?: number; endMs?: number }
  | { type: 'setRailOverride'; open: boolean | null }
  | { type: 'setCollapseMode'; mode: CollapseMode }
  | { type: 'toggleLegend' }
  | { type: 'toggleSourceDisclosure' }
  | { type: 'dismissWarning' }
  | { type: 'toggleStudyCircle' }
  | { type: 'setSettingsOpen'; open: boolean }
  | { type: 'setDetailChartMode'; mode: DetailChartMode };

export function uiReducer(state: UiState, action: UiAction): UiState {
  switch (action.type) {
    case 'setTab':
      return { ...state, tab: action.tab };

    case 'selectStation':
      return {
        ...state,
        selectedId: action.id,
        // Clearing the selection returns the rail to expanded, and re-opens
        // the disclosure state fresh for the next station.
        railOverride: action.id === null ? null : state.railOverride,
        sourceOpen: action.id === null ? false : state.sourceOpen,
      };

    case 'selectStationAndShowMap':
      // Clicking an Overview row switches to the Map with that station selected.
      return { ...state, tab: 'map', selectedId: action.id, railOverride: null };

    case 'setMetric':
      return { ...state, metric: action.metric };

    case 'setQuery':
      return { ...state, filters: { ...state.filters, query: action.query } };

    case 'toggleSavedOnly':
      return { ...state, filters: { ...state.filters, savedOnly: !state.filters.savedOnly } };

    case 'setCohort':
      return { ...state, filters: { ...state.filters, cohort: action.cohort } };

    case 'setChargingTypes':
      return { ...state, filters: { ...state.filters, chargingTypes: action.types } };

    case 'setNetworks':
      return { ...state, filters: { ...state.filters, networks: [...action.networks] } };

    case 'setMonitoringStates':
      return { ...state, filters: { ...state.filters, monitoringStates: action.states } };

    case 'clearFilters':
      return { ...state, filters: { ...INITIAL_UI_STATE.filters, cohort: state.filters.cohort } };

    case 'setSort':
      return { ...state, sort: action.sort };

    case 'setDatePreset':
      return {
        ...state,
        datePreset: action.preset,
        customStartMs: action.startMs ?? null,
        customEndMs: action.endMs ?? null,
      };

    case 'setRailOverride':
      return { ...state, railOverride: action.open };

    case 'setCollapseMode':
      return { ...state, collapseMode: action.mode };

    case 'toggleLegend':
      return { ...state, legendOpen: !state.legendOpen };

    case 'toggleSourceDisclosure':
      return { ...state, sourceOpen: !state.sourceOpen };

    case 'dismissWarning':
      return { ...state, warnDismissed: true };

    case 'toggleStudyCircle':
      return { ...state, studyCircle: !state.studyCircle };

    case 'setSettingsOpen':
      return { ...state, settingsOpen: action.open };

    case 'setDetailChartMode':
      return { ...state, detailChartMode: action.mode };

    default: {
      const exhaustive: never = action;
      throw new Error(`unhandled UI action: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** Whether the station rail is expanded, given the collapse policy. */
export function isRailExpanded(state: UiState): boolean {
  if (state.collapseMode === 'wide') return true;
  if (state.railOverride !== null) return state.railOverride;
  if (state.collapseMode === 'manual') return true;
  // `auto`: collapse the instant a station is selected.
  return state.selectedId === null;
}

/** Builds the window request the workers expect from the UI's date selection. */
export function windowRequestOf(state: UiState): WindowRequest {
  if (state.datePreset === 'custom' && state.customStartMs !== null && state.customEndMs !== null) {
    return {
      preset: 'custom',
      customStartMs: state.customStartMs,
      customEndMs: state.customEndMs,
    };
  }
  // A custom range with no bounds falls back to the default rather than
  // sending an invalid request the contract would reject.
  return { preset: state.datePreset === 'custom' ? '30d' : state.datePreset };
}

export const DATE_PRESET_LABELS: Record<DatePreset, string> = {
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '60d': 'Last 60 days',
  all: 'All collected history',
  custom: 'Custom range',
};

interface UiContextValue {
  readonly state: UiState;
  readonly dispatch: Dispatch<UiAction>;
}

const UiContext = createContext<UiContextValue | null>(null);

export function UiProvider({ children }: { readonly children: ReactNode }): ReactNode {
  const [state, dispatch] = useReducer(uiReducer, INITIAL_UI_STATE);
  const value = useMemo(() => ({ state, dispatch }), [state]);
  return <UiContext.Provider value={value}>{children}</UiContext.Provider>;
}

export function useUi(): UiContextValue {
  const context = useContext(UiContext);
  if (!context) throw new Error('useUi must be used inside a UiProvider');
  return context;
}

/** Convenience hook for the common "select a station" interaction. */
export function useSelectStation(): (id: string | null) => void {
  const { dispatch } = useUi();
  return useCallback(
    (id: string | null) => {
      dispatch({ type: 'selectStation', id });
    },
    [dispatch],
  );
}
