// Every package of the workspace carries the root's version, so a release
// tag names one version of the whole repository (oss-prep, "Versioning").
// Pure: callers read the manifests and pass them in.

/**
 * Each package whose version differs from the root's.
 * @param {string} rootVersion
 * @param {{ file: string, version: unknown }[]} packages
 * @returns {string[]}
 */
export function versionViolations(rootVersion, packages) {
  return packages
    .filter(({ version }) => version !== rootVersion)
    .map(({ file, version }) => `${file} is at ${String(version)}, the root at ${rootVersion}`);
}
