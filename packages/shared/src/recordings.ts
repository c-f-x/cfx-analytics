// What the dashboard's recording list answers, shared by the Worker that
// builds it and the dashboard that shows it.

/** One recording as the dashboard's list shows it (recordings-05, recordings-29). */
export interface RecordingSummary {
  sessionId: string;
  distinctId: string | null;
  /** The person the recording's distinct id belongs to when the list is read, so a later $identify counts (recordings-29). */
  personId: number | null;
  /** The earliest firstTs and the latest lastTs of its chunks. */
  startTs: number;
  endTs: number;
  /** endTs - startTs. */
  durationMs: number;
  /** The sum of its chunks' activeMs. */
  activeMs: number;
  /** firstUrl of the chunk with the earliest firstTs that has one. */
  firstUrl: string | null;
  clicks: number;
  keypresses: number;
  /** Gzip bytes written to R2 for it (recordings-30). */
  bytes: number;
  /** The distinct page keys its session's events visited, in order of first visit (recordings-35). */
  pages: string[];
}
