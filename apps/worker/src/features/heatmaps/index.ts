// What heatmaps offers: turning $$heatmap events into points (intake calls
// it), its table's functions (the ProjectStore calls them), and its route.
export {
  type HeatmapKind,
  type HeatmapPointInput,
  type PointsQuery,
  pointsFromEvent,
  widthBand,
} from "./core.ts";
export { mountHeatmaps } from "./http.ts";
export {
  erasePoints,
  exportPoints,
  insertPoints,
  POINTS_SHAPE,
  prunePoints,
  readPoints,
  storedPointEvents,
} from "./store.ts";
