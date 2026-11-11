// What intake offers other slices: the capture routes, the event shape the
// ProjectStore stores, the ids it makes, and the body decoding and normalising
// that /s/ and /flags share (recordings, config), and the retention horizon
// a query clips its range to (query).
export { COOKIELESS_SENTINEL, type IncomingEvent, quotaKey, retentionStart } from "./core.ts";
export { type DecodeError, decodeBody, type Encoding, sentLimit } from "./decode.ts";
export { CAPTURE_PATHS, mountCapture } from "./http.ts";
export { type Normalized, normalizeBody, type RawEvent } from "./normalize.ts";
export { clockSkew, eventTime } from "./time.ts";
export { isUuid, uuidV7 } from "./uuid.ts";
