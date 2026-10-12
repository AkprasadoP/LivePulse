"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils/cn";
import type { Tone } from "./badge";

export interface ToastInput {
  title: string;
  description?: string;
  tone?: Tone;
  durationMs?: number;
}

interface ToastItem extends ToastInput {
  id: number;
}

interface ToastContextValue {
  toast: (input: ToastInput) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const toneBar: Record<Tone, string> = {
  neutral: "bg-neutral",
  live: "bg-live",
  warn: "bg-warn",
  danger: "bg-danger",
  accent: "bg-accent",
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: number) => {
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const toast = useCallback(
    (input: ToastInput) => {
      const id = Date.now() + Math.random();
      setItems((current) => [...current, { ...input, id }].slice(-4));
      const duration = input.durationMs ?? 5000;
      if (duration > 0) setTimeout(() => dismiss(id), duration);
    },
    [dismiss],
  );

  const value = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {/*
        Anchored bottom-LEFT on desktop on purpose: the live rooms keep their
        action-heavy rail (doubt Resolve/Dismiss) on the right, and the
        teacher's controls sit top-right in the sticky header. The lower-left
        corner is the one region with no buttons in it, so a toast can never
        sit on top of an action. On mobile it stays bottom-centred, above the
        `pb-28` clearance the live pages leave for it.
      */}
      <div
        aria-live="polite"
        aria-atomic="false"
        className="pointer-events-none fixed inset-x-0 bottom-0 z-30 flex flex-col items-center gap-2 p-4 sm:items-start sm:p-6"
      >
        {items.map((item) => (
          <div
            key={item.id}
            role="status"
            className={cn(
              "pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-md border border-border bg-surface p-3.5 shadow-pop",
            )}
          >
            <span
              aria-hidden="true"
              className={cn("mt-1 h-2 w-2 shrink-0 rounded-full", toneBar[item.tone ?? "neutral"])}
            />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-ink">{item.title}</p>
              {item.description ? (
                <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">{item.description}</p>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => dismiss(item.id)}
              className="rounded-xs px-1.5 py-0.5 text-xs text-ink-subtle hover:bg-surface-muted hover:text-ink"
              aria-label="Dismiss notification"
            >
              Close
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast must be used within <ToastProvider>");
  return context;
}
