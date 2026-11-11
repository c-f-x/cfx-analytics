import { readFileSync } from "node:fs";
import { parse } from "jsonc-parser";

export const WRANGLER_CONFIG = new URL("../../apps/worker/wrangler.jsonc", import.meta.url);

/** The Worker's wrangler config as an object. A syntax error is a failure, not a guess. */
export function readWranglerConfig(url = WRANGLER_CONFIG) {
  const errors = [];
  const config = parse(readFileSync(url, "utf8"), errors, { allowTrailingComma: true });
  if (errors.length > 0)
    throw new Error(`${url.pathname} does not parse: ${JSON.stringify(errors)}`);
  return config;
}

/** The top-level block and each deployment block under "env", each with its name. */
export function configBlocks(config) {
  return [
    ["top level", config],
    ...Object.entries(config.env ?? {}).map(([n, b]) => [`env.${n}`, b]),
  ];
}
