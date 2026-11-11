// What projects offers other slices: resolving a token or a secret key, and the
// types of a resolved project.
export { bearerOf, isSecretKeyShape } from "./core.ts";
export { dashboardProject, mountProjects, sdkProject } from "./http.ts";
export {
  getProject,
  markDeleted,
  type ResolvedProject,
  removeProjectRows,
  resolveSecretKey,
  resolveToken,
  type StoreError,
} from "./store.ts";
