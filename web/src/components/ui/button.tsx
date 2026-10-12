import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils/cn";
import { Spinner } from "./feedback";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "accent";
export type ButtonSize = "sm" | "md" | "lg";

const base =
  "inline-flex items-center justify-center gap-2 rounded-sm font-medium transition-colors " +
  "disabled:cursor-not-allowed disabled:opacity-55 select-none whitespace-nowrap";

const variants: Record<ButtonVariant, string> = {
  // Ink button: editorial, high contrast, not a chrome-heavy gradient.
  primary: "bg-ink text-canvas hover:bg-ink/88 active:bg-ink/80",
  secondary:
    "border border-border-strong bg-surface text-ink hover:bg-surface-muted active:bg-surface-inset",
  ghost: "text-ink-muted hover:bg-surface-muted hover:text-ink",
  danger: "border border-danger/35 bg-danger-soft text-danger hover:border-danger/60",
  accent: "bg-accent text-white hover:bg-accent-hover",
};

const sizes: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-[0.8125rem]",
  md: "h-10 px-4 text-sm",
  lg: "h-11 px-5 text-[0.9375rem]",
};

export function buttonStyles(
  variant: ButtonVariant = "primary",
  size: ButtonSize = "md",
  className?: string,
): string {
  return cn(base, variants[variant], sizes[size], className);
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  leadingIcon?: ReactNode;
}

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  leadingIcon,
  className,
  children,
  disabled,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled || loading}
      className={buttonStyles(variant, size, className)}
    >
      {loading ? <Spinner className="h-4 w-4" /> : leadingIcon}
      {children}
    </button>
  );
}
