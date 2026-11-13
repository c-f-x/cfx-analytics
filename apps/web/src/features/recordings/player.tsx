import type { Answer, EventsResult, QuerySpec } from "@cfanalytics/shared";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { ArrowLeft, Pause, Play } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Replayer } from "rrweb";
import { Card, PageBody, PageHeader } from "@/components/page.tsx";
import { loadReplayer } from "@/components/replayer.ts";
import { ErrorState, SkeletonRows } from "@/components/states.tsx";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import { Tooltip } from "@/components/ui/tooltip.tsx";
import { api, apiText } from "@/lib/api.ts";
import { cn } from "@/lib/cn.ts";
import { duration, moment } from "@/lib/format.ts";
import { type EventKind, eventsOf, labelOf, readAllPages } from "@/lib/replay.ts";

// One recording played back with rrweb, scripts off and typed text already
// masked by the Worker (recordings-02), with the session's events beside it
// in plain words (#22). Page views and clicks are also marks on the timeline.
// A click on a row or a mark moves the player there, and the row of the
// moment playing is highlighted.

const SPEEDS = [1, 2, 4] as const;

/** How close the player's clock must be to a row's moment to count as reached. */
const REACHED_MS = 50;

/** The most of a session's events the list reads (recordings-38). */
const SESSION_EVENTS_CAP = 2000;

/** What the player lets the events list do: where the recording starts, and a way to move to a moment in it. */
interface PlayerControl {
  start: number;
  seek: (offsetMs: number) => void;
}

/** A moment on the timeline: where, what kind, and what happened. */
interface Mark {
  offset: number;
  kind: EventKind;
  label: string;
}

export function PlayerScreen() {
  const { projectId, sessionId } = useParams({ from: "/p/$projectId/recordings/$sessionId" });
  const [control, setControl] = useState<PlayerControl | null>(null);
  const [now, setNow] = useState(0);
  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  const chunks = useQuery({
    queryKey: ["chunks", projectId, sessionId],
    queryFn: () => apiText(`/api/projects/${projectId}/recordings/${sessionId}/chunks`),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const events = useQuery({
    queryKey: ["session-events", projectId, sessionId],
    queryFn: () =>
      readAllPages(async (cursor) => {
        const spec: QuerySpec = {
          kind: "events",
          range: { kind: "last_days", days: 3650 },
          limit: 500,
          includeBots: true,
          includeInternal: true,
          filter: { op: "eq", property: { of: "event", name: "$session_id" }, value: sessionId },
          ...(cursor === undefined ? {} : { cursor }),
        };
        const answer = await api<Answer<EventsResult>>(`/api/projects/${projectId}/query`, {
          method: "POST",
          body: spec,
        });
        return answer.result;
      }, SESSION_EVENTS_CAP),
    staleTime: 30_000,
  });
  const rows = useMemo(
    () =>
      (events.data?.rows ?? []).toReversed().flatMap((row) => {
        const label = labelOf(row);
        if (label === null) return [];
        const offset = control === null ? null : Math.max(0, Date.parse(row.ts) - control.start);
        return [{ row, ...label, offset }];
      }),
    [events.data, control],
  );
  const marks: Mark[] = rows.flatMap((each) =>
    each.offset !== null && each.kind !== "other"
      ? [{ offset: each.offset, kind: each.kind, label: each.label }]
      : [],
  );
  // The player's clock can read a few milliseconds short of a moment it was
  // moved to, so a row counts as reached within this tolerance.
  const current = rows.findLastIndex(
    (each) => each.offset !== null && each.offset <= now + REACHED_MS,
  );
  const currentUuid = rows[current]?.row.uuid;
  useEffect(() => {
    if (currentUuid === undefined) return;
    rowRefs.current.get(currentUuid)?.scrollIntoView({ block: "nearest" });
  }, [currentUuid]);
  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <Link
              to="/p/$projectId/recordings"
              params={{ projectId }}
              search={{}}
              className={buttonVariants({ variant: "ghost", size: "icon-sm" })}
              aria-label="Back to recordings"
            >
              <ArrowLeft />
            </Link>
            Recording
          </span>
        }
      />
      <PageBody className="max-w-[1400px]">
        <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
          <Card className="overflow-hidden">
            {chunks.isError ? (
              <ErrorState error={chunks.error} onRetry={() => void chunks.refetch()} />
            ) : chunks.data === undefined ? (
              <SkeletonRows rows={10} />
            ) : (
              <Player ndjson={chunks.data} onReady={setControl} onTime={setNow} marks={marks} />
            )}
          </Card>
          <Card className="max-h-[70vh] overflow-y-auto">
            <div className="flex h-11 items-center px-4 pt-1">
              <h2 className="font-semibold text-[13px]">Events in this session</h2>
            </div>
            {events.isError ? (
              <ErrorState error={events.error} onRetry={() => void events.refetch()} />
            ) : events.data === undefined ? (
              <SkeletonRows rows={6} />
            ) : rows.length === 0 ? (
              <p className="px-4 pb-4 text-muted-foreground text-[13px]">
                No event of this session was kept.
              </p>
            ) : (
              <ol className="pb-2">
                {rows.map(({ row, label, kind, offset }, index) => (
                  <li
                    key={row.uuid}
                    ref={(element) => {
                      if (element === null) rowRefs.current.delete(row.uuid);
                      else rowRefs.current.set(row.uuid, element);
                    }}
                    className="border-t"
                  >
                    <button
                      type="button"
                      disabled={offset === null}
                      title={moment(row.ts)}
                      aria-current={index === current ? "true" : undefined}
                      className="flex w-full items-center gap-3 px-4 py-2 text-left text-[13px] outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/45 focus-visible:ring-inset aria-[current]:bg-primary/10"
                      onClick={() => {
                        if (offset !== null) control?.seek(offset);
                      }}
                    >
                      <span className="w-12 shrink-0 text-muted-foreground tabular-nums">
                        {offset === null ? "" : duration(offset)}
                      </span>
                      <span
                        aria-hidden="true"
                        className={cn("size-1.5 shrink-0 rounded-full", MARK_COLOUR[kind])}
                      />
                      <span className={cn("truncate", kind === "problem" && "font-medium")}>
                        {label}
                      </span>
                    </button>
                  </li>
                ))}
                {events.data.more ? (
                  <li className="border-t px-4 py-2 text-muted-foreground text-xs">
                    Only the last {SESSION_EVENTS_CAP.toLocaleString()} events are shown. Earlier
                    ones were left out.
                  </li>
                ) : null}
              </ol>
            )}
          </Card>
        </div>
      </PageBody>
    </>
  );
}

/** Each kind's colour: warning is kept for function, so it marks problems only. */
const MARK_COLOUR: Record<EventKind, string> = {
  page: "bg-foreground/70",
  click: "bg-primary",
  problem: "bg-warning",
  other: "bg-muted-foreground/40",
};

function Player({
  ndjson,
  onReady,
  onTime,
  marks,
}: {
  ndjson: string;
  onReady: (control: PlayerControl | null) => void;
  onTime: (offsetMs: number) => void;
  marks: Mark[];
}) {
  const stage = useRef<HTMLDivElement | null>(null);
  const replayer = useRef<Replayer | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const [time, setTime] = useState(0);
  const [total, setTotal] = useState(0);
  const [scale, setScale] = useState(1);
  const [loadFailed, setLoadFailed] = useState<unknown>(null);

  useEffect(() => {
    const element = stage.current;
    const events = eventsOf(ndjson);
    if (element === null || events.length < 2) return undefined;
    let player: Replayer | null = null;
    let tick: number | undefined;
    let gone = false;
    void loadReplayer().then((ReplayerClass) => {
      if (gone) return;
      const shown = new ReplayerClass(events, {
        root: element,
        skipInactive: true,
        mouseTail: false,
        showWarning: false,
        UNSAFE_replayCanvas: false,
      });
      player = shown;
      replayer.current = shown;
      setTotal(shown.getMetaData().totalTime);
      shown.on("finish", () => setPlaying(false));
      const fitToBox = () => {
        const frame = shown.iframe;
        const width = Number(frame.width) || frame.offsetWidth;
        const height = Number(frame.height) || frame.offsetHeight;
        const available = element.parentElement?.clientWidth ?? width;
        const next = Math.min(1, available / Math.max(1, width));
        setScale(next);
        element.style.width = `${String(width)}px`;
        element.style.height = `${String(height)}px`;
      };
      shown.on("resize", fitToBox);
      shown.pause(0);
      fitToBox();
      onReady({
        start: shown.getMetaData().startTime,
        seek: (offsetMs) => {
          shown.pause(offsetMs);
          setTime(offsetMs);
          setPlaying(false);
        },
      });
      tick = window.setInterval(() => setTime(shown.getCurrentTime()), 200);
    }, setLoadFailed);
    return () => {
      gone = true;
      window.clearInterval(tick);
      player?.destroy();
      replayer.current = null;
      onReady(null);
    };
  }, [ndjson, onReady]);

  useEffect(() => onTime(time), [time, onTime]);

  const seekTo = (at: number) => {
    setTime(at);
    if (playing) replayer.current?.play(at);
    else replayer.current?.pause(at);
  };

  const toggle = () => {
    const player = replayer.current;
    if (player === null) return;
    if (playing) player.pause();
    else player.play(time >= total ? 0 : time);
    setPlaying(!playing);
  };

  if (loadFailed !== null) return <ErrorState error={loadFailed} />;
  return (
    <div className="flex flex-col">
      <div
        className="overflow-hidden bg-muted/40"
        style={{ height: (stage.current?.offsetHeight ?? 480) * scale }}
      >
        <div
          ref={stage}
          className="origin-top-left [&_.replayer-mouse]:size-4 [&_.replayer-mouse]:rounded-full [&_.replayer-mouse]:bg-primary/60 [&_iframe]:border-0 [&_iframe]:bg-white"
          style={{ transform: `scale(${String(scale)})` }}
        />
      </div>
      <div className="flex items-center gap-3 border-t px-4 py-2.5">
        <Button
          size="icon"
          variant="primary"
          onClick={toggle}
          aria-label={playing ? "Pause" : "Play"}
        >
          {playing ? <Pause /> : <Play />}
        </Button>
        <div className="flex flex-1 flex-col gap-1">
          <div className="relative h-3">
            {total > 0
              ? marks.map((mark) => (
                  <Tooltip
                    key={`${String(mark.offset)}-${mark.label}`}
                    label={`${duration(mark.offset)} · ${mark.label}`}
                  >
                    <button
                      type="button"
                      aria-label={`${duration(mark.offset)}, ${mark.label}`}
                      className={cn(
                        "-translate-x-1/2 absolute top-0 h-3 w-1 rounded-full outline-none hover:scale-y-125 focus-visible:ring-2 focus-visible:ring-ring/45",
                        MARK_COLOUR[mark.kind],
                      )}
                      style={{
                        left: `calc(8px + (100% - 16px) * ${String(Math.min(1, mark.offset / total))})`,
                      }}
                      onClick={() => seekTo(Math.min(mark.offset, total))}
                    />
                  </Tooltip>
                ))
              : null}
          </div>
          <input
            type="range"
            aria-label="Position"
            className="w-full accent-[var(--color-primary)]"
            min={0}
            max={Math.max(1, total)}
            value={Math.min(time, total)}
            onChange={(event) => seekTo(Number(event.target.value))}
          />
        </div>
        <span className="w-24 text-right text-muted-foreground text-xs tabular-nums">
          {duration(time)} / {duration(total)}
        </span>
        <div className="flex rounded-md bg-muted p-0.5">
          {SPEEDS.map((each) => (
            <button
              key={each}
              type="button"
              aria-pressed={speed === each}
              className="h-6 rounded px-2 font-medium text-muted-foreground text-xs aria-pressed:bg-card aria-pressed:text-foreground aria-pressed:shadow-sm"
              onClick={() => {
                setSpeed(each);
                replayer.current?.setConfig({ speed: each });
              }}
            >
              {each}×
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
