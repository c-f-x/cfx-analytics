import { expect, it } from "vitest";
import { eventsOf, newestSnapshot } from "./replay.ts";

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
