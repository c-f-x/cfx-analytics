import type { RecordingSummary } from "@cfanalytics/shared";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { PlayCircle, X } from "lucide-react";
import { useState } from "react";
import { Card, PageBody, PageHeader } from "@/components/page.tsx";
import { EmptyState, ErrorState, SkeletonRows } from "@/components/states.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { api } from "@/lib/api.ts";
import { count, duration, moment } from "@/lib/format.ts";
import { pathOf } from "@/lib/labels.ts";

// Recorded sessions, newest first, narrowed by person, page, event and length
// (recordings-34); each row opens the player.

export interface RecordingFilters {
  person?: string | undefined;
  page?: string | undefined;
  event?: string | undefined;
  minDuration?: string | undefined;
}

function queryOf(filters: RecordingFilters, cursor: string | undefined): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (typeof value === "string" && value !== "") params.set(key, value);
  }
  if (cursor !== undefined) params.set("cursor", cursor);
  return params.toString();
}

export function RecordingsTable({
  projectId,
  filters,
}: {
  projectId: string;
  filters: RecordingFilters;
}) {
  const navigate = useNavigate();
  const list = useInfiniteQuery({
    queryKey: ["recordings", projectId, filters],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api<{ recordings: RecordingSummary[]; nextCursor?: string }>(
        `/api/projects/${projectId}/recordings?${queryOf(filters, pageParam)}`,
      ),
    getNextPageParam: (last) => last.nextCursor,
  });
  if (list.isError) return <ErrorState error={list.error} onRetry={() => void list.refetch()} />;
  if (list.data === undefined) return <SkeletonRows rows={6} />;
  const rows = list.data.pages.flatMap((page) => page.recordings);
  if (rows.length === 0) {
    return (
      <EmptyState icon={PlayCircle} title="No recordings match">
        Recordings arrive when session recording is on in Settings and a visitor agrees to it.
      </EmptyState>
    );
  }
  return (
    <div>
      <table className="w-full text-[13px]">
        <thead>
          <tr className="text-muted-foreground text-xs">
            <th className="px-4 py-1.5 text-left font-medium">Started</th>
            <th className="px-4 py-1.5 text-left font-medium">Person</th>
            <th className="px-4 py-1.5 text-left font-medium">Pages</th>
            <th className="px-4 py-1.5 text-right font-medium">Length</th>
            <th className="px-4 py-1.5 text-right font-medium">Active</th>
            <th className="px-4 py-1.5 text-right font-medium">Clicks</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.sessionId}
              tabIndex={0}
              className="h-10 cursor-pointer border-t outline-none hover:bg-muted/60 focus-visible:bg-muted/60"
              onClick={() =>
                void navigate({
                  to: "/p/$projectId/recordings/$sessionId",
                  params: { projectId, sessionId: row.sessionId },
                })
              }
              onKeyDown={(event) => {
                if (event.key === "Enter")
                  void navigate({
                    to: "/p/$projectId/recordings/$sessionId",
                    params: { projectId, sessionId: row.sessionId },
                  });
              }}
            >
              <td className="px-4 tabular-nums">{moment(row.startTs)}</td>
              <td className="max-w-40 truncate px-4 text-muted-foreground">
                {row.distinctId ?? "Anonymous"}
              </td>
              <td className="max-w-72 truncate px-4">
                {row.pages.length === 0 ? (
                  <span className="text-muted-foreground">{row.firstUrl ?? "–"}</span>
                ) : (
                  row.pages.map(pathOf).join(" · ")
                )}
              </td>
              <td className="px-4 text-right tabular-nums">{duration(row.durationMs)}</td>
              <td className="px-4 text-right text-muted-foreground tabular-nums">
                {duration(row.activeMs)}
              </td>
              <td className="px-4 text-right tabular-nums">{count(row.clicks)}</td>
            </tr>
          ))}
        </tbody>
      </table>
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

const LENGTHS = [
  { value: "", label: "Any length" },
  { value: "10000", label: "At least 10 s" },
  { value: "60000", label: "At least 1 min" },
  { value: "300000", label: "At least 5 min" },
];

export function RecordingsScreen() {
  const { projectId } = useParams({ from: "/p/$projectId/recordings" });
  const filters = useSearch({ from: "/p/$projectId/recordings" });
  const navigate = useNavigate();
  const [person, setPerson] = useState(filters.person ?? "");
  const [event, setEvent] = useState(filters.event ?? "");
  const set = (change: RecordingFilters) =>
    void navigate({
      to: ".",
      search: (previous: RecordingFilters) => ({ ...previous, ...change }),
    });
  const active = Object.values(filters).some((value) => value !== undefined);
  return (
    <>
      <PageHeader title="Recordings" />
      <PageBody>
        <form
          // A new address (Clear all, the back button) starts the fields afresh.
          key={JSON.stringify(filters)}
          className="flex flex-wrap items-center gap-2"
          onSubmit={(submit) => {
            submit.preventDefault();
            set({ person: person.trim() || undefined, event: event.trim() || undefined });
          }}
        >
          <Input
            aria-label="Person"
            placeholder="Person's id"
            className="w-56"
            value={person}
            onChange={(change) => setPerson(change.target.value)}
          />
          <Input
            aria-label="Event"
            placeholder="Has an event, such as signup"
            className="w-56"
            value={event}
            onChange={(change) => setEvent(change.target.value)}
          />
          <select
            aria-label="Length"
            className="h-8 rounded-md border bg-card px-2 text-[13px]"
            value={filters.minDuration ?? ""}
            onChange={(change) => set({ minDuration: change.target.value || undefined })}
          >
            {LENGTHS.map((length) => (
              <option key={length.value} value={length.value}>
                {length.label}
              </option>
            ))}
          </select>
          <Button type="submit">Apply</Button>
          {filters.page === undefined ? null : (
            <span className="inline-flex h-7 items-center gap-1.5 rounded-full border bg-card pr-1 pl-3 text-[12px]">
              <span className="text-muted-foreground">Page</span>
              <span className="font-medium">{pathOf(filters.page)}</span>
              <button
                type="button"
                className="rounded-full p-1 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/45"
                aria-label="Remove the page filter"
                onClick={() => set({ page: undefined })}
              >
                <X className="size-3" />
              </button>
            </span>
          )}
          {active ? (
            <Link
              to="/p/$projectId/recordings"
              params={{ projectId }}
              search={{}}
              className="rounded text-muted-foreground text-xs outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/45"
            >
              Clear all
            </Link>
          ) : null}
        </form>
        <Card>
          <RecordingsTable projectId={projectId} filters={filters} />
        </Card>
      </PageBody>
    </>
  );
}
