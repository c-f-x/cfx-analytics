import { defineConfig } from "vitest/config";

// Each package keeps its own vitest cache. pnpm -r test runs the packages at
// once, and two runs clearing one shared cache folder failed with ENOTEMPTY.
export default defineConfig({
  cacheDir: "node_modules/.vitest-cache",
});
