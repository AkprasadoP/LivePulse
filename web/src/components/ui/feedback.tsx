import type { ReactNode } from "react";
import { cn } from "@/lib/utils/cn";

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={cn(
        "inline-block animate-spin rounded-full border-2 border-current/25 border-t-current",
        className ?? "h-4 w-4",
      )}
    />
  );
}

export function Skeleton({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("block animate-pulse rounded-xs bg-surface-inset", className)}
    />
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon,
  className,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-md border border-dashed border-border-strong px-6 py-10 text-center",
        className,
      )}
    >
      {icon ? <div className="text-ink-subtle">{icon}</div> : null}
      <div className="space-y-1">
        <p className="text-sm font-medium text-ink">{title}</p>
        {description ? (
          <p className="mx-auto max-w-sm text-sm text-ink-muted">{description}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

export type AlertTone = "info" | "warn" | "danger" | "success";

const alertTones: Record<AlertTone, string> = {
  info: "border-border-strong bg-surface-muted text-ink-muted",
  warn: "border-warn/30 bg-warn-soft text-warn",
  danger: "border-danger/30 bg-danger-soft text-danger",
  success: "border-live/30 bg-live-soft text-live",
};

export function InlineAlert({
  tone = "info",
  title,
  children,
  className,
  role = "status",
}: {
  tone?: AlertTone;
  title?: string;
  children: ReactNode;
  className?: string;
  role?: "status" | "alert";
}) {
  return (
    <div
      role={role}
      className={cn("rounded-sm border px-3.5 py-2.5 text-sm", alertTones[tone], className)}
    >
      {title ? <p className="font-medium">{title}</p> : null}
      <div className={cn(title ? "mt-0.5 text-[0.8125rem] leading-relaxed opacity-90" : "")}>
        {children}
      </div>
    </div>
  );
}
