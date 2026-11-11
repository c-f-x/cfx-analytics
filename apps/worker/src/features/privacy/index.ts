// What privacy offers: the lifetimes' cutoffs and the sweep's order and log
// line, which the ProjectStore's alarm follows (sweep.ts), the deletion plan,
// and its routes.
export {
  type Cutoffs,
  cutoffsOf,
  deletePlan,
  type EraseOutcome,
  eraseAnswer,
  type PlanStep,
  RECORDINGS_LIFECYCLE,
  SWEEP_ORDER,
  type SweepStep,
  sweepSummary,
} from "./core.ts";
export { mountPrivacy } from "./http.ts";
