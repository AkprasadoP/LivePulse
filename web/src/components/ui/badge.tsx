import type { ReactNode } from "react";
import { cn } from "@/lib/utils/cn";

export type Tone = "neutral" | "live" | "warn" | "danger" | "accent";

const toneClasses: Record<Tone, string> = {
  neutral: "border-border-strong bg-surface-muted text-ink-muted",
  live: "border-live/30 bg-live-soft text-live",
  warn: "border-warn/30 bg-warn-soft text-warn",
  danger: "border-danger/30 bg-danger-soft text-danger",
  accent: "border-accent/30 bg-accent-soft text-accent-ink",
};

export function Badge({
  tone = "neutral",
  children,
  className,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-xs border px-2 py-0.5 text-[0.6875rem] font-medium uppercase tracking-wide",
        toneClasses[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * Status is never communicated by color alone: the dot is always accompanied
 * by a text label at the call site.
 */
export function StatusDot({ tone = "neutral", pulse = false }: { tone?: Tone; pulse?: boolean }) {
  const color =
    tone === "live"
      ? "bg-live"
      : tone === "warn"
        ? "bg-warn"
        : tone === "danger"
          ? "bg-danger"
          : tone === "accent"
            ? "bg-accent"
            : "bg-neutral";
  return (
    <span aria-hidden="true" className="relative inline-flex h-2 w-2">
      <span className={cn("h-2 w-2 rounded-full", color, pulse && "lp-pulse")} />
    </span>
  );
}

export function RoleBadge({ role }: { role: "TEACHER" | "STUDENT" | null }) {
  if (!role) return null;
  return (
    <Badge tone={role === "TEACHER" ? "accent" : "neutral"}>{role.toLowerCase()}</Badge>
  );
}
