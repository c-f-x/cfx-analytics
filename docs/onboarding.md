# Connecting a product

How to start sending a website's or a server's events to a cfx-analytics deployment, and how to see that they arrive. Each step names what goes wrong if it is skipped. `<dashboard host>` is your deployment's dashboard address, and `e.<your domain>` is a product's own intake host.

## 1. Make the product

In the dashboard, open Products and choose New product. The dialog shows the install line for the pinned posthog-js version, and a snippet with the product's token. The token is public by design: it only lets a page send events, and the daily limits in Settings bound what it can send.

A new product records nothing but events. Session recording and heatmaps start off. The dialog links to the product's Settings, where you turn them on under "What is collected" if you want playback or click maps.

## 2. Choose where it sends

Send to the product's own intake host, `e.<your domain>` (D-16, D-31). Blocklists often catch hosts named "analytics", and the product's own domain stays with it if the dashboard moves.

1. The domain's zone must be in the deployment's Cloudflare account.
2. Add `"e.<your domain>"` to `worker.intake_hosts` in your site file (`docs/operations.md`, "The site file").
3. Run `pnpm ops deploy production`, read the plan, then run it again with `--go`. Cloudflare makes the DNS record and the certificate.
4. `https://e.<your domain>/healthz` answers 200 once the certificate is ready.

The dashboard's own address works too, and the snippet in the dashboard uses it. It is the only choice for a site with no domain of its own, such as a `*.workers.dev` preview.

## 3. A website: install posthog-js at the pinned version

The Worker serves the session recorder and the other scripts posthog-js loads later, from one pinned posthog-js version (D-15). Install exactly that version:

<!-- generated:posthog-js-install -->
```sh
npm install --save-exact posthog-js@1.438.12
```
<!-- /generated:posthog-js-install -->

Another version still loads the scripts through a fallback path, but only the pinned version is tested. Upgrade the site when the deployment upgrades.

Then start it with the product's token:

```js
import posthog from "posthog-js";

posthog.init("<token>", {
  api_host: "https://e.<your domain>",
  person_profiles: "identified_only",
});
```

`person_profiles: "identified_only"` still counts anonymous visitors (D-25). It only keeps no stored profile for them.

## 4. A website: consent

A public site needs its visitors' consent before it sets a cookie or stores anything in the browser. posthog-js can count without either. With these two options, a visitor who has not agreed sends cookieless events only, and the server makes a visitor id from a daily salt (the `cookieless` slice):

```js
posthog.init("<token>", {
  api_host: "https://e.<your domain>",
  person_profiles: "identified_only",
  cookieless_mode: "on_reject",
  opt_out_capturing_by_default: true,
});
```

The banner's Accept calls `posthog.opt_in_capturing()`, and its Reject calls `posthog.opt_out_capturing()`. Use `cookieless_mode: "always"` when the site has no banner. A private, password-protected preview needs neither.

The site's privacy text says what is counted and for how long, and that a deletion is complete within 30 days, because Cloudflare's point-in-time recovery can restore deleted data for that long (`docs/data-model.md`).

## 5. A server: posthog-node

```js
import { PostHog } from "posthog-node";

const posthog = new PostHog("<token>", { host: "https://e.<your domain>" });
posthog.capture({ distinctId: "user-42", event: "order placed" });
await posthog.shutdown();
```

`shutdown()` sends what is still queued, so call it before the process ends. An event that should make no person carries the property `$process_person_profile: false`.

## 6. Test it in a real browser

posthog-js drops every event from a browser it takes for a bot. Headless Playwright counts as one even with a normal user agent, because its client hints still say "HeadlessChrome" and `navigator.webdriver` is true. The result misleads: recordings arrive, but no events. Test in a real browser window, or with headed Playwright, and read the events with `includeBots: true`.

## 7. See that it arrives

- The product's board fills as events arrive. Until the first one, it shows the install line and the snippet.
- Recordings lists each recorded session, once recording is on and a session is longer than the shortest kept (Settings).
- A recording keeps each image's address, not the image, and the player loads it from the site while you watch. So a password-protected site's images show in its recordings only if it serves its image files without the password.
- From a script on the deployment's Mac, `scripts/lib/dashboard-api.mjs` signs in to the dashboard's API, the same way `pnpm smoke` and `pnpm ops export` do. Ask `/api/projects/<id>/query`, `/recordings` or `/heatmap`.
- A product's own backend reads its own numbers from `/api/external/query`, with one of its secret keys as a Bearer token (Settings, Keys). A secret key never goes into a page.

## 8. Leave out your own traffic

In the product's Settings, under "Your own traffic", add a rule on a person's or an event's property. Events that match are left out of every number, unless a screen asks to include them. For example, run `posthog.register({ internal: true })` once in your own browser, and add the rule: event's property `internal`, value type yes/no, value "yes (true)".
