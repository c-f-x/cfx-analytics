// What query offers: its routes, runProjectQuery for scheduled work, and
// runCompiled, which the ProjectStore calls.
export { mountQuery, type RunFailure, runProjectQuery } from "./http.ts";
export { runCompiled } from "./store.ts";
export type { CompiledQuery, RunError, StoreRows } from "./types.ts";
