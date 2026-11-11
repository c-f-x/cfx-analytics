import { ArrowUpRight } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { bucketLabel, count } from "@/lib/format.ts";
import { niceTicks } from "@/lib/ticks.ts";

// A line chart drawn by hand in SVG: this period in the accent, the period
// before as a grey dashed line, round ticks, and a readout under the pointer.
// Colour carries one meaning (now versus before), per the dataviz rules.

const HEIGHT = 200;
const PAD = { top: 12, right: 12, bottom: 26, left: 40 };

function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return undefined;
    const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

export function LineChart({
  labels,
  values,
  previous,
  label,
}: {
  labels: string[];
  values: number[];
  previous?: number[] | undefined;
  label: string;
}) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...values, ...(previous ?? []));
  const ticks = niceTicks(max);
  const top = ticks.at(-1) ?? max;
  const plotWidth = Math.max(0, width - PAD.left - PAD.right);
  const plotHeight = HEIGHT - PAD.top - PAD.bottom;
  const x = (index: number): number =>
    PAD.left + (values.length <= 1 ? plotWidth / 2 : (index * plotWidth) / (values.length - 1));
  const y = (value: number): number => PAD.top + plotHeight - (value / top) * plotHeight;
  const path = (series: readonly number[]): string =>
    series
      .map(
        (value, index) => `${index === 0 ? "M" : "L"}${x(index).toFixed(1)},${y(value).toFixed(1)}`,
      )
      .join(" ");
  const every = Math.max(1, Math.ceil(labels.length / Math.max(1, Math.floor(plotWidth / 64))));

  return (
    <div ref={ref} className="relative">
      {width === 0 ? (
        <div style={{ height: HEIGHT }} />
      ) : (
        <svg
          width={width}
          height={HEIGHT}
          role="img"
          aria-label={label}
          onMouseLeave={() => setHover(null)}
          onMouseMove={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            const at = Math.round(
              ((event.clientX - box.left - PAD.left) / plotWidth) * (values.length - 1),
            );
            setHover(Math.min(values.length - 1, Math.max(0, at)));
          }}
        >
          {ticks.map((tick) => (
            <g key={tick}>
              <line
                x1={PAD.left}
                x2={width - PAD.right}
                y1={y(tick)}
                y2={y(tick)}
                className="stroke-border"
                strokeWidth={1}
              />
              <text
                x={PAD.left - 8}
                y={y(tick) + 4}
                textAnchor="end"
                className="fill-muted-foreground text-[11px] tabular-nums"
              >
                {count(tick)}
              </text>
            </g>
          ))}
          {labels.map((text, index) =>
            index % every === 0 ? (
              <text
                key={text}
                x={x(index)}
                y={HEIGHT - 6}
                textAnchor={index === labels.length - 1 ? "end" : "middle"}
                className="fill-muted-foreground text-[11px]"
              >
                {bucketLabel(text)}
              </text>
            ) : null,
          )}
          {previous === undefined ? null : (
            <path
              d={path(previous)}
              fill="none"
              className="stroke-muted-foreground/60"
              strokeWidth={1.5}
              strokeDasharray="4 4"
            />
          )}
          <path
            d={path(values)}
            fill="none"
            className="stroke-primary"
            strokeWidth={2.25}
            strokeLinejoin="round"
          />
          {hover === null ? null : (
            <g>
              <line
                x1={x(hover)}
                x2={x(hover)}
                y1={PAD.top}
                y2={PAD.top + plotHeight}
                className="stroke-border"
              />
              <circle cx={x(hover)} cy={y(values[hover] ?? 0)} r={3.5} className="fill-primary" />
            </g>
          )}
        </svg>
      )}
      {hover === null ? null : (
        <div
          className="pointer-events-none absolute top-0 rounded-md border bg-popover px-2 py-1 text-[12px] shadow-sm"
          style={{ left: Math.min(Math.max(0, x(hover) - 60), Math.max(0, width - 130)) }}
        >
          <span className="text-muted-foreground">{bucketLabel(labels[hover] ?? "")}</span>{" "}
          <span className="font-semibold tabular-nums">{count(values[hover] ?? 0)}</span>
          {previous?.[hover] === undefined ? null : (
            <span className="text-muted-foreground tabular-nums">
              {" "}
              · before {count(previous[hover] ?? 0)}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Ranked rows with a quiet bar behind each, as a top list reads best. With
 * onPick a row's label is a button; with onOpen each row has an "Open" button
 * too, shown on hover and focus.
 */
export function RankedRows({
  rows,
  heading,
  measure,
  onPick,
  onOpen,
}: {
  rows: { key: string; label: string; value: number }[];
  heading: string;
  measure: string;
  onPick?: ((key: string) => void) | undefined;
  onOpen?: ((key: string) => void) | undefined;
}) {
  const max = Math.max(1, ...rows.map((row) => row.value));
  return (
    <table className="w-full text-[13px]">
      <thead>
        <tr className="text-muted-foreground text-xs">
          <th className="px-4 py-1.5 text-left font-medium">{heading}</th>
          <th className="w-24 px-4 py-1.5 text-right font-medium">{measure}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key} className={onPick === undefined ? "group" : "group hover:bg-muted/60"}>
            <td className="relative h-8 px-4">
              <span
                aria-hidden
                className="absolute inset-y-1 left-2 rounded bg-muted"
                style={{ width: `calc((100% - 1rem) * ${(row.value / max).toFixed(3)})` }}
              />
              {onPick === undefined ? (
                <span className="relative block truncate pl-1.5">{row.label}</span>
              ) : (
                <button
                  type="button"
                  title={`Filter by ${row.label}`}
                  className="relative block w-full cursor-pointer truncate rounded pl-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/45"
                  onClick={() => onPick(row.key)}
                >
                  {row.label}
                </button>
              )}
            </td>
            <td className="px-4 text-right tabular-nums">
              <span className="inline-flex items-center gap-1.5">
                {onOpen === undefined ? null : (
                  <button
                    type="button"
                    aria-label={`Open ${row.label}`}
                    className="rounded p-0.5 text-muted-foreground opacity-0 outline-none hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/45 group-hover:opacity-100"
                    onClick={() => onOpen(row.key)}
                  >
                    <ArrowUpRight className="size-3.5" />
                  </button>
                )}
                {count(row.value)}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
