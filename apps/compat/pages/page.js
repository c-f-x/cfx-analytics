/* global posthog, location, document, setInterval, navigator, Blob, sessionStorage */

// The one script the compat pages run. The page's query string carries the
// Worker's host and the project token, so a page never stores either. The SDK
// itself is served from this page origin, as a consumer installs it; its remote
// config and lazy scripts come from the Worker's api_host.
const query = new URLSearchParams(location.search);
const options = { api_host: query.get("api") ?? "" };
if (document.body.dataset.cookieless === "always") options.cookieless_mode = "always";
// With compression off, a beacon cannot carry JSON, so the SDK encodes it as
// the base64 form body the Worker must decode (intake-11). The other visits
// keep gzip on, so a text/plain gzip body is exercised too (intake-10).
if (query.get("compression") === "off") options.disable_compression = true;

// A beacon sent while a page unloads never reaches the browser's automation
// protocol, so the page records what the SDK hands to sendBeacon. The call
// itself still goes out. The record survives the navigation in sessionStorage,
// and the client reads it afterwards (intake-11).
const beacon = navigator.sendBeacon.bind(navigator);
navigator.sendBeacon = (url, data) => {
  try {
    const stored = JSON.parse(sessionStorage.getItem("compat-beacons") ?? "[]");
    const type = data instanceof Blob ? data.type : "string";
    const size = data instanceof Blob ? data.size : typeof data === "string" ? data.length : 0;
    stored.push({ url: String(url), type, size });
    sessionStorage.setItem("compat-beacons", JSON.stringify(stored));
  } catch {
    // A page without storage still sends its beacon.
  }
  return beacon(url, data);
};

posthog.init(query.get("token") ?? "", options);

// rrweb records DOM changes. A page with none leaves the recorder's
// minimum-duration gate shut, so no snapshot chunk is ever sent; this ticker
// keeps the page changing, as a live page does (recordings-01).
const tick = document.querySelector("#tick");
let ticks = 0;
setInterval(() => {
  ticks += 1;
  if (tick !== null) tick.textContent = `tick ${ticks}`;
}, 100);

// The Worker's config says hasFeatureFlags false, so the SDK does not call
// /flags on its own. Asking for flags is the SDK's own way to call it, and the
// answer it gets is config-03.
posthog.reloadFeatureFlags();

// The next page reads the same host and token.
const next = document.querySelector("#next");
if (next !== null) next.setAttribute("href", `/second.html${location.search}`);
