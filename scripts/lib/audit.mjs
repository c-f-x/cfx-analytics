// The verdict block a pleach auditor relays (decision D-23). pleach parses the
// last fenced tend-audit-result block of the auditor's reply as an
// AuditResult, so the audit command prints one.

const TAIL_LINES = 20;

/** The fenced block for `check`'s exit code, with the output's last lines as reasons when it failed. */
export function auditBlock(check, exitCode, output) {
  const reasons = [`exit code ${exitCode}`];
  if (exitCode !== 0) {
    reasons.push(...output.trimEnd().split("\n").slice(-TAIL_LINES));
  }
  const result = {
    verdicts: [{ check, verdict: exitCode === 0 ? "pass" : "fail", reasons }],
  };
  // JSON.stringify keeps each reason on one quoted line, so no line of the
  // body can begin with a fence.
  return ["```tend-audit-result", JSON.stringify(result, null, 2), "```"].join("\n");
}
