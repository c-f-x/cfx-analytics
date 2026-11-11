import { spawn } from "node:child_process";

/** Runs one step as a child process with the terminal attached. Resolves to its exit code. */
export function spawnStep(step) {
  return new Promise((resolve) => {
    const child = spawn(step.command, step.args, { stdio: "inherit", shell: false });
    child.once("error", () => resolve(127));
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

/**
 * @typedef {{ name: string, command: string, args: string[] }} Step
 * @typedef {{ ok: true } | { ok: false, failed: { name: string, code: number }, skipped: string[] }} StepsResult
 */

/**
 * Runs steps in order and stops at the first that fails. Returns which step
 * failed, with its exit code, and which steps never ran. docs/engineering.md:
 * an operation stops at its first failing step.
 * @param {Step[]} steps
 * @returns {Promise<StepsResult>}
 */
export async function runSteps(steps, { run = spawnStep, log = console.log } = {}) {
  for (const [index, step] of steps.entries()) {
    log(`\n▶ ${step.name}`);
    // The steps run one after another on purpose: a later step must not start
    // when an earlier one failed.
    // oxlint-disable-next-line no-await-in-loop
    const code = await run(step);
    if (code !== 0) {
      const skipped = steps.slice(index + 1).map((s) => s.name);
      return { ok: false, failed: { name: step.name, code }, skipped };
    }
  }
  return { ok: true };
}
