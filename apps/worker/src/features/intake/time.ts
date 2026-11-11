import { wholeNumber } from "@cfanalytics/shared";

// An event's time from what the SDK sent (posthog-protocol.md §1.5; intake-14,
// intake-33 to intake-37).

/** 23 hours: the furthest after receipt an event's own time may sit (intake-36). */
const MAX_AHEAD_MS = 23 * 60 * 60 * 1000;

/** A time with a date, a clock and an offset or Z. A bare date or a local time is refused (intake-33). */
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i;

/** A string of digits, which posthog-js puts in the query as epoch milliseconds (intake-34). */
const DIGITS = /^\d+$/;

/**
 * The stored time in ms. A time parses when it is an ISO-8601 string with a
 * time zone, as the SDKs send it, or epoch milliseconds as a finite number or
 * a string of digits, as posthog-js puts sent_at in a query; anything else
 * counts as absent (intake-34).
 * - A parseable `timestamp` and `sentAt`: timestamp - (sentAt - receivedAt)
 *   (intake-14), unless `ignoreSentAt`, when it is the timestamp (intake-35).
 * - Only a parseable timestamp: the timestamp (intake-33).
 * - Otherwise: receivedAt (intake-33).
 * A result more than 23 hours after receivedAt becomes receivedAt
 * (intake-36). receivedAt is the Worker's clock, never a request field
 * (intake-37). Pure.
 */
export function eventTime(input: {
  timestamp: unknown;
  sentAt: unknown;
  receivedAt: number;
  ignoreSentAt: boolean;
}): number {
  const timestamp = parseTime(input.timestamp);
  if (timestamp === null) return input.receivedAt;
  const sentAt = input.ignoreSentAt ? null : parseTime(input.sentAt);
  // Whole milliseconds: events.ts is a STRICT INTEGER column (intake-34).
  const time = Math.round(sentAt === null ? timestamp : timestamp - (sentAt - input.receivedAt));
  return time - input.receivedAt > MAX_AHEAD_MS ? input.receivedAt : time;
}

/**
 * How far the client's clock ran ahead of the Worker's when it sent a body:
 * sentAt - receivedAt in whole ms, read as eventTime reads sent_at, or 0 when
 * sentAt does not parse or is absent, as on posthog-ios's /s/ bodies
 * (posthog-protocol.md §1.5, §10.5). A recording's rrweb times are corrected
 * by it (recordings-19, recordings-28). Pure.
 */
export function clockSkew(sentAt: unknown, receivedAt: number): number {
  const sent = parseTime(sentAt);
  return sent === null ? 0 : Math.round(sent - receivedAt);
}

/** Epoch ms for a value the SDKs send, or null when it is not a time. */
function parseTime(value: unknown): number | null {
  if (typeof value === "number") return wholeNumber(value);
  if (typeof value !== "string") return null;
  if (DIGITS.test(value)) return wholeNumber(Number(value));
  if (!ISO_WITH_ZONE.test(value)) return null;
  const milliseconds = Date.parse(value);
  return Number.isNaN(milliseconds) ? null : milliseconds;
}
