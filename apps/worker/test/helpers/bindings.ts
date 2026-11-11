import { env } from "cloudflare:test";

// Bindings a test swaps in to prove what a path never touches.

/** A binding that fails the request, and so the test, the moment anything reads it. */
export function poisoned<T extends object>(binding: T, name: string): T {
  return new Proxy(binding, {
    get() {
      throw new Error(`the request touched ${name}`);
    },
  });
}

/** The Worker's bindings with every ProjectStore out of reach: a request that contacts one fails. */
export const withoutStores = (): Cloudflare.Env => ({
  ...env,
  PROJECT_STORE: poisoned(env.PROJECT_STORE, "PROJECT_STORE"),
});
