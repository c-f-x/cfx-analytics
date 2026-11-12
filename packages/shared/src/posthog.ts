// The posthog-js version this deployment is built for (D-15). The Worker
// serves this version's lazy scripts, and the dashboard tells a new product
// to install it. scripts/posthog-scripts.mjs refreshes the scripts.

/** The one posthog-js version whose lazy scripts we serve (D-15). Upgraded together with the consumers. */
export const POSTHOG_JS_VERSION = "1.438.12";
