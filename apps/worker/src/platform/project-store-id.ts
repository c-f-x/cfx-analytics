import type { Env } from "./env.ts";
import type { ProjectStore } from "./project-store.ts";
import { err, ok, type Result } from "./result.ts";

// The one place a ProjectStore is addressed (architecture.md, "Dependency
// rules"; scripts/architecture.test.mjs). Where the stores live is the
// installation's choice (cfx-kit D-11, D-38): the deploy sets
// STORE_JURISDICTION from the site file's jurisdiction. With it unset, as in
// local runs and in installations that leave the field out, the stores take
// Cloudflare's default placement. Nothing writes a region into the code.

/** The region STORE_JURISDICTION names, or an error for a value that is no region (platform-52, platform-53). */
export function storeJurisdiction(value: unknown): Result<"eu" | undefined> {
  if (value === undefined) return ok(undefined);
  if (value === "eu") return ok(value);
  return err(`STORE_JURISDICTION is ${JSON.stringify(value)}, which is no region`);
}

/** The object's name: the project id alone, so one project is one object (platform-17). */
export function projectStoreName(projectId: string): string {
  return `project:${projectId}`;
}

/**
 * The stub of a project's ProjectStore. The Worker refuses every request while
 * STORE_JURISDICTION is no region (platform-53), so this sees "eu" or nothing.
 */
export function projectStore(env: Env, projectId: string): DurableObjectStub<ProjectStore> {
  const region = env.STORE_JURISDICTION;
  const namespace =
    region === undefined ? env.PROJECT_STORE : env.PROJECT_STORE.jurisdiction(region);
  return namespace.get(namespace.idFromName(projectStoreName(projectId)));
}
