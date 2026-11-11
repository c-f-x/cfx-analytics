import { readFileSync } from "node:fs";
import { balancesOf, usageOf } from "./lib/wave.mjs";

// `node scripts/wave-usage.mjs <transcript.jsonl>...`: the tokens a wave's
// workers spent, for the ledger in docs/reviews/build-ledger.md. With
// DEEPSEEK_API_KEY set it also prints the account balance. The key is read
// from the environment and never printed.
const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: node scripts/wave-usage.mjs <transcript.jsonl>...");
  process.exit(2);
}
for (const file of files) {
  console.log(JSON.stringify({ file, ...usageOf(readFileSync(file, "utf8").split("\n")) }));
}

const key = process.env.DEEPSEEK_API_KEY;
if (key) {
  const res = await fetch("https://api.deepseek.com/user/balance", {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) {
    console.error(`wave-usage: the balance request answered ${res.status}`);
    process.exit(1);
  }
  const balances = balancesOf(await res.json());
  if (balances === null) {
    console.error("wave-usage: the balance answer has an unknown shape");
    process.exit(1);
  }
  for (const b of balances) console.log(`balance: ${b}`);
}
