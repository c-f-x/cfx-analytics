import type { ScrollDepthResult } from "@cfanalytics/shared";
import { Link, useParams, useSearch } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useState } from "react";
import { Card, PageBody, PageHeader } from "@/components/page.tsx";
import { ErrorState, SkeletonRows } from "@/components/states.tsx";
import { buttonVariants } from "@/components/ui/button.tsx";
import { querySpecOf } from "@/lib/board.ts";
import { valueLabel } from "@/lib/labels.ts";
import { useAnswer } from "@/lib/queries.ts";
import { PeriodSelect } from "../board/controls.tsx";
import { ScrollView } from "../board/renderers.tsx";
import { RecordingsTable } from "../recordings/recordings.tsx";
import { Heatmap } from "./heatmap.tsx";

// One page: where its visitors click, how far they read, and the recordings
// that visited it (D-24).

const TABS = [
  { id: "heatmap", label: "Heatmap" },
  { id: "scroll", label: "Scroll depth" },
  { id: "recordings", label: "Recordings" },
] as const;

export function PageScreen() {
  const { projectId, page } = useParams({ from: "/p/$projectId/pages/$page" });
  const board = useSearch({ from: "/p/$projectId/pages/$page" });
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("heatmap");
  const path = valueLabel("page", page);
  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <Link
              to="/p/$projectId/pages"
              params={{ projectId }}
              search={board}
              className={buttonVariants({ variant: "ghost", size: "icon-sm" })}
              aria-label="Back to pages"
            >
              <ArrowLeft />
            </Link>
            <span className="truncate">{path}</span>
          </span>
        }
      >
        <PeriodSelect board={board} />
      </PageHeader>
      <PageBody>
        <div
          role="tablist"
          aria-label="About this page"
          className="inline-flex w-fit rounded-md bg-muted p-0.5"
        >
          {TABS.map((each) => (
            <button
              key={each.id}
              type="button"
              role="tab"
              aria-selected={tab === each.id}
              className="h-7 rounded px-3 font-medium text-[13px] text-muted-foreground aria-selected:bg-card aria-selected:text-foreground aria-selected:shadow-sm"
              onClick={() => setTab(each.id)}
            >
              {each.label}
            </button>
          ))}
        </div>
        <Card className="overflow-hidden pt-3">
          {tab === "heatmap" ? <Heatmap projectId={projectId} path={path} board={board} /> : null}
          {tab === "scroll" ? <Scroll projectId={projectId} path={path} board={board} /> : null}
          {tab === "recordings" ? (
            <RecordingsTable projectId={projectId} filters={{ page }} />
          ) : null}
        </Card>
      </PageBody>
    </>
  );
}

function Scroll({
  projectId,
  path,
  board,
}: {
  projectId: string;
  path: string;
  board: Parameters<typeof querySpecOf>[1];
}) {
  const answer = useAnswer<ScrollDepthResult>(
    projectId,
    querySpecOf({ kind: "scroll_depth", path }, board),
  );
  if (answer.isError)
    return <ErrorState error={answer.error} onRetry={() => void answer.refetch()} />;
  if (answer.data === undefined) return <SkeletonRows rows={10} />;
  return <ScrollView result={answer.data.result} />;
}
