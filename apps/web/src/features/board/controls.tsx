import { useNavigate } from "@tanstack/react-router";
import { Calendar, Filter, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.tsx";
import type { BoardState, FilterChip } from "@/lib/board.ts";
import { propertyLabel } from "@/lib/labels.ts";
import { PERIODS, periodOf } from "@/lib/period.ts";

// The controls every analysis screen shares: the period, the comparison, and
// the filter chips. They write the board's state into the address.

export function useBoardNavigate(): (change: Partial<BoardState>) => void {
  const navigate = useNavigate();
  return (change) =>
    void navigate({
      to: ".",
      search: (previous: Record<string, unknown>) => ({ ...previous, ...change }),
    });
}

export function PeriodSelect({ board }: { board: BoardState }) {
  const set = useBoardNavigate();
  return (
    <Select value={board.period} onValueChange={(value) => set({ period: periodOf(value).id })}>
      <SelectTrigger className="w-40" aria-label="Period">
        <Calendar className="size-3.5 text-muted-foreground" />
        <SelectValue>{periodOf(board.period).label}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {PERIODS.map((period) => (
          <SelectItem key={period.id} value={period.id}>
            {period.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function CompareToggle({ board }: { board: BoardState }) {
  const set = useBoardNavigate();
  return (
    <Button
      aria-pressed={board.compare}
      className={board.compare ? "border-foreground/30 bg-muted" : ""}
      onClick={() => set({ compare: !board.compare })}
    >
      Compare
    </Button>
  );
}

export function FilterButton({ board }: { board: BoardState }) {
  const set = useBoardNavigate();
  const [open, setOpen] = useState(false);
  const [property, setProperty] = useState("");
  const [value, setValue] = useState("");
  const add = () => {
    if (property.trim() === "" || value === "") return;
    set({ filters: [...board.filters, { property: property.trim(), value }] });
    setProperty("");
    setValue("");
    setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button />}>
        <Filter className="text-muted-foreground" />
        Filter
      </PopoverTrigger>
      <PopoverContent className="w-72 p-3">
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            add();
          }}
        >
          <p className="font-semibold text-[13px]">Only events where</p>
          <Input
            aria-label="Property"
            placeholder="Property, such as $browser"
            value={property}
            onChange={(event) => setProperty(event.target.value)}
          />
          <Input
            aria-label="Value"
            placeholder="equals…"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
          <Button type="submit" variant="primary" disabled={property.trim() === "" || value === ""}>
            Add filter
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}

export function FilterChips({ board }: { board: BoardState }) {
  const set = useBoardNavigate();
  if (board.filters.length === 0) return null;
  const without = (chip: FilterChip) => board.filters.filter((other) => other !== chip);
  return (
    <div className="flex flex-wrap items-center gap-2">
      {board.filters.map((chip) => (
        <span
          key={`${chip.property}=${chip.value}`}
          className="inline-flex h-7 items-center gap-1.5 rounded-full border bg-card pr-1 pl-3 text-[12px]"
        >
          <span className="text-muted-foreground">{propertyLabel(chip.property)}</span>
          <span className="font-medium">{chip.value}</span>
          <button
            type="button"
            className="rounded-full p-1 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/45"
            aria-label={`Remove the filter on ${propertyLabel(chip.property)}`}
            onClick={() => set({ filters: without(chip) })}
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      <button
        type="button"
        className="rounded text-muted-foreground text-xs outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/45"
        onClick={() => set({ filters: [] })}
      >
        Clear all
      </button>
    </div>
  );
}

export function ExclusionNotice({ board }: { board: BoardState }) {
  const set = useBoardNavigate();
  return (
    <p className="text-muted-foreground text-[13px]">
      {board.include
        ? "Bots and your own traffic are included."
        : "Bots and your own traffic are left out."}{" "}
      <button
        type="button"
        className="font-medium text-primary hover:underline"
        onClick={() => set({ include: !board.include })}
      >
        {board.include ? "Leave them out" : "Include"}
      </button>
    </p>
  );
}
