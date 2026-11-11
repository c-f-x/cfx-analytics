// Every limit and default the Worker and the dashboard share, in one place
// (docs/engineering.md, "One home per rule"). The decision behind each is named.

/** Intake body limits, measured decoded (intake-05, intake-26; posthog-protocol.md §11 item 12). */
export const BODY_LIMITS = {
  eventBytes: 20 * 1024 * 1024,
  recordingBytes: 25 * 1024 * 1024,
} as const;

/** Per-field clipping at intake, in UTF-8 bytes (intake-04). Values are cut, never refused. */
export const CLIP = {
  eventName: 200,
  propertyName: 200,
  stringValue: 8 * 1024,
  url: 2048,
  /** Properties beyond this many keys on one event are dropped, the first ones kept. */
  propertiesPerEvent: 1000,
  /** JSON nesting below this depth is cut off. */
  depth: 10,
} as const;

/** A distinct id longer than this drops its event (D-20, intake-29). */
export const DISTINCT_ID_MAX = 200;

/** Spike S1 measured about 530 bytes an event with its indexes (D-20). */
export const BYTES_PER_EVENT = 530;

/** A ProjectStore takes no more writes at this size (D-20, events-12). One object holds 10 GB. */
export const STORE_GUARD_BYTES = 9 * 1000 * 1000 * 1000;

/** Cookieless sessions end after this long without an event (cookieless-06). */
export const SESSION_GAP_MS = 30 * 60 * 1000;

/** Registry answers are cached this long (D-4, projects-10). */
export const REGISTRY_CACHE_MS = 60 * 1000;

/** A purge starts this long after its project was marked deleted (D-20, privacy-20). */
export const PURGE_DELAY_MS = 60 * 1000;

/** An orphan R2 object younger than this is left alone (recordings-06). */
export const ORPHAN_GRACE_MS = 60 * 60 * 1000;

/** Orphan R2 objects one sweep pass deletes; more are left for the next pass (recordings-06). */
export const ORPHAN_SWEEP_KEYS = 2_500;

/** R2 deletes one call to bucket.delete may name, as Cloudflare documents. */
export const R2_DELETE_KEYS_MAX = 1_000;

/** One day in milliseconds: a time unit every slice uses, defined once. */
export const DAY_MS = 24 * 60 * 60 * 1000;

/** The most parameters a ProjectStore statement may bind, as Cloudflare's SQLite allows. */
export const BOUND_PARAMETERS_MAX = 100;

/** Query limits (D-18, D-20). */
export const QUERY = {
  /** Rows a dashboard query may read on a fixture of spike S1's size (query-09). */
  rowsReadBudget: 5_000_000,
  maxBuckets: 512,
  funnelSteps: { min: 2, max: 10 },
  breakdownLimit: { default: 10, max: 50 },
  topLimit: { default: 10, max: 100 },
  eventsLimit: { default: 50, max: 500 },
  filterDepth: 8,
  filterValues: 100,
  bodyBytes: 100 * 1024,
  searchBytes: 50,
  boundParameters: BOUND_PARAMETERS_MAX,
  sqlBytes: 100 * 1024,
  /** The newest events of the range the property catalogue reads (query-51, D-26). */
  propertiesEvents: 10_000,
} as const;

/** Rows an export reads at a time (privacy-25). */
export const EXPORT_PAGE_ROWS = 10_000;

/** The most lines one import request carries (privacy-30), and the most bytes its body may hold. */
export const IMPORT_LINES_MAX = 500;
export const IMPORT_BODY_BYTES = 8 * 1024 * 1024;

/** Rows one sweep pass deletes from one table before it hands over to the next alarm (privacy-27). */
export const SWEEP_BATCH_ROWS = 10_000;

/** Heatmap width bands are this many pixels wide (data-model.md, heatmap_points). */
export const WIDTH_BAND_PX = 100;

/** Recordings one page of the dashboard's list holds. */
export const RECORDINGS_LIST = { default: 50, max: 100 } as const;
