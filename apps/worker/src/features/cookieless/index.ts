// What cookieless offers: the hash, day and session rules, and its tables'
// functions, which the ProjectStore calls inside one transaction.
export {
  cookielessId,
  hashDay,
  nextSession,
  type SessionState,
  saltDay,
  saltExpiry,
  siphash24,
} from "./core.ts";
export { pruneSalts, type SaltError, saltForDay, sessionFor } from "./store.ts";
