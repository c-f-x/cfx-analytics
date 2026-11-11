import type { EventsResult } from "@cfanalytics/shared";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { ArrowLeft, Pause, Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Replayer } from "rrweb";
import { Card, PageBody, PageHeader } from "@/components/page.tsx";
import { loadReplayer } from "@/components/replayer.ts";
import { ErrorState, SkeletonRows } from "@/components/states.tsx";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import { apiText } from "@/lib/api.ts";
import { duration, moment } from "@/lib/format.ts";
import { useAnswer } from "@/lib/queries.ts";
import { eventsOf } from "@/lib/replay.ts";

// One recording played back with rrweb, scripts off and typed text already
// masked by the Worker (recordings-02), with the session's events beside it.
// Each event shows how far into the recording it came, and a click on it
// moves the player there.

const SPEEDS = [1, 2, 4] as const;

/** What the player lets the events list do: where the recording starts, and a way to move to a moment in it. */
interface PlayerControl {
  start: number;
  seek: (offsetMs: number) => void;
}

export function PlayerScreen() {
  const { projectId, sessionId } = useParams({ from: "/p/$projectId/recordings/$sessionId" });
  const [control, setControl] = useState<PlayerControl | null>(null);
  const chunks = useQuery({
    queryKey: ["chunks", projectId, sessionId],
    queryFn: () => apiText(`/api/projects/${projectId}/recordings/${sessionId}/chunks`),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const events = useAnswer<EventsResult>(projectId, {
    kind: "events",
    range: { kind: "last_days", days: 3650 },
    limit: 200,
    includeBots: true,
    includeInternal: true,
    filter: { op: "eq", property: { of: "event", name: "$session_id" }, value: sessionId },
  });
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
              <Player ndjson={chunks.data} onReady={setControl} />
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
            ) : events.data.result.rows.length === 0 ? (
              <p className="px-4 pb-4 text-muted-foreground text-[13px]">
                No event of this session was kept.
              </p>
            ) : (
              <ol className="pb-2">
                {events.data.result.rows.toReversed().map((row) => {
                  const offset = control === null ? null : Date.parse(row.ts) - control.start;
                  return (
                    <li key={row.uuid} className="border-t">
                      <button
                        type="button"
                        disabled={offset === null}
                        title={moment(row.ts)}
                        className="flex w-full gap-3 px-4 py-2 text-left text-[13px] outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/45 focus-visible:ring-inset"
                        onClick={() => {
                          if (offset !== null) control?.seek(Math.max(0, offset));
                        }}
                      >
                        <span className="w-14 shrink-0 text-muted-foreground tabular-nums">
                          {offset === null ? "" : duration(Math.max(0, offset))}
                        </span>
                        <span className="truncate font-medium">{row.event}</span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            )}
          </Card>
        </div>
      </PageBody>
    </>
  );
}

function Player({
  ndjson,
  onReady,
}: {
  ndjson: string;
  onReady: (control: PlayerControl | null) => void;
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
        <input
          type="range"
          aria-label="Position"
          className="flex-1 accent-[var(--color-primary)]"
          min={0}
          max={Math.max(1, total)}
          value={Math.min(time, total)}
          onChange={(event) => {
            const at = Number(event.target.value);
            setTime(at);
            if (playing) replayer.current?.play(at);
            else replayer.current?.pause(at);
          }}
        />
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
