import { avatarTone, initials } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";

export function Avatar({
  name,
  seed,
  size = "md",
  className,
  dimmed = false,
}: {
  name: string;
  seed?: string;
  size?: "xs" | "sm" | "md";
  className?: string;
  dimmed?: boolean;
}) {
  const dimensions =
    size === "xs"
      ? "h-6 w-6 text-[0.625rem]"
      : size === "sm"
        ? "h-8 w-8 text-xs"
        : "h-9 w-9 text-sm";
  return (
    <span
      aria-hidden="true"
      style={{ backgroundColor: avatarTone(seed ?? name) }}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full font-medium text-white",
        dimensions,
        dimmed && "opacity-45 grayscale",
        className,
      )}
    >
      {initials(name)}
    </span>
  );
}
