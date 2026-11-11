// One way to split a list into runs: a statement's rows within the bound
// parameter limit, an R2 call's keys within its key limit. Pure.

/** `items` in order, in runs of at most `size`; none is empty. */
export function runsOf<T>(items: readonly T[], size: number): T[][] {
  const runs: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    runs.push(items.slice(start, start + size));
  }
  return runs;
}
