"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { ApiError, describeApiError } from "@/lib/api/errors";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/form";
import { InlineAlert } from "@/components/ui/feedback";
import { useAuth } from "./auth-provider";

/**
 * Sign-in form. Errors are mapped to human sentences — a 401 shows the
 * backend's own generic message ("Invalid email or password") rather than a
 * raw status, and field paths from a 400 are attached to the right input.
 */
export function LoginForm() {
  const { login } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get("next");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    setFieldErrors({});
    setSubmitting(true);
    try {
      await login(email.trim(), password);
      router.replace(next && next.startsWith("/") ? next : "/dashboard");
    } catch (error) {
      if (error instanceof ApiError && error.isValidation) {
        const errors: Record<string, string> = {};
        for (const issue of error.fieldIssues) {
          const key = issue.path.split(".").pop() ?? issue.path;
          if (key) errors[key] = issue.message;
        }
        setFieldErrors(errors);
        if (Object.keys(errors).length === 0) setFormError(describeApiError(error));
      } else {
        setFormError(describeApiError(error));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      {formError ? (
        <InlineAlert tone="danger" role="alert">
          {formError}
        </InlineAlert>
      ) : null}

      <Field label="Email" error={fieldErrors.email}>
        {(props) => (
          <Input
            {...props}
            type="email"
            name="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            invalid={Boolean(fieldErrors.email)}
            placeholder="you@school.edu"
          />
        )}
      </Field>

      <Field label="Password" error={fieldErrors.password}>
        {(props) => (
          <Input
            {...props}
            type="password"
            name="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            invalid={Boolean(fieldErrors.password)}
          />
        )}
      </Field>

      <Button type="submit" variant="accent" size="lg" loading={submitting} className="w-full">
        {submitting ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}
