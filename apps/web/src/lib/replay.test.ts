import { expect, it } from "vitest";
import { chainOf, eventsOf, labelOf, newestSnapshot, readAllPages } from "./replay.ts";

it("dashboard-04 · NDJSON lines become events, and a torn or foreign line is skipped", () => {
  const text = '{"type":4,"timestamp":1,"data":{}}\n{"type":2\n{"x":1}\n\n{"type":3,"timestamp":2}';
  expect(eventsOf(text).map((event) => event.type)).toEqual([4, 3]);
});

it("dashboard-04 · the newest full snapshot comes with the Meta event before it", () => {
  const events = [
    { type: 4, timestamp: 1 },
    { type: 2, timestamp: 2 },
    { type: 3, timestamp: 3 },
    { type: 4, timestamp: 4 },
    { type: 2, timestamp: 5 },
    { type: 3, timestamp: 6 },
  ];
  expect(newestSnapshot(events)?.map((event) => event.timestamp)).toEqual([4, 5]);
  expect(newestSnapshot([{ type: 3, timestamp: 1 }])).toBeNull();
});

// Chains shaped as posthog-js writes them (config-09): innermost element first,
// each "tag.classes:attr__name=\"value\"nth-child=\"n\"text=\"...\"".
const ICON_IN_MENU =
  'svg:attr__aria-hidden="true"nth-child="1"nth-of-type="1";summary:attr__aria-label="Menu"nth-child="1"nth-of-type="1";details.mobile:nth-child="4"nth-of-type="1";body:nth-child="2"nth-of-type="1"';
const BUY_BUTTON =
  'button.cta:nth-child="1"nth-of-type="1"text="Buy";div:nth-child="2"nth-of-type="1"';
const BARE_LINK =
  'a:attr__href="/pricing"nth-child="1"nth-of-type="1";nav:nth-child="1"nth-of-type="1"';
const BARE_DIV = 'div:nth-child="1"nth-of-type="1";div:nth-child="1"nth-of-type="1"';
const at = (event: string, properties: Record<string, unknown> = {}) =>
  labelOf({ event, properties });

it("recordings-37 · the chain is read innermost first, with text, labels and links", () => {
  expect(chainOf(ICON_IN_MENU).map((e) => [e.tag, e.label])).toEqual([
    ["svg", null],
    ["summary", "Menu"],
    ["details", null],
    ["body", null],
  ]);
  expect(chainOf(BUY_BUTTON)[0]).toEqual({ tag: "button", text: "Buy", label: null, href: null });
  expect(chainOf(BARE_LINK)[0]?.href).toBe("/pricing");
});

it("recordings-37 · page views and page leaves name the page", () => {
  expect(at("$pageview", { $pathname: "/pricing" })).toEqual({
    label: "Opened /pricing",
    kind: "page",
  });
  expect(at("$pageview", { $current_url: "https://shop.example/a/b?x=1" })?.label).toBe(
    "Opened /a/b",
  );
  expect(at("$pageleave", { $pathname: "/pricing" })).toEqual({
    label: "Left /pricing",
    kind: "other",
  });
});

it("recordings-37 · a click names the nearest named element, else its kind", () => {
  expect(at("$autocapture", { $event_type: "click", $elements_chain: ICON_IN_MENU })?.label).toBe(
    "Clicked 'Menu'",
  );
  expect(at("$autocapture", { $event_type: "click", $elements_chain: BUY_BUTTON })).toEqual({
    label: "Clicked 'Buy'",
    kind: "click",
  });
  expect(at("$autocapture", { $event_type: "click", $elements_chain: BARE_LINK })?.label).toBe(
    "Clicked a link to /pricing",
  );
  expect(at("$autocapture", { $event_type: "click", $elements_chain: BARE_DIV })?.label).toBe(
    "Clicked the page",
  );
});

it("recordings-37 · a change or submit never shows a typed value", () => {
  const typed = 'input:attr__value="secret"nth-child="1"nth-of-type="1"text="secret"';
  expect(at("$autocapture", { $event_type: "change", $elements_chain: typed })).toEqual({
    label: "Changed a field",
    kind: "other",
  });
  expect(at("$autocapture", { $event_type: "submit" })?.label).toBe("Submitted a form");
});

it("recordings-37 · rage clicks and clicks that did nothing are problems", () => {
  expect(at("$rageclick", { $elements_chain: BUY_BUTTON })).toEqual({
    label: "Rage-clicked 'Buy'",
    kind: "problem",
  });
  expect(at("$dead_click", { $elements_chain: BUY_BUTTON })).toEqual({
    label: "Clicked 'Buy', nothing happened",
    kind: "problem",
  });
});

it("recordings-37 · a product's own events keep their names, and SDK helpers are left out", () => {
  expect(at("order_completed")).toEqual({ label: "order_completed", kind: "other" });
  for (const helper of [
    "$feature_flag_called",
    "$web_vitals",
    "$set",
    "$groupidentify",
    "$identify",
    "$opt_in",
  ]) {
    expect(at(helper)).toBeNull();
  }
});

// A session's events served as the events answer serves them: newest first,
// 500 a page, with a cursor while more remain.
function pagesOf(total: number) {
  const rows = Array.from({ length: total }, (_, i) => ({ uuid: String(total - i) }));
  let asked = 0;
  const page = async (cursor?: string) => {
    asked += 1;
    const from = cursor === undefined ? 0 : Number(cursor);
    const next = from + 500;
    return { rows: rows.slice(from, next), ...(next < total ? { nextCursor: String(next) } : {}) };
  };
  return { page, asked: () => asked };
}

it("recordings-38 · every page of a session's events is read, up to the cap", async () => {
  const short = pagesOf(1250);
  const read = await readAllPages(short.page, 2000);
  expect(read.rows).toHaveLength(1250);
  expect(read.more).toBe(false);
  expect(short.asked()).toBe(3);
});

it("recordings-38 · past the cap, reading stops and says more were left out", async () => {
  const long = pagesOf(2600);
  const read = await readAllPages(long.page, 2000);
  expect(read.rows).toHaveLength(2000);
  expect(read.more).toBe(true);
  expect(long.asked()).toBe(4);
});
