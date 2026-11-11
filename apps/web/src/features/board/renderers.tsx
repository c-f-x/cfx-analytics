import type {
  BuiltinDimension,
  EventsResult,
  FunnelResult,
  PropertiesResult,
  RetentionResult,
  ScrollDepthResult,
  TileSpec,
  TopResult,
  TrendResult,
} from "@cfanalytics/shared";
import { Inbox } from "lucide-react";
import { LineChart, RankedRows } from "@/components/chart.tsx";
import { EmptyState } from "@/components/states.tsx";
import { count, moment, percent } from "@/lib/format.ts";
import { DIMENSION_LABELS, valueLabel } from "@/lib/labels.ts";

// One renderer per query kind: the answer drawn as the question reads best.
// Every renderer has its own empty state; loading and failure are the tile's.

const MEASURES = { events: "Events", visitors: "Visitors", sessions: "Sessions" } as const;

function builtinOf(spec: TileSpec): BuiltinDimension | null {
  if (
    spec.kind === "top" &&
    "builtin" in spec.dimension &&
    spec.dimension.builtin !== "browser_version"
  ) {
    return spec.dimension.builtin;
  }
  return null;
}

function NoData({ children }: { children: string }) {
  return (
    <EmptyState icon={Inbox} title="Nothing in this period" className="py-8">
      {children}
    </EmptyState>
  );
}

export function TrendView({
  spec,
  result,
}: {
  spec: Extract<TileSpec, { kind: "trend" }>;
  result: TrendResult;
}) {
  const [first] = result.series;
  if (first === undefined || result.series.every((series) => series.total === 0)) {
    return <NoData>No events fell in this period.</NoData>;
  }
  const previous = result.previous?.series.find((series) => series.key === first.key);
  return (
    <div className="px-4 pb-3">
      <LineChart
        labels={result.buckets}
        values={first.values}
        previous={previous?.values}
        label={`${MEASURES[spec.measure]} per bucket`}
      />
      {result.series.length > 1 ? (
        <RankedRows
          heading="Value"
          measure={MEASURES[spec.measure]}
          rows={result.series.map((series) => ({
            key: String(series.key),
            label: series.other ? "Other" : valueLabel(null, series.key),
            value: series.total,
          }))}
        />
      ) : null}
    </div>
  );
}

export function TopView({
  spec,
  result,
  onPick,
  onOpen,
}: {
  spec: Extract<TileSpec, { kind: "top" }>;
  result: TopResult;
  onPick?: ((key: string) => void) | undefined;
  onOpen?: ((key: string) => void) | undefined;
}) {
  if (result.rows.length === 0)
    return <NoData>No visitor carried this property in this period.</NoData>;
  const dimension = builtinOf(spec);
  const heading =
    dimension === null
      ? "property" in spec.dimension
        ? spec.dimension.property.name
        : "Version"
      : DIMENSION_LABELS[dimension];
  return (
    <RankedRows
      heading={heading}
      measure={spec.measure === "visitors" ? "Visitors" : "Events"}
      onPick={onPick}
      onOpen={onOpen}
      rows={result.rows.slice(0, 8).map((row) => ({
        key: String(row.key),
        label: valueLabel(dimension, row.key),
        value: row.count,
      }))}
    />
  );
}

export function FunnelView({
  spec,
  result,
}: {
  spec: Extract<TileSpec, { kind: "funnel" }>;
  result: FunnelResult;
}) {
  const entered = result.steps[0]?.count ?? 0;
  if (entered === 0) return <NoData>Nobody took the first step in this period.</NoData>;
  return (
    <div className="flex flex-col gap-4 px-4 pb-4">
      <div
        className="grid gap-4"
        style={{ gridTemplateColumns: `repeat(${String(result.steps.length)}, minmax(0, 1fr))` }}
      >
        {result.steps.map((step, index) => {
          const share = entered === 0 ? 0 : step.count / entered;
          return (
            <div key={step.id} className="flex flex-col gap-2">
              <div className="flex h-28 items-end rounded bg-muted">
                <div
                  className="w-full rounded bg-primary/80"
                  style={{ height: `${String(Math.max(share * 100, 1))}%` }}
                />
              </div>
              <div className="min-w-0">
                <p className="truncate font-semibold text-[13px]">
                  {spec.steps[index]?.event ?? step.id}
                </p>
                <p className="text-muted-foreground text-xs tabular-nums">
                  <span className="font-semibold text-foreground">{count(step.count)}</span>
                  {index === 0 ? " entered" : ` · ${percent(step.rateFromPrevious)} went on`}
                </p>
              </div>
            </div>
          );
        })}
      </div>
      <p className="text-muted-foreground text-xs">
        {percent(result.conversionRate)} converted from the first step to the last.
      </p>
      {result.groups === undefined ? null : (
        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-muted-foreground text-xs">
              <th className="py-1.5 text-left font-medium">Group</th>
              <th className="py-1.5 text-right font-medium">Entered</th>
              <th className="py-1.5 text-right font-medium">Converted</th>
            </tr>
          </thead>
          <tbody>
            {result.groups.map((group) => (
              <tr key={`${String(group.other)}:${String(group.key)}`} className="h-8">
                <td className="truncate">{group.other ? "Other" : valueLabel(null, group.key)}</td>
                <td className="text-right tabular-nums">{count(group.steps[0]?.count ?? 0)}</td>
                <td className="text-right tabular-nums">{percent(group.conversionRate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function RetentionView({ result }: { result: RetentionResult }) {
  if (result.cohorts.every((cohort) => cohort.size === 0)) {
    return <NoData>No visitor's first visit fell in this period.</NoData>;
  }
  const periods = Math.max(0, ...result.cohorts.map((cohort) => cohort.periods.length));
  return (
    <div className="overflow-x-auto px-4 pb-4">
      <table className="w-full text-[12px] tabular-nums">
        <thead>
          <tr className="text-muted-foreground">
            <th className="py-1.5 pr-3 text-left font-medium">First visit</th>
            <th className="py-1.5 pr-3 text-right font-medium">Visitors</th>
            {Array.from({ length: periods }, (_value, index) => index + 1).map((offset) => (
              <th key={offset} className="w-12 py-1.5 text-center font-medium">
                +{offset}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.cohorts.map((cohort) => (
            <tr key={cohort.start}>
              <td className="py-0.5 pr-3">{cohort.start}</td>
              <td className="py-0.5 pr-3 text-right">{count(cohort.size)}</td>
              {cohort.periods
                .map((period, index) => ({ ...period, offset: index + 1 }))
                .map((period) => (
                  <td key={period.offset} className="p-0.5">
                    <span
                      className="block rounded py-1 text-center"
                      style={{
                        backgroundColor: `color-mix(in oklch, var(--color-primary) ${String(Math.round((period.rate ?? 0) * 90))}%, transparent)`,
                      }}
                      title={`${count(period.people)} returned`}
                    >
                      {period.rate === null ? "–" : percent(period.rate)}
                    </span>
                  </td>
                ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ScrollView({ result }: { result: ScrollDepthResult }) {
  if (result.views === 0)
    return <NoData>No view of this page reported how far it was read.</NoData>;
  return (
    <div className="flex flex-col gap-1.5 px-4 pb-4">
      {result.reached
        .map((share, index) => ({ share, depth: (index + 1) * 10 }))
        .map(({ share, depth }) => (
          <div key={depth} className="flex items-center gap-3 text-[12px] tabular-nums">
            <span className="w-10 text-right text-muted-foreground">{depth}%</span>
            <span className="h-5 flex-1 rounded bg-muted">
              <span
                className="block h-full rounded bg-primary/70"
                style={{ width: `${String(share * 100)}%` }}
              />
            </span>
            <span className="w-10 text-right">{percent(share)}</span>
          </div>
        ))}
      <p className="pt-1 text-muted-foreground text-xs">
        {count(result.views)} {result.views === 1 ? "view" : "views"}, by how far down the page{" "}
        {result.views === 1 ? "it" : "they"} reached.
      </p>
    </div>
  );
}

export function EventsView({ result }: { result: EventsResult }) {
  if (result.rows.length === 0) return <NoData>No event arrived in this period.</NoData>;
  return (
    <table className="w-full text-[13px]">
      <tbody>
        {result.rows.slice(0, 10).map((row) => (
          <tr key={row.uuid} className="h-8 border-t">
            <td className="w-32 px-4 text-muted-foreground tabular-nums">{moment(row.ts)}</td>
            <td className="truncate px-4 font-medium">{row.event}</td>
            <td className="max-w-48 truncate px-4 text-muted-foreground">{row.distinctId}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function PropertiesView({ result }: { result: PropertiesResult }) {
  if (result.properties.length === 0)
    return <NoData>No event in this period carried properties.</NoData>;
  return (
    <RankedRows
      heading="Property"
      measure="Events"
      rows={result.properties.slice(0, 12).map((property) => ({
        key: property.name,
        label: property.name,
        value: property.types.reduce((sum, type) => sum + type.count, 0),
      }))}
    />
  );
}
