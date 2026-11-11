import type { Condition, QuerySpec, TileSpec } from "@cfanalytics/shared";
import { DEFAULT_PERIOD, type Period, type PeriodId, periodOf } from "./period.ts";

// The board's state, kept in the address so a board can be linked and the
// back button undoes a filter, and the one rule that turns a saved tile and
// that state into the query the API takes. Pure.

/** One filter chip: a property of the event equal to a value. */
export interface FilterChip {
  property: string;
  value: string;
}

export interface BoardState {
  period: PeriodId;
  /** Trends show the period before beside this one. */
  compare: boolean;
  /** Bots and the owner's own traffic put back into every tile. */
  include: boolean;
  filters: FilterChip[];
}

export const DEFAULT_BOARD: BoardState = {
  period: DEFAULT_PERIOD,
  compare: true,
  include: false,
  filters: [],
};

function isChip(value: unknown): value is FilterChip {
  return (
    typeof value === "object" &&
    value !== null &&
    "property" in value &&
    "value" in value &&
    typeof value.property === "string" &&
    typeof value.value === "string"
  );
}

/** The board's state as a link may give it: any part, the rest taking the default. */
export type BoardSearch = Partial<BoardState>;

/** The board's state read from the address's search values; anything not understood is the default. */
export function boardFrom(search: Record<string, unknown>): BoardState {
  const filters = Array.isArray(search.filters) ? search.filters.filter(isChip).slice(0, 20) : [];
  return {
    period: periodOf(search.period).id,
    compare: search.compare !== false && search.compare !== "false",
    include: search.include === true || search.include === "true",
    filters,
  };
}

/** The filter chips as one filter of the API's shape, or none. */
function filterOf(chips: readonly FilterChip[]): QuerySpec["filter"] {
  if (chips.length === 0) return undefined;
  const conditions: Condition[] = chips.map((chip) => ({
    op: "eq",
    property: { of: "event", name: chip.property },
    value: chip.value,
  }));
  return conditions.length === 1 ? conditions[0] : { all: conditions };
}

/**
 * The query a tile asks under the board: the board's period, its filters
 * and its include switch; a trend in the period's bucket size, compared with
 * the period before only when both the tile and the board ask for it.
 */
export function querySpecOf(
  tile: TileSpec,
  board: BoardState,
  period: Period = periodOf(board.period),
): QuerySpec {
  const filter = filterOf(board.filters);
  const shared = {
    range: period.range,
    ...(filter === undefined ? {} : { filter }),
    ...(board.include ? { includeBots: true, includeInternal: true } : {}),
  };
  if (tile.kind === "trend") {
    const { compare, ...rest } = tile;
    return {
      ...rest,
      ...shared,
      granularity: period.granularity,
      ...(compare === true && board.compare ? { compare: true } : {}),
    };
  }
  return { ...tile, ...shared };
}
