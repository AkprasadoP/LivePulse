import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import { useId } from "react";
import { cn } from "@/lib/utils/cn";

const control =
  "w-full rounded-sm border border-border-strong bg-surface px-3 text-ink placeholder:text-ink-subtle " +
  "transition-colors hover:border-border-strong focus:border-accent disabled:opacity-60";

export function Label({
  htmlFor,
  children,
  hint,
}: {
  htmlFor?: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label htmlFor={htmlFor} className="flex items-baseline justify-between gap-3 text-sm">
      <span className="font-medium text-ink">{children}</span>
      {hint ? <span className="text-xs text-ink-subtle">{hint}</span> : null}
    </label>
  );
}

export interface FieldProps {
  label: string;
  hint?: string;
  error?: string | undefined;
  children: (props: { id: string; "aria-describedby": string | undefined }) => ReactNode;
}

/** Accessible field wrapper: wires label, description and error to the control. */
export function Field({ label, hint, error, children }: FieldProps) {
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} hint={hint}>
        {label}
      </Label>
      {children({ id, "aria-describedby": error ? errorId : undefined })}
      {error ? (
        <p id={errorId} role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function Input({
  className,
  invalid,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return (
    <input
      {...rest}
      aria-invalid={invalid || undefined}
      className={cn(control, "h-10 text-sm", invalid && "border-danger/60", className)}
    />
  );
}

export function Textarea({
  className,
  invalid,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }) {
  return (
    <textarea
      {...rest}
      aria-invalid={invalid || undefined}
      className={cn(
        control,
        "min-h-24 resize-y py-2.5 text-sm leading-relaxed",
        invalid && "border-danger/60",
        className,
      )}
    />
  );
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...rest} className={cn(control, "h-10 text-sm", className)}>
      {children}
    </select>
  );
}

/** A labelled checkbox — used for per-question scoring flags. */
export function Checkbox({
  label,
  description,
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label: string; description?: string }) {
  const id = useId();
  return (
    <div className={cn("flex items-start gap-2.5", className)}>
      <input
        {...rest}
        id={id}
        type="checkbox"
        className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-[var(--lp-accent)]"
      />
      <label htmlFor={id} className="cursor-pointer select-none text-sm">
        <span className="text-ink">{label}</span>
        {description ? (
          <span className="mt-0.5 block text-xs text-ink-subtle">{description}</span>
        ) : null}
      </label>
    </div>
  );
}
