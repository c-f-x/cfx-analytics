import type { EventsResult, PropertiesResult } from "@cfanalytics/shared";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useParams, useSearch } from "@tanstack/react-router";
import { ChevronRight, List } from "lucide-react";
import { useState } from "react";
import { Card, PageBody, PageHeader } from "@/components/page.tsx";
import { EmptyState, ErrorState, SkeletonRows } from "@/components/states.tsx";
import { Button } from "@/components/ui/button.tsx";
import { api } from "@/lib/api.ts";
import { type BoardState, querySpecOf } from "@/lib/board.ts";
import { cn } from "@/lib/cn.ts";
import { count, moment } from "@/lib/format.ts";
import { useAnswer } from "@/lib/queries.ts";
import { ExclusionNotice, FilterChips, PeriodSelect } from "../board/controls.tsx";

// The raw events, newest first, each opening to its properties; and every
// property name the product has sent (query-51).

function EventList({ projectId, board }: { projectId: string; board: BoardState }) {
  const [open, setOpen] = useState<string | null>(null);
  const spec = querySpecOf({ kind: "events", limit: 50 }, board);
  const list = useInfiniteQuery({
    queryKey: ["events", projectId, spec],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api<{ result: EventsResult }>(`/api/projects/${projectId}/query`, {
        method: "POST",
        body: pageParam === undefined ? spec : { ...spec, cursor: pageParam },
      }),
    getNextPageParam: (last) => last.result.nextCursor,
  });
  if (list.isError) return <ErrorState error={list.error} onRetry={() => void list.refetch()} />;
  if (list.data === undefined) return <SkeletonRows rows={10} />;
  const rows = list.data.pages.flatMap((page) => page.result.rows);
  if (rows.length === 0) {
    return (
      <EmptyState icon={List} title="No events in this period">
        Events appear here a moment after an SDK sends them.
      </EmptyState>
    );
  }
  return (
    <div>
      <ul>
        {rows.map((row) => (
          <li key={row.uuid} className="border-t first:border-t-0">
            <button
              type="button"
              aria-expanded={open === row.uuid}
              className="flex h-10 w-full items-center gap-3 px-4 text-left text-[13px] outline-none hover:bg-muted/60 focus-visible:bg-muted/60"
              onClick={() => setOpen(open === row.uuid ? null : row.uuid)}
            >
              <ChevronRight
                className={cn(
                  "size-3.5 shrink-0 text-muted-foreground transition-transform",
                  open === row.uuid && "rotate-90",
                )}
              />
              <span className="w-32 shrink-0 text-muted-foreground tabular-nums">
                {moment(row.ts)}
              </span>
              <span className="w-48 shrink-0 truncate font-medium">{row.event}</span>
              <span className="truncate text-muted-foreground">{row.distinctId}</span>
            </button>
            {open === row.uuid ? (
              <dl className="grid grid-cols-[minmax(0,200px)_1fr] gap-x-4 gap-y-1 bg-muted/40 px-11 py-3 font-mono text-[12px]">
                {Object.entries(row.properties).map(([key, value]) => (
                  <div key={key} className="contents">
                    <dt className="truncate text-muted-foreground">{key}</dt>
                    <dd className="break-all">
                      {typeof value === "string" ? value : JSON.stringify(value)}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </li>
        ))}
      </ul>
      {list.hasNextPage ? (
        <div className="border-t p-3 text-center">
          <Button
            size="sm"
            disabled={list.isFetchingNextPage}
            onClick={() => void list.fetchNextPage()}
          >
            Show more
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function Properties({ projectId, board }: { projectId: string; board: BoardState }) {
  const answer = useAnswer<PropertiesResult>(projectId, querySpecOf({ kind: "properties" }, board));
  if (answer.isError)
    return <ErrorState error={answer.error} onRetry={() => void answer.refetch()} />;
  if (answer.data === undefined) return <SkeletonRows rows={10} />;
  const result = answer.data.result;
  if (result.properties.length === 0) {
    return (
      <EmptyState icon={List} title="No properties in this period">
        Properties appear as events carry them.
      </EmptyState>
    );
  }
  return (
    <div>
      <p className="px-4 pb-2 text-muted-foreground text-xs">
        From the newest {count(result.events)} events of the period.
      </p>
      <table className="w-full text-[13px]">
        <thead>
          <tr className="text-muted-foreground text-xs">
            <th className="px-4 py-1.5 text-left font-medium">Property</th>
            <th className="px-4 py-1.5 text-left font-medium">Types</th>
            <th className="px-4 py-1.5 text-right font-medium">Events</th>
          </tr>
        </thead>
        <tbody>
          {result.properties.map((property) => (
            <tr key={property.name} className="h-8 border-t">
              <td className="px-4 font-mono text-[12px]">{property.name}</td>
              <td className="px-4 text-muted-foreground">
                {property.types.map((type) => type.type).join(", ")}
              </td>
              <td className="px-4 text-right tabular-nums">
                {count(property.types.reduce((sum, type) => sum + type.count, 0))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function EventsScreen() {
  const { projectId } = useParams({ from: "/p/$projectId/events" });
  const board = useSearch({ from: "/p/$projectId/events" });
  const [tab, setTab] = useState<"events" | "properties">("events");
  return (
    <>
      <PageHeader title="Events">
        <PeriodSelect board={board} />
      </PageHeader>
      <PageBody>
        <div className="flex flex-wrap items-center gap-3">
          <div role="tablist" aria-label="Show" className="inline-flex rounded-md bg-muted p-0.5">
            {(["events", "properties"] as const).map((each) => (
              <button
                key={each}
                type="button"
                role="tab"
                aria-selected={tab === each}
                className="h-7 rounded px-3 font-medium text-[13px] text-muted-foreground capitalize aria-selected:bg-card aria-selected:text-foreground aria-selected:shadow-sm"
                onClick={() => setTab(each)}
              >
                {each === "events" ? "Events" : "Properties"}
              </button>
            ))}
          </div>
          <ExclusionNotice board={board} />
        </div>
        <FilterChips board={board} />
        <Card className="pt-2">
          {tab === "events" ? (
            <EventList projectId={projectId} board={board} />
          ) : (
            <Properties projectId={projectId} board={board} />
          )}
        </Card>
      </PageBody>
    </>
  );
}
