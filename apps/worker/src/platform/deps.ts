import { createLogger, type Logger } from "./log.ts";

// What the composition root builds once per request and passes down
// (docs/engineering.md, "Pure core, I/O at the edge"). Tests pass their own.

/** Milliseconds since the epoch. */
export type Clock = () => number;

/** `n` random bytes. */
export type RandomBytes = (n: number) => Uint8Array;

export interface Deps {
  now: Clock;
  random: RandomBytes;
  log: Logger;
  /** The outside world: Cloudflare's OAuth token and user endpoints (D-27), and nothing of ours. */
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
}

/** The real clock, random source and logger. Only the composition root and the ProjectStore call this. */
export function realDeps(): Deps {
  return {
    now: () => Date.now(),
    random: (n) => crypto.getRandomValues(new Uint8Array(n)),
    log: createLogger((line) => console.log(line)),
    fetch: (input, init) => fetch(input, init),
  };
}
