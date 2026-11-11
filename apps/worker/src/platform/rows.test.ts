import { expect, it } from "vitest";
import { exportCursor, rowNumber, rowNumberOrNull, rowText, rowTextOrNull } from "./rows.ts";

// Reading a ProjectStore row's columns, and the export's page cursor
// (platform-35, privacy-25). A column of the wrong type is a broken
// invariant, so it throws with the column's name.

it("platform-35 · a column of the right type reads back, and a wrong one names the column", () => {
  expect(rowText("a", "events.event")).toBe("a");
  expect(rowNumber(3, "events.ts")).toBe(3);
  expect(rowTextOrNull(null, "events.page")).toBeNull();
  expect(rowNumberOrNull(null, "events.person_id")).toBeNull();
  expect(() => rowText(3, "events.event")).toThrow("events.event is not text");
  expect(() => rowNumber("3", "events.ts")).toThrow("events.ts is not a number");
});

it("privacy-25 · a full page names its last rowid as the cursor, a short page none", () => {
  const page = [{ row_id: 1 }, { row_id: 2 }];
  expect(exportCursor(page, 2)).toBe(2);
  expect(exportCursor(page, 3)).toBeNull();
  expect(exportCursor([], 0)).toBeNull();
});
