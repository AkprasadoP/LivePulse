import { cn } from "@/lib/utils/cn";

/**
 * The LivePulse wordmark: a small pulse glyph plus letter-spaced type.
 * Rendered as text (not an image) so it inherits the ink color and stays crisp
 * in both themes.
 */
export function Logo({
  className,
  showWordmark = true,
}: {
  className?: string;
  showWordmark?: boolean;
}) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <PulseGlyph className="h-[18px] w-[18px] text-accent" />
      {showWordmark ? (
        <span className="text-[0.9375rem] font-semibold tracking-[-0.01em] text-ink">
          LivePulse
        </span>
      ) : null}
    </span>
  );
}

/** A heartbeat trace — the one piece of brand decoration the product carries. */
export function PulseGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={className}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      stroke="currentColor"
    >
      <path d="M2 12h3.5l2.2-6 3.6 12 2.7-7.5L16 12h6" />
    </svg>
  );
}
