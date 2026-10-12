import { StatusDot, type Tone } from "@/components/ui/badge";
import { cn } from "@/lib/utils/cn";
import type { ConnectionStatus } from "@/lib/ws/client";

/**
 * The four states the product cares about — CONNECTED, RECONNECTING,
 * RECOVERING, DISCONNECTED — are rendered distinctly, and every state carries
 * a text label (never color alone).
 */
interface Descriptor {
  label: string;
  tone: Tone;
  detailed: string;
  pulse: boolean;
}

export const CONNECTION_DESCRIPTORS: Record<ConnectionStatus, Descriptor> = {
  idle: {
    label: "Idle",
    tone: "neutral",
    detailed: "Not connected yet",
    pulse: false,
  },
  connecting: {
    label: "Connecting",
    tone: "accent",
    detailed: "Opening a connection to the session",
    pulse: true,
  },
  authenticating: {
    label: "Connecting",
    tone: "accent",
    detailed: "Signing the connection in",
    pulse: true,
  },
  joining: {
    label: "Connecting",
    tone: "accent",
    detailed: "Joining the session",
    pulse: true,
  },
  connected: {
    label: "Connected",
    tone: "live",
    detailed: "Receiving live updates",
    pulse: true,
  },
  reconnecting: {
    label: "Reconnecting",
    tone: "warn",
    detailed: "Connection lost — retrying",
    pulse: true,
  },
  recovering: {
    label: "Recovering",
    tone: "warn",
    detailed: "Reconnected — restoring session state",
    pulse: true,
  },
  disconnected: {
    label: "Disconnected",
    tone: "danger",
    detailed: "Not connected to the session",
    pulse: false,
  },
};

/** True when the connection needs no banner (quiet when healthy). */
export function isHealthy(status: ConnectionStatus): boolean {
  return status === "connected" || status === "idle";
}

export function ConnectionStatusPill({
  status,
  className,
}: {
  status: ConnectionStatus;
  className?: string;
}) {
  const descriptor = CONNECTION_DESCRIPTORS[status];
  return (
    <span
      role="status"
      aria-label={`Connection: ${descriptor.label}`}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-xs border border-border-strong bg-surface-muted px-2 py-1 text-[0.6875rem] font-medium uppercase tracking-wide text-ink-muted",
        className,
      )}
    >
      <StatusDot tone={descriptor.tone} pulse={descriptor.pulse} />
      {descriptor.label}
    </span>
  );
}

/**
 * A full-width notice shown only when the connection is NOT healthy, so a
 * steady connection stays quiet. It explains what the user should expect.
 */
export function ConnectionBanner({ status }: { status: ConnectionStatus }) {
  if (isHealthy(status)) return null;
  const descriptor = CONNECTION_DESCRIPTORS[status];
  const toneClass =
    descriptor.tone === "danger"
      ? "border-danger/30 bg-danger-soft text-danger"
      : descriptor.tone === "warn"
        ? "border-warn/30 bg-warn-soft text-warn"
        : "border-border-strong bg-surface-muted text-ink-muted";

  const hint =
    status === "disconnected"
      ? "Live updates are paused. Reload the page to rejoin."
      : status === "reconnecting"
        ? "Live updates pause until the connection returns. Your progress is stored on the server."
        : status === "recovering"
          ? "Restoring the current question, leaderboard and doubts."
          : "Setting up the live connection…";

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn("flex items-center gap-2.5 rounded-sm border px-3.5 py-2.5 text-sm", toneClass)}
    >
      <StatusDot tone={descriptor.tone} pulse={descriptor.pulse} />
      <span>
        <span className="font-medium">{descriptor.label}.</span>{" "}
        <span className="opacity-90">{hint}</span>
      </span>
    </div>
  );
}
