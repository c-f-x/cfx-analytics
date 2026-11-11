// What identity offers: resolving an event's person inside the write
// transaction, the pure rules it rests on, and deleting, pruning and
// exporting people, which the ProjectStore's sweep and privacy calls use.
export {
  applyPersonOps,
  type IdSide,
  type LinkPlan,
  linkPlan,
  mergeStates,
  type PersonState,
  type PropertyTimes,
} from "./core.ts";
export {
  DISTINCT_IDS_SHAPE,
  erasePerson,
  exportDistinctIds,
  exportPersons,
  PERSONS_SHAPE,
  type PersonChange,
  personWithIds,
  prunePersons,
  type ResolveInput,
  removeMergedPerson,
  resolvePerson,
} from "./store.ts";
