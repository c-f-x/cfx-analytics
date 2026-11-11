import type * as React from "react";
import { cn } from "@/lib/cn";

/** A form label; `htmlFor` names its control, so every label has one. */
export function Label({
  className,
  htmlFor,
  children,
  ...props
}: React.LabelHTMLAttributes<HTMLLabelElement> & { htmlFor: string }) {
  return (
    <label
      htmlFor={htmlFor}
      className={cn(
        "select-none text-xs font-medium text-muted-foreground peer-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      {children}
    </label>
  );
}
