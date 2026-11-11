import {
  type BuiltinDimension,
  builtinDimension,
  type Dimension,
  retentionSpec,
  type TileSpec,
  type TopResult,
  tileSpec,
  topSpec,
  trendSpec,
} from "@cfanalytics/shared";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { ArrowLeft, Plus, Trash2, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Card, PageBody, PageHeader } from "@/components/page.tsx";
import { ErrorState, SkeletonRows } from "@/components/states.tsx";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.tsx";
import { type BoardState, boardFrom, querySpecOf } from "@/lib/board.ts";
import { oneOf } from "@/lib/choice.ts";
import { DIMENSION_LABELS } from "@/lib/labels.ts";
import { useAddTile, useAnswer, useRemoveTile, useTiles, useUpdateTile } from "@/lib/queries.ts";
import { AnswerBody } from "../board/answer.tsx";
import { PeriodSelect } from "../board/controls.tsx";
import { FunnelView, RetentionView, TopView, TrendView } from "../board/renderers.tsx";

// The question editor: one question, built field by field, with its answer
// under the board's period as it changes. "Save to board" is the one primary
// action; a saved question can be deleted here too.

type Kind = "trend" | "top" | "funnel" | "retention";

const KINDS: { kind: Kind; label: string }[] = [
  { kind: "trend", label: "Trend" },
  { kind: "top", label: "Ranked list" },
  { kind: "funnel", label: "Funnel" },
  { kind: "retention", label: "Retention" },
];

const DIMENSIONS: BuiltinDimension[] = [
  "channel",
  "page",
  "referring_domain",
  "country",
  "device_type",
  "browser",
  "os",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "event",
];

const WINDOWS = [
  { ms: 3_600_000, label: "1 hour" },
  { ms: 86_400_000, label: "1 day" },
  { ms: 604_800_000, label: "7 days" },
  { ms: 2_592_000_000, label: "30 days" },
];

function blank(kind: Kind): TileSpec {
  if (kind === "trend") return { kind, measure: "visitors", granularity: "day", compare: true };
  if (kind === "top") return { kind, dimension: { builtin: "page" }, measure: "visitors" };
  if (kind === "funnel") {
    return {
      kind,
      windowMs: 86_400_000,
      steps: [
        { id: "step-1", event: "$pageview" },
        { id: "step-2", event: "$pageleave" },
      ],
    };
  }
  return { kind: "retention", granularity: "week" };
}

function builtinOf(dimension: Dimension | undefined): string {
  return dimension !== undefined && "builtin" in dimension ? dimension.builtin : "none";
}

function Field({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}

function Choice({
  id,
  value,
  onChange,
  options,
  className,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  className?: string;
}) {
  return (
    <Select value={value} onValueChange={(next) => onChange(String(next))}>
      <SelectTrigger id={id} className={className ?? "w-56"}>
        <SelectValue>
          {options.find((option) => option.value === value)?.label ?? value}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

const dimensionOptions = (withNone: boolean) => [
  ...(withNone ? [{ value: "none", label: "Nothing" }] : []),
  ...DIMENSIONS.map((dimension) => ({ value: dimension, label: DIMENSION_LABELS[dimension] })),
];

export function EditorScreen() {
  const params = useParams({ strict: false });
  const projectId = params.projectId ?? "";
  const tileId = params.tileId;
  const board = boardFrom(useSearch({ strict: false }));
  const navigate = useNavigate();
  const tiles = useTiles(projectId);
  const existing =
    tileId === undefined ? undefined : tiles.data?.find((tile) => tile.id === tileId);
  if (tileId !== undefined && tiles.isPending)
    return <SkeletonRows rows={6} className="mx-auto max-w-3xl pt-20" />;
  if (tileId !== undefined && existing === undefined) {
    return (
      <ErrorState
        error={new Error("This question is not on the board any more.")}
        className="pt-24"
      />
    );
  }
  return (
    <Editor
      key={tileId ?? "new"}
      projectId={projectId}
      board={board}
      initial={
        existing === undefined
          ? null
          : { id: existing.id, title: existing.title, spec: existing.spec }
      }
      onDone={() => void navigate({ to: "/p/$projectId", params: { projectId }, search: board })}
    />
  );
}

function Editor({
  projectId,
  board,
  initial,
  onDone,
}: {
  projectId: string;
  board: BoardState;
  initial: { id: string; title: string; spec: TileSpec } | null;
  onDone: () => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [spec, setSpec] = useState<TileSpec>(initial?.spec ?? blank("trend"));
  const add = useAddTile(projectId);
  const update = useUpdateTile(projectId);
  const remove = useRemoveTile(projectId);
  const events = useAnswer<TopResult>(projectId, {
    kind: "top",
    range: { kind: "last_days", days: 90 },
    dimension: { builtin: "event" },
    measure: "events",
    limit: 100,
  });
  const eventNames = (events.data?.result.rows ?? [])
    .map((row) => String(row.key))
    .filter((name) => name !== "null");
  const eventOptions = (eventNames.length > 0 ? eventNames : ["$pageview"]).map((name) => ({
    value: name,
    label: name,
  }));
  const valid = tileSpec.safeParse(spec).success && title.trim() !== "";
  const busy = add.isPending || update.isPending || remove.isPending;

  const save = async () => {
    try {
      if (initial === null) await add.mutateAsync({ title: title.trim(), spec });
      else await update.mutateAsync({ id: initial.id, title: title.trim(), spec });
      toast(initial === null ? "Saved to the board" : "Saved");
      onDone();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The question could not be saved.");
    }
  };

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <Link
              to="/p/$projectId"
              params={{ projectId }}
              search={board}
              className={buttonVariants({ variant: "ghost", size: "icon-sm" })}
              aria-label="Back to the board"
            >
              <ArrowLeft />
            </Link>
            {initial === null ? "New question" : initial.title}
          </span>
        }
      >
        <PeriodSelect board={board} />
        {initial === null ? null : (
          <Button
            disabled={busy}
            onClick={() =>
              void remove
                .mutateAsync(initial.id)
                .then(onDone, (error: unknown) =>
                  toast.error(
                    error instanceof Error ? error.message : "The question could not be deleted.",
                  ),
                )
            }
          >
            <Trash2 className="text-muted-foreground" />
            Delete
          </Button>
        )}
        <Button onClick={onDone} disabled={busy}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!valid || busy} onClick={() => void save()}>
          Save to board
        </Button>
      </PageHeader>
      <PageBody>
        <Card className="flex flex-col gap-5 p-5">
          <Field id="title" label="Title">
            <Input
              id="title"
              className="max-w-md"
              value={title}
              placeholder="Demo to waitlist"
              onChange={(event) => setTitle(event.target.value)}
            />
          </Field>
          <div
            role="tablist"
            aria-label="Kind of question"
            className="inline-flex w-fit rounded-md bg-muted p-0.5"
          >
            {KINDS.map((option) => (
              <button
                key={option.kind}
                type="button"
                role="tab"
                aria-selected={spec.kind === option.kind}
                className="h-7 rounded px-3 font-medium text-[13px] text-muted-foreground aria-selected:bg-card aria-selected:text-foreground aria-selected:shadow-sm"
                onClick={() => setSpec(blank(option.kind))}
              >
                {option.label}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-4">
            {spec.kind === "trend" ? (
              <>
                <Field id="measure" label="Count">
                  <Choice
                    id="measure"
                    value={spec.measure}
                    onChange={(value) => {
                      const measure = oneOf(trendSpec.shape.measure.options, value);
                      if (measure !== undefined) setSpec({ ...spec, measure });
                    }}
                    options={[
                      { value: "visitors", label: "Visitors" },
                      { value: "events", label: "Events" },
                      { value: "sessions", label: "Sessions" },
                    ]}
                    className="w-40"
                  />
                </Field>
                <Field id="event" label="Of">
                  <Choice
                    id="event"
                    value={spec.event ?? "any"}
                    onChange={(event) => {
                      const { event: _old, ...rest } = spec;
                      setSpec(event === "any" ? rest : { ...rest, event });
                    }}
                    options={[{ value: "any", label: "Any event" }, ...eventOptions]}
                  />
                </Field>
                <Field id="breakdown" label="Split by">
                  <Choice
                    id="breakdown"
                    value={builtinOf(spec.breakdown)}
                    onChange={(value) => {
                      const { breakdown: _old, ...rest } = spec;
                      const builtin = oneOf(builtinDimension.options, value);
                      setSpec(builtin === undefined ? rest : { ...rest, breakdown: { builtin } });
                    }}
                    options={dimensionOptions(true)}
                  />
                </Field>
              </>
            ) : null}
            {spec.kind === "top" ? (
              <>
                <Field id="dimension" label="Rank">
                  <Choice
                    id="dimension"
                    value={builtinOf(spec.dimension)}
                    onChange={(value) => {
                      const builtin = oneOf(builtinDimension.options, value);
                      if (builtin !== undefined) setSpec({ ...spec, dimension: { builtin } });
                    }}
                    options={dimensionOptions(false)}
                  />
                </Field>
                <Field id="top-measure" label="By">
                  <Choice
                    id="top-measure"
                    value={spec.measure}
                    onChange={(value) => {
                      const measure = oneOf(topSpec.shape.measure.options, value);
                      if (measure !== undefined) setSpec({ ...spec, measure });
                    }}
                    options={[
                      { value: "visitors", label: "Visitors" },
                      { value: "events", label: "Events" },
                    ]}
                    className="w-40"
                  />
                </Field>
              </>
            ) : null}
            {spec.kind === "retention" ? (
              <>
                <Field id="start" label="Starts with">
                  <Choice
                    id="start"
                    value={spec.startEvent ?? "any"}
                    onChange={(value) => {
                      const { startEvent: _old, ...rest } = spec;
                      setSpec(value === "any" ? rest : { ...rest, startEvent: value });
                    }}
                    options={[{ value: "any", label: "Any event" }, ...eventOptions]}
                  />
                </Field>
                <Field id="return" label="Comes back with">
                  <Choice
                    id="return"
                    value={spec.returnEvent ?? "any"}
                    onChange={(value) => {
                      const { returnEvent: _old, ...rest } = spec;
                      setSpec(value === "any" ? rest : { ...rest, returnEvent: value });
                    }}
                    options={[{ value: "any", label: "Any event" }, ...eventOptions]}
                  />
                </Field>
                <Field id="cohort" label="Cohorts by">
                  <Choice
                    id="cohort"
                    value={spec.granularity}
                    onChange={(value) => {
                      const granularity = oneOf(retentionSpec.shape.granularity.options, value);
                      if (granularity !== undefined) setSpec({ ...spec, granularity });
                    }}
                    options={[
                      { value: "day", label: "Day" },
                      { value: "week", label: "Week" },
                      { value: "month", label: "Month" },
                    ]}
                    className="w-32"
                  />
                </Field>
              </>
            ) : null}
          </div>
          {spec.kind === "funnel" ? (
            <div className="flex flex-col gap-3">
              <p className="font-medium text-[13px]">Steps, in order</p>
              <ol className="flex flex-col gap-2">
                {spec.steps.map((step, index) => (
                  <li key={step.id} className="flex items-center gap-2">
                    <span className="w-6 text-right text-muted-foreground text-xs tabular-nums">
                      {index + 1}
                    </span>
                    <Choice
                      id={`step-${String(index)}`}
                      value={step.event}
                      onChange={(event) =>
                        setSpec({
                          ...spec,
                          steps: spec.steps.map((each, at) =>
                            at === index ? { ...each, event } : each,
                          ),
                        })
                      }
                      options={
                        eventOptions.some((option) => option.value === step.event)
                          ? eventOptions
                          : [{ value: step.event, label: step.event }, ...eventOptions]
                      }
                    />
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`Remove step ${String(index + 1)}`}
                      disabled={spec.steps.length <= 2}
                      onClick={() =>
                        setSpec({ ...spec, steps: spec.steps.filter((_each, at) => at !== index) })
                      }
                    >
                      <X />
                    </Button>
                  </li>
                ))}
              </ol>
              <div className="flex flex-wrap items-end gap-4">
                <Button
                  size="sm"
                  disabled={spec.steps.length >= 10}
                  onClick={() =>
                    setSpec({
                      ...spec,
                      steps: [
                        ...spec.steps,
                        {
                          id: `step-${String(Date.now())}`,
                          event: eventOptions[0]?.value ?? "$pageview",
                        },
                      ],
                    })
                  }
                >
                  <Plus />
                  Add step
                </Button>
                <Field id="window" label="All steps within">
                  <Choice
                    id="window"
                    value={String(spec.windowMs)}
                    onChange={(value) => setSpec({ ...spec, windowMs: Number(value) })}
                    options={WINDOWS.map((window) => ({
                      value: String(window.ms),
                      label: window.label,
                    }))}
                    className="w-32"
                  />
                </Field>
                <Field id="funnel-split" label="Split by">
                  <Choice
                    id="funnel-split"
                    value={builtinOf(spec.breakdown)}
                    onChange={(value) => {
                      const { breakdown: _old, ...rest } = spec;
                      const builtin = oneOf(builtinDimension.options, value);
                      setSpec(builtin === undefined ? rest : { ...rest, breakdown: { builtin } });
                    }}
                    options={dimensionOptions(true)}
                  />
                </Field>
              </div>
            </div>
          ) : null}
        </Card>
        <Preview projectId={projectId} spec={spec} board={board} />
      </PageBody>
    </>
  );
}

function Preview({
  projectId,
  spec,
  board,
}: {
  projectId: string;
  spec: TileSpec;
  board: BoardState;
}) {
  const valid = tileSpec.safeParse(spec).success;
  const body = { projectId, spec: querySpecOf(spec, board) };
  return (
    <Card>
      <div className="flex h-11 items-center px-4 pt-1">
        <h2 className="font-semibold text-[13px]">Answer</h2>
      </div>
      {!valid ? (
        <p className="px-4 pb-6 text-muted-foreground text-[13px]">
          Fill in every field to see the answer.
        </p>
      ) : spec.kind === "trend" ? (
        <AnswerBody kind="trend" {...body}>
          {(result) => <TrendView spec={spec} result={result} />}
        </AnswerBody>
      ) : spec.kind === "top" ? (
        <AnswerBody kind="top" {...body}>
          {(result) => <TopView spec={spec} result={result} />}
        </AnswerBody>
      ) : spec.kind === "funnel" ? (
        <AnswerBody kind="funnel" {...body}>
          {(result) => <FunnelView spec={spec} result={result} />}
        </AnswerBody>
      ) : spec.kind === "retention" ? (
        <AnswerBody kind="retention" {...body}>
          {(result) => <RetentionView result={result} />}
        </AnswerBody>
      ) : null}
    </Card>
  );
}
