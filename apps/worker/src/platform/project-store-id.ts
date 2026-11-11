import type { Env } from "./env.ts";
import type { ProjectStore } from "./project-store.ts";

// The one place a ProjectStore is addressed (architecture.md, "Dependency
// rules"; scripts/architecture.test.mjs). Every ProjectStore lives in the eu
// jurisdiction. Local workerd refuses jurisdiction(), so local runs opt out
// with the binding LOCAL_UNSCOPED_PROJECT_STORES = "1" and nothing else
// (D-19). A deployment never has that binding: wrangler.jsonc declares no vars.

/** True only for the string "1" (platform-16). */
export function isLocalUnscoped(value: unknown): boolean {
  return value === "1";
}

/** The object's name: the project id alone, so one project is one object (platform-17). */
export function projectStoreName(projectId: string): string {
  return `project:${projectId}`;
}

/** The stub of a project's ProjectStore. */
export function projectStore(env: Env, projectId: string): DurableObjectStub<ProjectStore> {
  const namespace = isLocalUnscoped(env.LOCAL_UNSCOPED_PROJECT_STORES)
    ? env.PROJECT_STORE
    : env.PROJECT_STORE.jurisdiction("eu");
  return namespace.get(namespace.idFromName(projectStoreName(projectId)));
}
