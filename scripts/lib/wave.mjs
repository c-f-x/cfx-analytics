import path from "node:path";
import { unbuiltViolations } from "./architecture.mjs";
import { ROOT } from "./source.mjs";

// The rules a DeepSeek worker's change keeps (decision D-17, docs/build-worker.md).
// Each function takes values, so a test can feed it a sample.

/** Changes outside the worker's own files, and own files that still call unbuilt(). */
export function waveViolations({ changed, own, ownSources }) {
  const mine = new Set(own);
  const found = changed.filter((p) => !mine.has(p)).map((p) => `${p} is not yours to change`);
  return [...found, ...unbuiltViolations(ownSources)];
}

/**
 * Tokens a Claude Code transcript spent, from its JSONL lines. The transcript
 * repeats an answer's usage on every line of that answer, so each message id
 * counts once.
 */
export function usageOf(lines) {
  const seen = new Set();
  const sum = { calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  for (const line of lines) {
    if (line.trim() === "") continue;
    const message = JSON.parse(line).message;
    if (!message?.usage || seen.has(message.id)) continue;
    seen.add(message.id);
    sum.calls += 1;
    sum.input += message.usage.input_tokens ?? 0;
    sum.cacheRead += message.usage.cache_read_input_tokens ?? 0;
    sum.cacheWrite += message.usage.cache_creation_input_tokens ?? 0;
    sum.output += message.usage.output_tokens ?? 0;
  }
  return sum;
}

/**
 * The balances in DeepSeek's /user/balance answer, as "6.75 USD", or null when
 * the answer has another shape.
 * @param {unknown} body
 * @returns {string[] | null}
 */
export function balancesOf(body) {
  const infos =
    body && typeof body === "object" && "balance_infos" in body ? body.balance_infos : null;
  if (!Array.isArray(infos)) return null;
  const out = [];
  for (const info of infos) {
    if (typeof info?.total_balance !== "string" || typeof info?.currency !== "string") return null;
    out.push(`${info.total_balance} ${info.currency}`);
  }
  return out;
}

export const repoPath = (file) => path.relative(ROOT, path.resolve(ROOT, file));

const BEHAVIOUR_LINE = /^- `([a-z]+-\d{2,})`/;

/** The spec's behaviour IDs, kept and rejected apart. A "### Rejected" heading starts a slice's rejected list. */
export function behaviourIds(markdown) {
  const kept = new Set();
  const rejected = new Set();
  let inRejected = false;
  for (const line of markdown.split("\n")) {
    if (line.startsWith("## ")) inRejected = false;
    if (line.startsWith("### Rejected")) inRejected = true;
    const id = BEHAVIOUR_LINE.exec(line)?.[1];
    if (id !== undefined) (inRejected ? rejected : kept).add(id);
  }
  return { kept, rejected };
}

const TEST_ID = /^([a-z]+-\d{2,})\b/;
const firstLine = (text) => text.split("\n")[0].trim();

/**
 * A test round's verdict from vitest's JSON report (decision D-21): every test
 * names a kept behaviour, and every failing test fails on an unbuilt marker.
 * Tests that pass are listed apart, for the audit to read.
 */
export function redVerdict(report, ids) {
  const violations = [];
  const passed = [];
  let count = 0;
  for (const file of report.testResults ?? []) {
    const where = path.relative(ROOT, file.name);
    const results = file.assertionResults ?? [];
    if (results.length === 0 && file.status === "failed") {
      violations.push(`${where} did not load: ${firstLine(file.message ?? "")}`);
      continue;
    }
    for (const result of results) {
      count += 1;
      const id = TEST_ID.exec(result.title)?.[1];
      const named = `${where}: "${result.title}"`;
      if (id === undefined) violations.push(`${named} names no behaviour ID`);
      else if (ids.rejected.has(id)) violations.push(`${named} proves rejected behaviour ${id}`);
      else if (!ids.kept.has(id)) violations.push(`${named} names unknown behaviour ${id}`);
      if (result.status === "passed") passed.push(result.title);
      if (result.status !== "failed") continue;
      const messages = result.failureMessages ?? [];
      if (!messages.some((message) => message.includes("unbuilt: "))) {
        violations.push(
          `${named} fails on something other than a marker: ${firstLine(messages[0] ?? "no message")}`,
        );
      }
    }
  }
  if (count === 0 && violations.length === 0) violations.push("no tests ran");
  return { violations, passed };
}

/**
 * The files a test round owns: a named file as given, and for a folder every
 * `.test.ts` file under it among `all` (repo paths). The outline names the
 * test files, so a plan's gate names the slice's folder instead.
 */
export function testFilesUnder(entries, all) {
  const out = [];
  for (const entry of entries) {
    if (/\.[a-z]+$/.test(entry)) {
      out.push(entry);
      continue;
    }
    const prefix = `${entry.replace(/\/$/, "")}/`;
    out.push(
      ...all.filter((file) => file.startsWith(prefix) && file.endsWith(".test.ts")).toSorted(),
    );
  }
  return out;
}
