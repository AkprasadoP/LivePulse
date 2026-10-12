"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { describeApiError } from "@/lib/api/errors";
import { sessionsApi } from "@/lib/api/sessions";
import { sessionIndex } from "@/lib/storage/session-index";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/form";
import { InlineAlert } from "@/components/ui/feedback";

/**
 * Creates a session and hands the teacher straight to the control room.
 * The new id is remembered in the client session index because the backend
 * has no "list my sessions" endpoint to ask later.
 */
export function CreateSessionCard() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setError("Give the session a name.");
      return;
    }
    setCreating(true);
    try {
      const { session } = await sessionsApi.create(trimmed);
      sessionIndex.upsert({ id: session.id, name: session.name, role: "TEACHER" });
      router.push(`/sessions/${session.id}`);
    } catch (caught) {
      setError(describeApiError(caught));
      setCreating(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      {error ? (
        <InlineAlert tone="danger" role="alert">
          {error}
        </InlineAlert>
      ) : null}
      <Field label="Session name" hint="students see this">
        {(props) => (
          <Input
            {...props}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Physics — Period 3"
            maxLength={200}
            required
            autoFocus
          />
        )}
      </Field>
      <Button type="submit" variant="accent" loading={creating}>
        {creating ? "Opening…" : "Open a session"}
      </Button>
    </form>
  );
}
