import { AlertTriangle, type LucideIcon } from "lucide-react";
import type * as React from "react";
import { Button } from "@/components/ui/button.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { cn } from "@/lib/cn.ts";

// The designed states every screen and tile shares: nothing yet, loading and
// failed. Each says what happened and what to do next.

export function EmptyState({
  icon: Icon,
  title,
  children,
  action,
  className,
}: {
  icon: LucideIcon;
  title: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center gap-3 px-6 py-10 text-center", className)}>
      <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Icon className="size-5" />
      </span>
      <div className="flex max-w-sm flex-col gap-1">
        <p className="font-semibold text-sm">{title}</p>
        {children === undefined ? null : (
          <div className="text-muted-foreground text-[13px]">{children}</div>
        )}
      </div>
      {action}
    </div>
  );
}

export function ErrorState({
  error,
  onRetry,
  className,
}: {
  error: unknown;
  onRetry?: () => void;
  className?: string;
}) {
  const message = error instanceof Error ? error.message : "Something went wrong.";
  return (
    <div className={cn("flex flex-col items-center gap-3 px-6 py-8 text-center", className)}>
      <span className="flex size-9 items-center justify-center rounded-full bg-destructive/10 text-destructive">
        <AlertTriangle className="size-4" />
      </span>
      <div className="flex max-w-sm flex-col gap-1">
        <p className="font-semibold text-sm">This could not load</p>
        <p className="text-muted-foreground text-[13px]">{message}</p>
      </div>
      {onRetry === undefined ? null : (
        <Button size="sm" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

/** Rows of skeleton bars, sized like the content they stand for. */
export function SkeletonRows({ rows = 5, className }: { rows?: number; className?: string }) {
  return (
    <div
      className={cn("flex flex-col gap-2 p-4", className)}
      role="status"
      aria-busy="true"
      aria-label="Loading"
    >
      {Array.from({ length: rows }, (_value, index) => 92 - index * 9).map((width) => (
        <Skeleton key={width} className="h-6" style={{ width: `${String(width)}%` }} />
      ))}
    </div>
  );
}
