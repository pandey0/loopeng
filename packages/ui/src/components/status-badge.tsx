import type { HTMLAttributes } from "react";
import { getStatusMeta, type StatusKey } from "../lib/status";
import { cn } from "../lib/utils";
import { Badge } from "./badge";

export interface StatusBadgeProps extends Omit<HTMLAttributes<HTMLSpanElement>, "children"> {
  status: StatusKey;
  /** Show only the colored dot + icon, no text label. */
  iconOnly?: boolean;
}

export function StatusBadge({ status, iconOnly = false, className, ...props }: StatusBadgeProps) {
  const { label, Icon, badgeVariant } = getStatusMeta(status);
  return (
    <Badge variant={badgeVariant} className={cn("gap-1", className)} title={label} {...props}>
      <Icon className="h-3 w-3 shrink-0" />
      {!iconOnly && label}
    </Badge>
  );
}

export interface StatusDotProps extends HTMLAttributes<HTMLSpanElement> {
  status: StatusKey;
}

export function StatusDot({ status, className, ...props }: StatusDotProps) {
  const { dotClassName, label } = getStatusMeta(status);
  return <span className={cn("inline-block h-2 w-2 rounded-full", dotClassName, className)} title={label} {...props} />;
}
