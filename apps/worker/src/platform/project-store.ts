import { DurableObject } from "cloudflare:workers";
import {
  type ErasedCounts,
  type ExportPage,
  type ExportTable,
  type RecordingSummary,
  SWEEP_BATCH_ROWS,
} from "@cfanalytics/shared";
import { type PointsQuery, readPoints } from "../features/heatmaps/index.ts";
import { uuidV7 } from "../features/intake/index.ts";
import {
  type CompiledQuery,
  type RunError,
  runCompiled,
  type StoreRows,
} from "../features/query/index.ts";
import {
  type ChunkRef,
  chunksOf,
  type ListQuery,
  latestSnapshot as latestSnapshotIn,
  listRecordings as listRecordingsIn,
  type SnapshotRef,
} from "../features/recordings/index.ts";
import { alarmOnRequest, DAY_MS } from "./alarm.ts";
import { realDeps } from "./deps.ts";
import type { Env } from "./env.ts";
import {
  type EraseError,
  erasePerson as erasePersonIn,
  exportPage as exportPageIn,
  type ImportRefusal,
  type IngestAnswer,
  type IngestError,
  type IngestRequest,
  importPage as importPageIn,
  ingestBatch,
  type SnapshotAnswer,
  type SnapshotError,
  type SnapshotRequest,
  ingestSnapshots as storeSnapshots,
} from "./ingest.ts";
import { ok, type Result } from "./result.ts";
import { applySteps, recordProjectId, type SchemaError } from "./schema.ts";
import { PROJECT_STORE_STEPS } from "./steps.ts";
import { runAlarm } from "./sweep.ts";

// One project's store (D-3): a thin class. It runs the schema steps, receives
// RPC calls and hands each to the functions that own the work. Wave 2 added
// the call that stores a batch, wave 3 the calls that store and read
// recordings and heatmap points, wave 4 the query, the deletion by person,
// the export, the purge and the alarm (docs/build-plan.md). A store whose
// schema cannot serve answers every call with its SchemaError as a value, so
// the caller answers 503 and nothing is written (platform-22, D-22). Every
// call keeps the alarm, as ready() does.

export class ProjectStore extends DurableObject {
  /** The schema steps' outcome, settled before any call arrives (platform-24). */
  private readonly applied: Promise<Result<number, SchemaError>>;

  /**
   * Uuids of the chunks an ingestSnapshots call is writing now. Calls reach
   * the object one at a time, but one may start while another awaits its R2
   * write, so a duplicate sent at once must see the first (recordings-12).
   */
  private readonly chunksInFlight = new Set<string>();

  /** Runs applySteps(PROJECT_STORE_STEPS) inside blockConcurrencyWhile (platform-19 to platform-26). */
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.applied = ctx.blockConcurrencyWhile(async () =>
      applySteps(ctx.storage, PROJECT_STORE_STEPS),
    );
  }

  /** The schema step applied, or the SchemaError that stops the store serving (platform-22). */
  async ready(): Promise<Result<{ step: number }, SchemaError>> {
    await this.keepAlarm();
    const applied = await this.applied;
    return applied.ok ? ok({ step: applied.value }) : applied;
  }

  /**
   * Stores one batch (intake-01, intake-09, events-04, cookieless-11). Keeps
   * the alarm like every call. A SchemaError is answered and nothing is
   * written (platform-22, intake-28). Then it records the request's project
   * id once (recordProjectId) and runs ingestBatch with:
   * - makeSalt: 16 bytes from crypto.getRandomValues
   * - newSessionId: uuidV7 of Date.now() and 10 random bytes
   * - databaseSize: ctx.storage.sql.databaseSize
   * Calls reach the object one at a time, so two batches never both take the
   * last of a cap or both make the day's salt (intake-09, cookieless-11).
   */
  async ingest(request: IngestRequest): Promise<Result<IngestAnswer, SchemaError | IngestError>> {
    await this.keepAlarm();
    const applied = await this.applied;
    if (!applied.ok) return applied;

    const sql = this.ctx.storage.sql;
    recordProjectId(sql, request.projectId);
    return ingestBatch(this.ctx.storage, request, {
      makeSalt: () => crypto.getRandomValues(new Uint8Array(16)),
      newSessionId: () => uuidV7(Date.now(), crypto.getRandomValues(new Uint8Array(10))),
      databaseSize: sql.databaseSize,
    });
  }

  /**
   * Stores a request's recording chunks with ingestSnapshots, against the
   * RECORDINGS bucket and chunksInFlight. A SchemaError is answered and
   * nothing is written. Records the request's project id once, as ingest
   * does (recordings-03, recordings-10, recordings-12, recordings-17).
   */
  async ingestSnapshots(
    request: SnapshotRequest,
  ): Promise<Result<SnapshotAnswer, SchemaError | SnapshotError>> {
    await this.keepAlarm();
    const applied = await this.applied;
    if (!applied.ok) return applied;

    recordProjectId(this.ctx.storage.sql, request.projectId);
    return storeSnapshots(this.ctx.storage, this.env.RECORDINGS, request, this.chunksInFlight);
  }

  /** chunksOf the session: its chunks in play order, empty for an unknown session (recordings-01, recordings-15). */
  async recordingChunks(sessionId: string): Promise<Result<ChunkRef[], SchemaError>> {
    await this.keepAlarm();
    const applied = await this.applied;
    if (!applied.ok) return applied;
    return ok(chunksOf(this.ctx.storage.sql, sessionId));
  }

  /** listRecordings: one page of the recording list (recordings-05, recordings-29). */
  async listRecordings(query: ListQuery): Promise<Result<RecordingSummary[], SchemaError>> {
    await this.keepAlarm();
    const applied = await this.applied;
    if (!applied.ok) return applied;
    return ok(listRecordingsIn(this.ctx.storage.sql, query));
  }

  /** latestSnapshot of a page in a width band, or null (heatmaps-02). */
  async latestSnapshot(
    path: string,
    widthBand: number,
  ): Promise<Result<SnapshotRef | null, SchemaError>> {
    await this.keepAlarm();
    const applied = await this.applied;
    if (!applied.ok) return applied;
    return ok(latestSnapshotIn(this.ctx.storage.sql, path, widthBand));
  }

  /** readPoints: one page's points in a width band, and the rows read (heatmaps-02, heatmaps-11, heatmaps-12). */
  async heatmapPoints(
    query: PointsQuery,
  ): Promise<Result<ReturnType<typeof readPoints>, SchemaError>> {
    await this.keepAlarm();
    const applied = await this.applied;
    if (!applied.ok) return applied;
    return ok(readPoints(this.ctx.storage.sql, query));
  }

  /**
   * runCompiled (query) on this store's SQL, read only (D-18). A SchemaError
   * or a failed statement is answered as a value; the Worker answers 503.
   */
  async runQuery(query: CompiledQuery): Promise<Result<StoreRows, SchemaError | RunError>> {
    await this.keepAlarm();
    const applied = await this.applied;
    if (!applied.ok) return applied;
    return runCompiled(this.ctx.storage.sql, query);
  }

  /**
   * erasePerson (ingest.ts) against the RECORDINGS bucket (privacy-02,
   * privacy-05, privacy-16, privacy-17, privacy-19). A SchemaError is
   * answered and nothing is deleted.
   */
  async erasePerson(distinctId: string): Promise<Result<ErasedCounts, SchemaError | EraseError>> {
    await this.keepAlarm();
    const applied = await this.applied;
    if (!applied.ok) return applied;
    return erasePersonIn(this.ctx.storage, this.env.RECORDINGS, distinctId);
  }

  /** exportPage (ingest.ts): one page of a table, rows with a rowid above `after` (privacy-22, privacy-25). */
  async exportPage(table: ExportTable, after: number): Promise<Result<ExportPage, SchemaError>> {
    await this.keepAlarm();
    const applied = await this.applied;
    if (!applied.ok) return applied;
    return ok(exportPageIn(this.ctx.storage.sql, table, after));
  }

  /** importPage (ingest.ts): a page of a backup's lines back into this store (privacy-30, privacy-31). */
  async importPage(
    projectId: string,
    table: ExportTable,
    lines: readonly unknown[],
  ): Promise<Result<number, SchemaError | ImportRefusal>> {
    await this.keepAlarm();
    const applied = await this.applied;
    if (!applied.ok) return applied;
    return importPageIn(this.ctx.storage, projectId, table, lines);
  }

  /**
   * Brings the alarm forward to `at` for a deleted project's purge
   * (privacy-20): set to `at` when there is no alarm or it is later; an
   * earlier one stays, and runAlarm then waits for the purge's time. Answers
   * the alarm now set. It reads no table, so it never meets a SchemaError.
   */
  async schedulePurge(at: number): Promise<Result<{ alarm: number }, never>> {
    const current = await this.ctx.storage.getAlarm();
    const next = current === null || current > at ? at : current;
    if (next !== current) await this.ctx.storage.setAlarm(next);
    return ok({ alarm: next });
  }

  /**
   * Called by Cloudflare, not over RPC. A store whose schema cannot serve
   * neither sweeps nor purges: it logs schema_unavailable and sets the alarm
   * to Date.now() + DAY_MS. Else runAlarm (sweep.ts) with the REGISTRY and
   * RECORDINGS bindings, Date.now(), realDeps' logger and SWEEP_BATCH_ROWS.
   * A failure is thrown as an Error naming its kind, so Cloudflare's alarm
   * retry runs it again (platform-30, D-22).
   */
  override async alarm(): Promise<void> {
    const now = Date.now();
    const { log } = realDeps();
    const applied = await this.applied;
    if (!applied.ok) {
      log.error("schema_unavailable", { error: applied.error });
      await this.ctx.storage.setAlarm(now + DAY_MS);
      return;
    }
    const answer = await runAlarm(this.ctx.storage, this.env, now, log, SWEEP_BATCH_ROWS);
    if (!answer.ok) throw new Error(answer.error.kind);
  }

  /** Every call keeps a sweep scheduled, and never moves the current alarm later (platform-27). */
  private async keepAlarm(): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    const next = alarmOnRequest(Date.now(), current);
    if (next !== null) await this.ctx.storage.setAlarm(next);
  }
}
