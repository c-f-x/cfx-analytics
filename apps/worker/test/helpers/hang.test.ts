import { expect, it } from "vitest";
import { withinHang } from "./hang.ts";

// query-09's fixture of two million events is seeded in batches, each within
// a hang deadline, so a busy machine slows the seeding but never fails it.

it("query-09 · a batch that answers passes its answer through", async () => {
  await expect(withinHang(Promise.resolve(7), "batch 1 of the fixture")).resolves.toBe(7);
});

it("query-09 · a batch that makes no progress fails, naming the batch", async () => {
  const never = new Promise<number>(() => undefined);
  await expect(withinHang(never, "batch 3 of the fixture", 10)).rejects.toThrow(
    "batch 3 of the fixture made no progress in 0.01 s",
  );
});
