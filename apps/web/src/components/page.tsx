import type * as React from "react";
import { cn } from "@/lib/cn.ts";

// The frame of every screen: a sticky band with the title and the screen's
// controls, and a scrolling body on one column grid.

export function PageHeader({
  title,
  children,
}: {
  title: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="sticky top-0 z-10 border-b bg-background/90 backdrop-blur">
      <div className="mx-auto flex min-h-14 max-w-[1180px] flex-wrap items-center gap-2 px-6 py-2.5 max-md:px-4 lg:px-8">
        <h1 className="mr-auto truncate font-semibold text-lg tracking-tight max-md:basis-full">
          {title}
        </h1>
        {children}
      </div>
    </div>
  );
}

export function PageBody({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "mx-auto flex max-w-[1180px] flex-col gap-4 px-6 py-6 max-md:px-4 max-md:py-4 lg:px-8",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return <section className={cn("rounded-lg border bg-card", className)}>{children}</section>;
}

export function CardHead({
  title,
  children,
}: {
  title: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex h-11 items-center gap-2 px-4 pt-1">
      <h2 className="mr-auto truncate font-semibold text-[13px]">{title}</h2>
      {children}
    </div>
  );
}
