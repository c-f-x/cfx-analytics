// What enrich offers other slices: one pure function per event, and the page
// key, which heatmaps uses too.
export { type Enriched, enrich, type RequestFacts } from "./core.ts";
export { type PageKey, pageKey } from "./page.ts";
