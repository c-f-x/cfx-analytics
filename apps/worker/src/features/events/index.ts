// What events offers: the caps and the events table, which the ProjectStore
// uses inside its write transaction, and pruning by retention, deletion by
// person and export, which its sweep and privacy calls use.
export { capDay, counterKeepFrom, grant, storeIsFull } from "./core.ts";
export {
  claimEvents,
  EVENTS_SHAPE,
  type EventInsert,
  eraseEvents,
  exportEvents,
  type InsertError,
  insertEvents,
  pruneCounters,
  pruneEvents,
  reassignPerson,
  returnToCap,
  storedUuids,
  takeFromCap,
  takeWholeFromCap,
} from "./store.ts";
