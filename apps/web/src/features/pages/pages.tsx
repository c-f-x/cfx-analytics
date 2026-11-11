import type { TopResult } from "@cfanalytics/shared";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { FileText } from "lucide-react";
import { RankedRows } from "@/components/chart.tsx";
import { Card, PageBody, PageHeader } from "@/components/page.tsx";
import { EmptyState, ErrorState, SkeletonRows } from "@/components/states.tsx";
import { querySpecOf } from "@/lib/board.ts";
import { valueLabel } from "@/lib/labels.ts";
import { useAnswer } from "@/lib/queries.ts";
import { ExclusionNotice, FilterChips, PeriodSelect } from "../board/controls.tsx";

// Every page of the product, ranked by visitors. A page opens on its
// heatmap, how far it is read, and its recordings.

export function PagesScreen() {
  const { projectId } = useParams({ from: "/p/$projectId/pages" });
  const board = useSearch({ from: "/p/$projectId/pages" });
  const navigate = useNavigate();
  const answer = useAnswer<TopResult>(
    projectId,
    querySpecOf(
      {
        kind: "top",
        event: "$pageview",
        dimension: { builtin: "page" },
        measure: "visitors",
        limit: 100,
      },
      board,
    ),
  );
  const rows = answer.data?.result.rows ?? [];
  return (
    <>
      <PageHeader title="Pages">
        <PeriodSelect board={board} />
      </PageHeader>
      <PageBody>
        <ExclusionNotice board={board} />
        <FilterChips board={board} />
        <Card>
          {answer.isError ? (
            <ErrorState error={answer.error} onRetry={() => void answer.refetch()} />
          ) : answer.data === undefined ? (
            <SkeletonRows rows={8} />
          ) : rows.length === 0 ? (
            <EmptyState icon={FileText} title="No page was viewed in this period">
              Pages appear here as $pageview events arrive.
            </EmptyState>
          ) : (
            <RankedRows
              heading="Page"
              measure="Visitors"
              rows={rows
                .filter((row) => typeof row.key === "string")
                .map((row) => ({
                  key: String(row.key),
                  label: valueLabel("page", row.key),
                  value: row.count,
                }))}
              onPick={(key) =>
                void navigate({
                  to: "/p/$projectId/pages/$page",
                  params: { projectId, page: key },
                  search: board,
                })
              }
            />
          )}
        </Card>
      </PageBody>
    </>
  );
}
