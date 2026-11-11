// A select's text read back as its own type, checked against the options it
// offered. Pure.

/** `value` when it is one of `options`, else undefined. */
export function oneOf<T extends string>(options: readonly T[], value: string): T | undefined {
  return options.find((option) => option === value);
}
