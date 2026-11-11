import { z } from "zod";
import { DISTINCT_ID_MAX } from "./limits.ts";

// What the dashboard and the export command send to the privacy routes, and
// the shapes of their answers (D-9, D-20; privacy-02 to privacy-05,
// privacy-17 to privacy-25).

/** The body of a deletion by person. The distinct id travels in the body, never the URL (privacy-18). */
export const eraseRequest = z.strictObject({
  distinctId: z.string().min(1).max(DISTINCT_ID_MAX),
});
export type EraseRequest = z.infer<typeof eraseRequest>;

/** The tables a deletion by person counts, and the R2 objects it deleted. */
export const ERASED = [
  "events",
  "persons",
  "person_distinct_ids",
  "recordings",
  "recording_chunks",
  "heatmap_points",
  "objects",
] as const;
export type Erased = (typeof ERASED)[number];

/** Rows deleted per table, zeros included, so an unknown id answers all zeros (privacy-02, privacy-17). */
export type ErasedCounts = Record<Erased, number>;

/**
 * The tables an export reads, one NDJSON file each (privacy-22). Salts and
 * cookieless sessions are left out, since they would let cookieless ids be
 * recomputed; counters hold nothing about people.
 */
export const EXPORT_TABLES = [
  "events",
  "persons",
  "person_distinct_ids",
  "recordings",
  "recording_chunks",
  "heatmap_points",
] as const;
export type ExportTable = (typeof EXPORT_TABLES)[number];

/** The order a restore imports the tables in: a row's person and recording before the rows that name them (privacy-30). */
export const IMPORT_ORDER: readonly ExportTable[] = [
  "persons",
  "person_distinct_ids",
  "events",
  "recordings",
  "recording_chunks",
  "heatmap_points",
];

/** One page of an export: NDJSON lines, and the cursor of the next page, or null on the last (privacy-25). */
export interface ExportPage {
  lines: string[];
  /** The rowid of the page's last row, passed back as `after`; null when no row is left. */
  next: number | null;
}

/** The answer of a purge request: when the store's alarm starts the purge (privacy-20). */
export interface PurgeAnswer {
  /** ISO UTC: the delete mark plus PURGE_DELAY_MS. */
  purgeAt: string;
}
