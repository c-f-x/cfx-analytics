// Axis ticks that read as round numbers: 0, 50, 100, 150 rather than 0, 47, 94.
// Pure.

/** Up to about `count` round tick values from 0 to at least `max`. */
export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0, 1];
  const rough = max / count;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step =
    [1, 2, 2.5, 5, 10]
      .map((factor) => factor * magnitude)
      .find((candidate) => candidate >= rough) ?? 10 * magnitude;
  const ticks: number[] = [];
  for (let value = 0; value < max + step; value += step) ticks.push(Math.round(value * 1e6) / 1e6);
  return ticks;
}
