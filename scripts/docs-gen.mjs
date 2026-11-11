import { writeFileSync } from "node:fs";
import path from "node:path";
import { CHECKED_DOCS, readDoc, renderGenerated } from "./lib/docs.mjs";
import { ROOT } from "./lib/source.mjs";

// `pnpm docs:gen`: rewrites every generated block from the code.
let failed = false;
for (const doc of CHECKED_DOCS) {
  const before = readDoc(doc);
  const { text, unknown } = renderGenerated(before);
  if (unknown.length > 0) {
    console.error(`${doc}: no generator for ${unknown.join(", ")}`);
    failed = true;
  }
  if (text !== before) {
    writeFileSync(path.join(ROOT, doc), text);
    console.log(`updated ${doc}`);
  }
}
if (failed) process.exit(1);
