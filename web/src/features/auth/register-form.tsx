"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { ApiError, describeApiError } from "@/lib/api/errors";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/form";
import { InlineAlert } from "@/components/ui/feedback";
import { useAuth } from "./auth-provider";

/**
 * Registration form.
 *
 * Client rules mirror the backend's (email valid, password 8–128, display name
 * 1–100) so the user gets immediate feedback, but the server stays the
 * authority: a 400 maps its Zod field paths back onto the inputs, and the
 * 409 (duplicate email or display name) is explained in words.
 */
export function RegisterForm() {
  const { register } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get("next");

  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  function validate(): Record<string, string> {
    const errors: Record<string, string> = {};
    if (displayName.trim().length === 0) errors.displayName = "Enter a display name.";
    else if (displayName.trim().length > 100) errors.displayName = "Keep it under 100 characters.";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) errors.email = "Enter a valid email.";
    if (password.length < 8) errors.password = "Use at least 8 characters.";
    else if (password.length > 128) errors.password = "Keep it under 128 characters.";
    return errors;
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    const local = validate();
    setFieldErrors(local);
    if (Object.keys(local).length > 0) return;

    setSubmitting(true);
    try {
      await register({ email: email.trim(), password, displayName: displayName.trim() });
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

      <Field label="Display name" hint="shown to the class" error={fieldErrors.displayName}>
        {(props) => (
          <Input
            {...props}
            name="displayName"
            autoComplete="nickname"
            required
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            invalid={Boolean(fieldErrors.displayName)}
            placeholder="Ms. Ray"
          />
        )}
      </Field>

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

      <Field label="Password" hint="8+ characters" error={fieldErrors.password}>
        {(props) => (
          <Input
            {...props}
            type="password"
            name="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            invalid={Boolean(fieldErrors.password)}
          />
        )}
      </Field>

      <Button type="submit" variant="accent" size="lg" loading={submitting} className="w-full">
        {submitting ? "Creating account…" : "Create account"}
      </Button>
    </form>
  );
}
