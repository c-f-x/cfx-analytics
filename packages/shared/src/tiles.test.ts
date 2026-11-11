import { describe, expect, it } from "vitest";
import { missingStandardTiles, STANDARD_TILES, type Tile } from "./tiles.ts";

// Which standard tiles a board lacks (projects-45): one rule for the Worker's
// restore and the dashboard's "Restore standard tiles".

const board = (): Tile[] =>
  STANDARD_TILES.map((tile, index) => ({
    id: `t${String(index)}`,
    title: tile.title,
    spec: tile.spec,
    standard: true,
  }));

describe("missingStandardTiles", () => {
  it("projects-45 · a full board lacks none, and a renamed standard tile still counts", () => {
    expect(missingStandardTiles(board())).toEqual([]);
    const renamed = board().map((tile) =>
      tile.title === "Visitors" ? { ...tile, title: "People" } : tile,
    );
    expect(missingStandardTiles(renamed)).toEqual([]);
  });

  it("projects-45 · a removed tile, or one no longer marked standard, is missing", () => {
    const removed = board().filter((tile) => tile.title !== "Pages");
    expect(missingStandardTiles(removed).map((tile) => tile.title)).toEqual(["Pages"]);
    const owned = board().map((tile) =>
      tile.title === "Devices" ? { ...tile, standard: false } : tile,
    );
    expect(missingStandardTiles(owned).map((tile) => tile.title)).toEqual(["Devices"]);
  });

  it("projects-45 · the same question with its keys in another order is the same tile", () => {
    const reordered = board().map((tile) =>
      tile.spec.kind === "trend"
        ? { ...tile, spec: JSON.parse(JSON.stringify({ compare: true, ...tile.spec })) }
        : tile,
    );
    expect(missingStandardTiles(reordered)).toEqual([]);
  });
});
