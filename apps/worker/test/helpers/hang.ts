// A deadline that catches a hang, never slowness (engineering.md, "Tests hold
// on a busy machine"). Long work that keeps moving is cut into calls, and each
// call gets this deadline, so the work as a whole has none.

/** How long one call may go without answering before it counts as hung. */
export const HANG_MS = 120_000;

/** The answer of `work`, or a failure naming `what` when it has not answered within `ms`. */
export async function withinHang<T>(work: Promise<T>, what: string, ms = HANG_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${what} made no progress in ${String(ms / 1000)} s`));
    }, ms);
  });
  try {
    return await Promise.race([work, hung]);
  } finally {
    clearTimeout(timer);
  }
}
