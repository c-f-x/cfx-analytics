// What each client tells the Worker about, in one home so a client and its
// checks agree. The project and its token are fresh each run (run.mjs).

export const PLAN = {
  node: {
    /** A capture sent before the identify, under the anonymous id. */
    event: "compat_node_event",
    /** The id the event first belongs to; $identify joins it to the user. */
    anonymousId: "compat-node-anon",
    user: "compat-node-user",
    email: "node@example.test",
    /** The id $create_alias joins to the user. */
    alias: "compat-node-alias",
  },
  browser: {
    /** The events a healthy posthog-js run leaves, by name. */
    events: ["$pageview", "$autocapture", "$pageleave"],
    /** The page the browser opens first, and the one it links to. */
    pagePath: "/normal.html",
    secondPath: "/second.html",
    cookielessPath: "/cookieless.html",
    /** What the client types into the masked input (recordings-02). */
    typedText: "compat-typed-secret-42",
    /** How far the headed visit scrolls before it follows the link (heatmaps-20). */
    scrollDepth: 2_000,
  },
  ios: {
    /** The $screen name the client reports. */
    screen: "compat_ios_screen",
    /** The capture sent before the identify, under the SDK-generated anonymous id. */
    event: "compat_ios_event",
    user: "compat-ios-user",
    email: "ios@example.test",
    /** The id $create_alias joins to the user. */
    alias: "compat-ios-alias",
  },
};
