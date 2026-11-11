import type { QuerySpec, ResultOf } from "@cfanalytics/shared";
import type * as React from "react";
import { ErrorState, SkeletonRows } from "@/components/states.tsx";
import { useAnswer } from "@/lib/queries.ts";

// One query's answer inside a card: loading bars, a failure with a retry, or
// the result drawn by `children`. `kind` is the spec's kind, which decides the
// result's shape (ResultOf).

export function AnswerBody<K extends keyof ResultOf>({
  kind: _kind,
  projectId,
  spec,
  children,
}: {
  kind: K;
  projectId: string;
  spec: QuerySpec;
  children: (result: ResultOf[K]) => React.ReactNode;
}) {
  const answer = useAnswer<ResultOf[K]>(projectId, spec);
  if (answer.isError) {
    return <ErrorState error={answer.error} onRetry={() => void answer.refetch()} />;
  }
  if (answer.data === undefined) return <SkeletonRows rows={5} />;
  return children(answer.data.result);
}
