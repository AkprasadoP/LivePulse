"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils/cn";

/**
 * Accessible modal: role=dialog + aria-modal, Escape to close, click-outside
 * to close, and a simple Tab focus trap.
 *
 * Rendered through a PORTAL into `document.body`, deliberately. A modal that
 * stays in its React parent inherits that parent's stacking context — and the
 * confirm dialog for "End session" lives inside the sticky header, which both
 * sets `z-index` and uses `backdrop-filter`. Inside that context a `fixed
 * inset-0` overlay is laid out against the header box instead of the viewport,
 * so the scrim stops covering the page and the dialog stops stacking correctly.
 * Portalling keeps the dialog top-level regardless of where it is declared.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const focusables = () =>
      panel
        ? Array.from(
            panel.querySelectorAll<HTMLElement>(
              'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])',
            ),
          ).filter((el) => el.offsetParent !== null || el === document.activeElement)
        : [];

    const first = focusables()[0];
    first?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key === "Tab") {
        const list = focusables();
        if (list.length === 0) return;
        const firstEl = list[0]!;
        const lastEl = list[list.length - 1]!;
        if (event.shiftKey && document.activeElement === firstEl) {
          event.preventDefault();
          lastEl.focus();
        } else if (!event.shiftKey && document.activeElement === lastEl) {
          event.preventDefault();
          firstEl.focus();
        }
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      previouslyFocused.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;
  // Server render has no body to portal into. Every modal in this app starts
  // closed and is only opened by user interaction, so this branch is only ever
  // taken during SSR.
  if (typeof document === "undefined") return null;

  const maxWidth = size === "sm" ? "max-w-sm" : size === "lg" ? "max-w-2xl" : "max-w-lg";

  const overlay = (
    // Always vertically centred — never a bottom sheet. A bottom-anchored
    // dialog puts its footer exactly where the toast band lives, so the
    // primary action of the dialog would sit under an incoming toast.
    <div className="fixed inset-0 z-20 flex items-center justify-center p-4 sm:p-6">
      <button
        type="button"
        aria-label="Close dialog"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-ink/45 backdrop-blur-[1px]"
        tabIndex={-1}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn(
          "relative z-10 w-full max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-lg border border-border bg-surface shadow-pop",
          maxWidth,
        )}
      >
        <div className="border-b border-border px-5 py-4">
          <h2 className="text-base font-semibold tracking-tight text-ink">{title}</h2>
          {description ? <p className="mt-1 text-sm text-ink-muted">{description}</p> : null}
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer ? (
          <div className="flex justify-end gap-2 border-t border-border px-5 py-3.5">{footer}</div>
        ) : null}
      </div>
    </div>
  );

  return createPortal(overlay, document.body);
}
