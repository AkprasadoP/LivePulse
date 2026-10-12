"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { ApiError, describeApiError } from "@/lib/api/errors";
import { sessionsApi } from "@/lib/api/sessions";
import { sessionIndex } from "@/lib/storage/session-index";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/form";
import { InlineAlert } from "@/components/ui/feedback";
import { parseSessionIdInput } from "./parse";

/**
 * Joins a session from a pasted link or id. The id is verified against the
 * open session read before navigating, so a typo produces a clear message
 * instead of a broken live screen.
 */
export function JoinSessionCard() {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const id = parseSessionIdInput(value);
    if (!id) {
      setError("Paste the session link, or its id.");
      return;
    }
    setJoining(true);
    try {
      const detail = await sessionsApi.get(id);
      sessionIndex.upsert({ id: detail.session.id, name: detail.session.name, role: "STUDENT" });
      router.push(`/sessions/${detail.session.id}`);
    } catch (caught) {
      if (caught instanceof ApiError && caught.isNotFound) {
        setError("No session with that link. Check it with your teacher.");
      } else {
        setError(describeApiError(caught));
      }
      setJoining(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      {error ? (
        <InlineAlert tone="danger" role="alert">
          {error}
        </InlineAlert>
      ) : null}
      <Field label="Session link or id">
        {(props) => (
          <Input
            {...props}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="https://…/sessions/018f3c2e-…"
            required
          />
        )}
      </Field>
      <Button type="submit" variant="primary" loading={joining}>
        {joining ? "Joining…" : "Join session"}
      </Button>
    </form>
  );
}
