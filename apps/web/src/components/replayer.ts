import type { Replayer } from "rrweb";

// rrweb is most of the dashboard's weight, and only the screens that show a
// recording use it, so it loads when one of them opens.

export const loadReplayer = (): Promise<typeof Replayer> =>
  import("rrweb").then((module) => module.Replayer);
