import {
  type EventsResult,
  missingStandardTiles,
  type Tile,
  type TrendResult,
} from "@cfanalytics/shared";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { LayoutGrid, MoreHorizontal, Plus } from "lucide-react";
import { useState } from "react";
import { LineChart } from "@/components/chart.tsx";
import { Card, CardHead, PageBody, PageHeader } from "@/components/page.tsx";
import { EmptyState, ErrorState, SkeletonRows } from "@/components/states.tsx";
import { buttonVariants } from "@/components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.tsx";
import { type BoardState, querySpecOf } from "@/lib/board.ts";
import { cn } from "@/lib/cn.ts";
import { change, count } from "@/lib/format.ts";
import { filterOf } from "@/lib/labels.ts";
import { periodOf } from "@/lib/period.ts";
import {
  useAnswer,
  useProject,
  useRemoveTile,
  useRestoreTiles,
  useTiles,
  useUpdateTile,
} from "@/lib/queries.ts";
import { AnswerBody } from "./answer.tsx";
import {
  CompareToggle,
  ExclusionNotice,
  FilterButton,
  FilterChips,
  PeriodSelect,
  useBoardNavigate,
} from "./controls.tsx";
import { InstallPanel } from "./install.tsx";
import {
  EventsView,
  FunnelView,
  PropertiesView,
  RetentionView,
  ScrollView,
  TopView,
  TrendView,
} from "./renderers.tsx";

// The board (D-24): the product's tiles under one period and one set of
// filters. The standard trend tiles at its head read as one card of numbers
// over a chart; every other tile is its own card.

/** The leading standard trend tiles, which read together as the headline. */
function headlineOf(tiles: readonly Tile[]): Tile[] {
  const head: Tile[] = [];
  for (const tile of tiles) {
    if (!tile.standard || tile.spec.kind !== "trend") break;
    head.push(tile);
  }
  return head;
}

function Stat({
  tile,
  board,
  projectId,
  selected,
  onSelect,
}: {
  tile: Tile;
  board: BoardState;
  projectId: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const answer = useAnswer<TrendResult>(projectId, querySpecOf(tile.spec, board));
  const series = answer.data?.result.series[0];
  const delta = series?.change;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "flex flex-col items-start gap-0.5 border-r px-5 py-4 text-left outline-none last:border-r-0 hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring/45 focus-visible:ring-inset",
        selected && "shadow-[inset_0_-2px_0_var(--color-primary)]",
      )}
    >
      <span className="font-medium text-[13px] text-muted-foreground">{tile.title}</span>
      <span className="flex items-baseline gap-2">
        <span className="font-semibold text-[28px] leading-9 tracking-tight tabular-nums">
          {series === undefined ? "–" : count(series.total)}
        </span>
        {delta === undefined || series === undefined ? null : (
          <span
            className={cn(
              "font-medium text-[13px] tabular-nums",
              delta === null || delta >= 0 ? "text-success" : "text-destructive",
            )}
          >
            {change(delta)}
          </span>
        )}
      </span>
    </button>
  );
}

function Headline({
  tiles,
  board,
  projectId,
}: {
  tiles: Tile[];
  board: BoardState;
  projectId: string;
}) {
  const [selected, setSelected] = useState(0);
  const tile = tiles[selected] ?? tiles[0];
  const answer = useAnswer<TrendResult>(
    projectId,
    tile === undefined ? null : querySpecOf(tile.spec, board),
  );
  if (tile === undefined) return null;
  const series = answer.data?.result.series[0];
  const previous = answer.data?.result.previous?.series[0];
  return (
    <Card>
      <div
        className="grid border-b"
        style={{ gridTemplateColumns: `repeat(${String(tiles.length)}, minmax(0, 1fr))` }}
      >
        {tiles.map((each, index) => (
          <Stat
            key={each.id}
            tile={each}
            board={board}
            projectId={projectId}
            selected={index === selected}
            onSelect={() => setSelected(index)}
          />
        ))}
      </div>
      <div className="px-5 pt-3 pb-2">
        <div className="mb-1 flex gap-4 text-muted-foreground text-xs">
          <span className="flex items-center gap-1.5">
            <span className="h-0.5 w-3 rounded bg-primary" />
            {periodOf(board.period).label}
          </span>
          {previous === undefined ? null : (
            <span className="flex items-center gap-1.5">
              <span className="h-0.5 w-3 rounded bg-muted-foreground/60" />
              The period before
            </span>
          )}
        </div>
        {answer.isError ? (
          <ErrorState error={answer.error} onRetry={() => void answer.refetch()} />
        ) : series === undefined ? (
          <SkeletonRows rows={4} />
        ) : (
          <LineChart
            labels={answer.data?.result.buckets ?? []}
            values={series.values}
            previous={previous?.values}
            label={`${tile.title} per bucket`}
          />
        )}
      </div>
    </Card>
  );
}

function TileBody({
  tile,
  board,
  projectId,
}: {
  tile: Tile;
  board: BoardState;
  projectId: string;
}) {
  const set = useBoardNavigate();
  const navigate = useNavigate();
  const spec = tile.spec;
  const query = querySpecOf(spec, board);
  const body = { projectId, spec: query };
  if (spec.kind === "trend") {
    return (
      <AnswerBody kind="trend" {...body}>
        {(result) => <TrendView spec={spec} result={result} />}
      </AnswerBody>
    );
  }
  if (spec.kind === "top") {
    const dimension = spec.dimension;
    const onPick =
      "builtin" in dimension && dimension.builtin !== "browser_version"
        ? (key: string) => {
            const chip = filterOf(dimension.builtin, key);
            if (chip !== null) set({ filters: [...board.filters, chip] });
          }
        : undefined;
    // "Open page" on a page row goes to that page in Pages (D-24).
    const onOpen =
      "builtin" in dimension && dimension.builtin === "page"
        ? (page: string) =>
            void navigate({
              to: "/p/$projectId/pages/$page",
              params: { projectId, page },
              search: board,
            })
        : undefined;
    return (
      <AnswerBody kind="top" {...body}>
        {(result) => <TopView spec={spec} result={result} onPick={onPick} onOpen={onOpen} />}
      </AnswerBody>
    );
  }
  if (spec.kind === "funnel") {
    return (
      <AnswerBody kind="funnel" {...body}>
        {(result) => <FunnelView spec={spec} result={result} />}
      </AnswerBody>
    );
  }
  if (spec.kind === "retention") {
    return (
      <AnswerBody kind="retention" {...body}>
        {(result) => <RetentionView result={result} />}
      </AnswerBody>
    );
  }
  if (spec.kind === "scroll_depth") {
    return (
      <AnswerBody kind="scroll_depth" {...body}>
        {(result) => <ScrollView result={result} />}
      </AnswerBody>
    );
  }
  if (spec.kind === "events") {
    return (
      <AnswerBody kind="events" {...body}>
        {(result) => <EventsView result={result} />}
      </AnswerBody>
    );
  }
  // The last kind left; a new kind makes this line fail to typecheck until it has its own body.
  const properties: Extract<Tile["spec"], { kind: "properties" }> = spec;
  return (
    <AnswerBody kind="properties" projectId={projectId} spec={querySpecOf(properties, board)}>
      {(result) => <PropertiesView result={result} />}
    </AnswerBody>
  );
}

const WIDE = new Set(["funnel", "retention", "events"]);

function TileCard({
  tile,
  index,
  last,
  board,
  projectId,
}: {
  tile: Tile;
  index: number;
  last: boolean;
  board: BoardState;
  projectId: string;
}) {
  const navigate = useNavigate();
  const update = useUpdateTile(projectId);
  const remove = useRemoveTile(projectId);
  return (
    <Card className={cn("flex flex-col", WIDE.has(tile.spec.kind) && "md:col-span-2")}>
      <CardHead title={tile.title}>
        {tile.standard ? null : (
          <span className="rounded-full border px-2 text-[11px] text-muted-foreground leading-5">
            Saved
          </span>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger
            className={buttonVariants({ variant: "ghost", size: "icon-sm" })}
            aria-label={`${tile.title}: more`}
          >
            <MoreHorizontal />
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem
              onClick={() =>
                void navigate({
                  to: "/p/$projectId/questions/$tileId",
                  params: { projectId, tileId: tile.id },
                  search: board,
                })
              }
            >
              Open question
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={index === 0}
              onClick={() => update.mutate({ id: tile.id, position: index - 1 })}
            >
              Move up
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={last}
              onClick={() => update.mutate({ id: tile.id, position: index + 1 })}
            >
              Move down
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => remove.mutate(tile.id)}>
              Remove from board
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </CardHead>
      <div className="min-h-0 flex-1">
        <TileBody tile={tile} board={board} projectId={projectId} />
      </div>
    </Card>
  );
}

/** Whether the product has ever received an event, read once over its whole retention. */
function useHasEvents(projectId: string): boolean | null {
  const answer = useAnswer<EventsResult>(projectId, {
    kind: "events",
    range: { kind: "last_days", days: 3650 },
    limit: 1,
    includeBots: true,
    includeInternal: true,
  });
  if (answer.data === undefined) return null;
  return answer.data.result.rows.length > 0;
}

export function BoardScreen() {
  const { projectId } = useParams({ from: "/p/$projectId/" });
  const board = useSearch({ from: "/p/$projectId/" });
  const tiles = useTiles(projectId);
  const project = useProject(projectId);
  const restore = useRestoreTiles(projectId);
  const hasEvents = useHasEvents(projectId);

  const list = tiles.data ?? [];
  const headline = headlineOf(list);
  const rest = list.slice(headline.length);
  // The Worker's restore uses the same rule, so the link shows only when restoring adds a tile.
  const missingStandard = tiles.data !== undefined && missingStandardTiles(list).length > 0;

  return (
    <>
      <PageHeader title="Board">
        <PeriodSelect board={board} />
        <CompareToggle board={board} />
        <FilterButton board={board} />
        <Link
          to="/p/$projectId/questions/new"
          params={{ projectId }}
          search={board}
          className={buttonVariants({ variant: "primary" })}
        >
          <Plus />
          Add question
        </Link>
      </PageHeader>
      <PageBody>
        <div className="flex flex-wrap items-center justify-between gap-3">
          {hasEvents === false ? null : <ExclusionNotice board={board} />}
          {missingStandard ? (
            <button
              type="button"
              className="rounded font-medium text-primary text-[13px] outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/45"
              onClick={() => restore.mutate()}
            >
              Restore standard tiles
            </button>
          ) : null}
        </div>
        <FilterChips board={board} />
        {tiles.isError ? (
          <Card>
            <ErrorState error={tiles.error} onRetry={() => void tiles.refetch()} />
          </Card>
        ) : tiles.isPending ? (
          <Card>
            <SkeletonRows rows={6} />
          </Card>
        ) : hasEvents === false && project.data !== undefined ? (
          <InstallPanel project={project.data} />
        ) : list.length === 0 ? (
          <Card>
            <EmptyState
              icon={LayoutGrid}
              title="This board is empty"
              action={
                <button
                  type="button"
                  className={buttonVariants({ variant: "primary" })}
                  onClick={() => restore.mutate()}
                >
                  Restore standard tiles
                </button>
              }
            >
              Add a question, or bring back the standard tiles.
            </EmptyState>
          </Card>
        ) : (
          <>
            {headline.length > 0 ? (
              <Headline tiles={headline} board={board} projectId={projectId} />
            ) : null}
            <div className="grid gap-4 md:grid-cols-2">
              {rest.map((tile, index) => (
                <TileCard
                  key={tile.id}
                  tile={tile}
                  index={headline.length + index}
                  last={index === rest.length - 1}
                  board={board}
                  projectId={projectId}
                />
              ))}
            </div>
          </>
        )}
      </PageBody>
    </>
  );
}
