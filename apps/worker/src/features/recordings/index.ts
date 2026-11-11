// What recordings offers: its routes, the chunk shapes the ProjectStore
// receives, and its tables' and R2's functions, which the ProjectStore calls
// (it is their only writer, D-13).
export {
  type ChunkMeta,
  type ListQuery,
  objectKey,
  type RrwebEvent,
} from "./core.ts";
export { mountRecordings } from "./http.ts";
export {
  CHUNKS_SHAPE,
  type ChunkRef,
  type ChunkRow,
  chunksOf,
  deleteChunkRows,
  deleteObjects,
  deletePrefix,
  expiredRecordings,
  exportChunks,
  exportRecordings,
  hasChunk,
  knownKeys,
  latestSnapshot,
  listRecordings,
  orphanKeys,
  putChunk,
  RECORDINGS_SHAPE,
  type RecordingKeys,
  recordChunk,
  recordingsOf,
  type SnapshotRef,
} from "./store.ts";
