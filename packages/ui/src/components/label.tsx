import { type LabelHTMLAttributes, forwardRef } from "react";
import { cn } from "../lib/utils";

export const Label = forwardRef<HTMLLabelElement, LabelHTMLAttributes<HTMLLabelElement>>(
  ({ className, ...props }, ref) => (
    <label
      ref={ref}
      className={cn("mb-1 block text-xs font-semibold text-foreground", className)}
      {...props}
    />
  ),
);
Label.displayName = "Label";
