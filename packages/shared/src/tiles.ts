import { z } from "zod";
import {
  eventsSpec,
  funnelSpec,
  propertiesSpec,
  retentionSpec,
  scrollDepthSpec,
  topSpec,
  trendSpec,
} from "./query.ts";

// The board's tiles (D-24, projects-40 to projects-44): saved questions,
// each a query spec without its range or time zone, which the board
// supplies when it asks.

/** The most tiles one board holds (projects-42). */
export const TILE_LIMIT = 40;

/** A spec saved on a tile: a query spec without the parts the board supplies. */
export const tileSpec = z.discriminatedUnion("kind", [
  trendSpec.omit({ range: true, timeZone: true }),
  topSpec.omit({ range: true, timeZone: true, cursor: true }),
  funnelSpec.omit({ range: true, timeZone: true }),
  retentionSpec.omit({ range: true, timeZone: true }),
  scrollDepthSpec.omit({ range: true, timeZone: true }),
  eventsSpec.omit({ range: true, timeZone: true, cursor: true }),
  propertiesSpec.omit({ range: true, timeZone: true }),
]);
export type TileSpec = z.infer<typeof tileSpec>;

const title = z.string().trim().min(1).max(100);

/** The body that adds a tile (projects-42). */
export const tileCreate = z.strictObject({ title, spec: tileSpec });

/** The body that changes a tile: its title, its position, its spec, or several (projects-43). */
export const tileUpdate = z
  .strictObject({
    title: title.optional(),
    position: z.number().int().min(0).optional(),
    spec: tileSpec.optional(),
  })
  .refine(
    (body) => body.title !== undefined || body.position !== undefined || body.spec !== undefined,
    { message: "name a title, a position or a spec" },
  );

export interface Tile {
  id: string;
  title: string;
  spec: TileSpec;
  /** One of the standard tiles a new board starts with (projects-40). */
  standard: boolean;
}

/** The tiles a new board starts with, in order (projects-40, D-24). */
export const STANDARD_TILES: readonly { title: string; spec: TileSpec }[] = [
  {
    title: "Visitors",
    spec: { kind: "trend", measure: "visitors", granularity: "day", compare: true },
  },
  {
    title: "Page views",
    spec: {
      kind: "trend",
      measure: "events",
      event: "$pageview",
      granularity: "day",
      compare: true,
    },
  },
  {
    title: "Sessions",
    spec: { kind: "trend", measure: "sessions", granularity: "day", compare: true },
  },
  {
    title: "Pages",
    spec: { kind: "top", event: "$pageview", dimension: { builtin: "page" }, measure: "visitors" },
  },
  {
    title: "Sources",
    spec: { kind: "top", dimension: { builtin: "channel" }, measure: "visitors" },
  },
  {
    title: "Countries",
    spec: { kind: "top", dimension: { builtin: "country" }, measure: "visitors" },
  },
  {
    title: "Devices",
    spec: { kind: "top", dimension: { builtin: "device_type" }, measure: "visitors" },
  },
];

/** A spec as one text whatever its keys' order: the schema's own order after parsing. */
export function tileSpecKey(spec: unknown): string {
  const parsed = tileSpec.safeParse(spec);
  return JSON.stringify(parsed.success ? parsed.data : spec);
}

/**
 * The standard tiles a board lacks, in STANDARD_TILES' order: those whose
 * question no tile marked standard holds, whatever the titles (projects-45).
 * The Worker's restore and the dashboard's "Restore standard tiles" both use it.
 */
export function missingStandardTiles(
  tiles: readonly Pick<Tile, "spec" | "standard">[],
): { title: string; spec: TileSpec }[] {
  const present = new Set(
    tiles.filter((tile) => tile.standard).map((tile) => tileSpecKey(tile.spec)),
  );
  return STANDARD_TILES.filter((tile) => !present.has(tileSpecKey(tile.spec)));
}
