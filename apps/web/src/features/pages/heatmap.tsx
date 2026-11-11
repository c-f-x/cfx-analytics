import type { HeatmapResult } from "@cfanalytics/shared";
import { useQuery } from "@tanstack/react-query";
import { MousePointerClick } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Replayer } from "rrweb";
import { loadReplayer } from "@/components/replayer.ts";
import { EmptyState, ErrorState, SkeletonRows } from "@/components/states.tsx";
import { api, apiText } from "@/lib/api.ts";
import type { BoardState } from "@/lib/board.ts";
import { count } from "@/lib/format.ts";
import { periodOf } from "@/lib/period.ts";
import { eventsOf, newestSnapshot } from "@/lib/replay.ts";

// A page's clicks drawn over the newest recorded picture of it at that
// screen width (heatmaps-02). The picture is rebuilt by rrweb with scripts
// off; without one, the points are drawn over a blank page of that width.
// The widths offered are the page's bands that hold points (heatmaps-23).
// Until one is chosen, the Worker answers the busiest (heatmaps-24).

function useHeatmap(
  projectId: string,
  path: string,
  widthBand: number | null,
  type: string,
  board: BoardState,
) {
  return useQuery({
    queryKey: ["heatmap", projectId, path, widthBand, type, board.period, board.include],
    queryFn: () =>
      api<{ result: HeatmapResult }>(`/api/projects/${projectId}/heatmap`, {
        method: "POST",
        body: {
          range: periodOf(board.period).range,
          path,
          ...(widthBand === null ? {} : { widthBand }),
          ...(type === "all" ? {} : { type }),
          ...(board.include ? { includeBots: true } : {}),
        },
      }),
  });
}

/**
 * The rebuilt picture of the page, sized to its own width and full height:
 * the last full snapshot of the one chunk the heatmap answer names, which is
 * the snapshot recorded on this page (heatmaps-02, recordings-36).
 */
function Snapshot({
  projectId,
  sessionId,
  chunkKey,
  onSize,
}: {
  projectId: string;
  sessionId: string;
  chunkKey: string;
  onSize: (size: { width: number; height: number }) => void;
}) {
  const root = useRef<HTMLDivElement | null>(null);
  const [loadFailed, setLoadFailed] = useState<unknown>(null);
  const chunks = useQuery({
    queryKey: ["chunk", projectId, sessionId, chunkKey],
    queryFn: () =>
      apiText(
        `/api/projects/${projectId}/recordings/${sessionId}/chunks?chunk=${encodeURIComponent(chunkKey)}`,
      ),
    staleTime: Number.POSITIVE_INFINITY,
  });
  useEffect(() => {
    const element = root.current;
    if (element === null || chunks.data === undefined) return undefined;
    const events = newestSnapshot(eventsOf(chunks.data));
    if (events === null) return undefined;
    let replayer: Replayer | null = null;
    let timer: number | undefined;
    let gone = false;
    void loadReplayer().then((ReplayerClass) => {
      if (gone) return;
      const shown = new ReplayerClass(events, {
        root: element,
        mouseTail: false,
        showWarning: false,
        triggerFocus: false,
        UNSAFE_replayCanvas: false,
      });
      replayer = shown;
      shown.pause(0);
      const frame = shown.iframe;
      const settle = () => {
        const doc = frame.contentDocument?.documentElement;
        const width = frame.offsetWidth || Number(frame.width);
        const height = Math.max(doc?.scrollHeight ?? 0, frame.offsetHeight);
        frame.style.height = `${String(height)}px`;
        frame.setAttribute("height", String(height));
        onSize({ width, height });
      };
      timer = window.setTimeout(settle, 50);
    }, setLoadFailed);
    return () => {
      gone = true;
      window.clearTimeout(timer);
      replayer?.destroy();
    };
  }, [chunks.data, onSize]);
  // Without the picture the clicks still show, over a blank page of the same width.
  if (chunks.isError || loadFailed !== null) return null;
  return (
    <div
      ref={root}
      className="pointer-events-none [&_.replayer-mouse]:hidden [&_iframe]:border-0 [&_iframe]:bg-white"
    />
  );
}

export function Heatmap({
  projectId,
  path,
  board,
}: {
  projectId: string;
  path: string;
  board: BoardState;
}) {
  const [chosen, setChosen] = useState<number | null>(null);
  const [type, setType] = useState("all");
  const heatmap = useHeatmap(projectId, path, chosen, type, board);
  const offered = heatmap.data?.result.bands ?? [];
  const widthBand = heatmap.data?.result.widthBand ?? null;
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const frame = useRef<HTMLDivElement | null>(null);
  const [available, setAvailable] = useState(0);
  useLayoutEffect(() => {
    const element = frame.current;
    if (element === null) return undefined;
    const observer = new ResizeObserver(([entry]) => setAvailable(entry?.contentRect.width ?? 0));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const result = heatmap.data?.result;
  const pageWidth = size?.width ?? result?.snapshot?.width ?? widthBand ?? 1200;
  const scale = available === 0 ? 1 : Math.min(1, available / pageWidth);
  const height =
    size?.height ?? Math.max(800, ...(result?.points ?? []).map((point) => point.y + 40));
  const peak = Math.max(1, ...(result?.points ?? []).map((point) => point.count));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 px-4">
        <label htmlFor="band" className="text-muted-foreground text-[13px]">
          Screen width
        </label>
        <select
          id="band"
          className="h-8 rounded-md border bg-card px-2 text-[13px]"
          value={widthBand ?? ""}
          disabled={offered.length === 0}
          onChange={(event) => {
            setSize(null);
            setChosen(Number(event.target.value));
          }}
        >
          {offered.map((band) => (
            <option key={band.widthBand} value={band.widthBand}>
              {`${String(band.widthBand)} to ${String(band.widthBand + 99)} px · ${count(band.points)}`}
            </option>
          ))}
        </select>
        <label htmlFor="kind" className="ml-3 text-muted-foreground text-[13px]">
          Show
        </label>
        <select
          id="kind"
          className="h-8 rounded-md border bg-card px-2 text-[13px]"
          value={type}
          onChange={(event) => {
            setChosen(null);
            setType(event.target.value);
          }}
        >
          <option value="all">Every click</option>
          <option value="rageclick">Rage clicks</option>
          <option value="deadclick">Dead clicks</option>
        </select>
        {result === undefined ? null : (
          <span className="ml-auto text-muted-foreground text-xs">
            {result.points.reduce((sum, point) => sum + point.count, 0)} clicks
            {result.snapshot === null
              ? ", over a blank page: no recording of it at this width"
              : ""}
          </span>
        )}
      </div>
      <div ref={frame} className="overflow-hidden border-t bg-muted/40">
        {heatmap.isError ? (
          <ErrorState error={heatmap.error} onRetry={() => void heatmap.refetch()} />
        ) : heatmap.data !== undefined && offered.length === 0 ? (
          <EmptyState icon={MousePointerClick} title="No clicks on this page yet">
            Clicks show here when heatmaps are on in Settings and visitors use the page. Try a
            longer period.
          </EmptyState>
        ) : result === undefined ? (
          <SkeletonRows rows={8} />
        ) : result.points.length === 0 && result.snapshot === null ? (
          <EmptyState icon={MousePointerClick} title="No clicks at this width">
            Try another screen width, or a longer period.
          </EmptyState>
        ) : (
          <div style={{ height: height * scale }}>
            <div
              className="relative origin-top-left bg-white"
              style={{ width: pageWidth, height, transform: `scale(${String(scale)})` }}
            >
              {result.snapshot === null ? null : (
                <Snapshot
                  projectId={projectId}
                  sessionId={result.snapshot.sessionId}
                  chunkKey={result.snapshot.chunkKey}
                  onSize={setSize}
                />
              )}
              <div className="pointer-events-none absolute inset-0">
                {result.points.map((point) => {
                  const radius = 14 + 22 * Math.sqrt(point.count / peak);
                  return (
                    <span
                      key={`${String(point.x)}:${String(point.y)}:${String(point.fixed)}:${point.type}`}
                      className="absolute rounded-full"
                      title={`${String(point.count)} ${point.type}`}
                      style={{
                        left: point.x - radius,
                        top: point.y - radius,
                        width: radius * 2,
                        height: radius * 2,
                        background: `radial-gradient(circle, color-mix(in oklch, ${point.type === "click" ? "var(--color-primary)" : "var(--color-destructive)"} ${String(Math.round(40 + 50 * (point.count / peak)))}%, transparent) 0%, transparent 70%)`,
                      }}
                    />
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
