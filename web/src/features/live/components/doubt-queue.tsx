"use client";

import { useState, type FormEvent } from "react";
import type { DoubtView } from "@/lib/ws/protocol";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/form";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState, InlineAlert } from "@/components/ui/feedback";
import { formatRelative } from "@/lib/utils/format";
import { useNow } from "@/lib/hooks/use-now";
import type { ActionResult } from "../use-live-session";

/**
 * The doubt queue, rendered in the exact order the server sent — `(priority
 * DESC, enqueueSeq ASC)`. The UI never sorts; it just shows the array.
 */
export function DoubtQueuePanel({
  doubts,
  truncated,
  canModerate,
  onResolve,
  onDismiss,
  onRefresh,
  children,
  emptyDescription,
}: {
  doubts: DoubtView[];
  truncated: boolean;
  canModerate: boolean;
  onResolve: (doubtId: string) => Promise<ActionResult>;
  onDismiss: (doubtId: string) => Promise<ActionResult>;
  onRefresh: () => Promise<ActionResult>;
  children?: React.ReactNode;
  emptyDescription?: string;
}) {
  const now = useNow(15_000);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function run(id: string, action: (doubtId: string) => Promise<ActionResult>) {
    setBusyId(id);
    await action(id);
    setBusyId(null);
  }

  return (
    <Card>
      <CardHeader
        title="Doubt queue"
        description={doubts.length > 0 ? `${doubts.length} open` : undefined}
        action={
          <Button variant="ghost" size="sm" onClick={() => void onRefresh()}>
            Refresh
          </Button>
        }
      />
      <CardBody className="space-y-4">
        {children}

        {doubts.length === 0 ? (
          <EmptyState
            title="No open doubts"
            description={emptyDescription ?? "Questions raised during the session land here."}
          />
        ) : (
          <ol className="space-y-3">
            {doubts.map((doubt, index) => (
              <li key={doubt.doubtId} className="flex gap-3">
                <span className="lp-tnum mt-0.5 w-4 shrink-0 text-xs text-ink-subtle">
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Avatar name={doubt.displayName} seed={doubt.participantId} size="xs" />
                    <span className="truncate text-sm font-medium text-ink">
                      {doubt.displayName}
                    </span>
                    <span className="text-xs text-ink-subtle">
                      {formatRelative(doubt.createdAt, now)}
                    </span>
                  </div>
                  <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-ink-muted">
                    {doubt.content}
                  </p>
                  {canModerate ? (
                    <div className="mt-2 flex gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        loading={busyId === doubt.doubtId}
                        onClick={() => void run(doubt.doubtId, onResolve)}
                      >
                        Resolve
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        loading={busyId === doubt.doubtId}
                        onClick={() => void run(doubt.doubtId, onDismiss)}
                      >
                        Dismiss
                      </Button>
                    </div>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        )}

        {truncated ? (
          <p className="text-xs text-ink-subtle">
            The queue is long — only the first {doubts.length} open doubts are shown.
          </p>
        ) : null}
      </CardBody>
    </Card>
  );
}

/**
 * Raising a doubt. A `clientDoubtId` is generated per attempt so a retry after
 * a dropped connection is idempotent on the server (the stored doubt is
 * re-sent instead of duplicated).
 */
export function RaiseDoubtForm({
  canRaise,
  onSubmit,
}: {
  canRaise: boolean;
  onSubmit: (content: string, clientDoubtId?: string) => Promise<ActionResult>;
}) {
  const [content, setContent] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const trimmed = content.trim();
    if (trimmed.length === 0) {
      setError("Write your question first.");
      return;
    }
    setSubmitting(true);
    const clientDoubtId =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const result = await onSubmit(trimmed, clientDoubtId);
    setSubmitting(false);
    if (result.ok) setContent("");
    else setError(result.message);
  }

  return (
    <form onSubmit={submit} className="space-y-2.5 border-b border-border pb-4">
      {error ? (
        <InlineAlert tone="danger" role="alert">
          {error}
        </InlineAlert>
      ) : null}
      <Textarea
        value={content}
        onChange={(event) => setContent(event.target.value)}
        placeholder="What would you like cleared up?"
        maxLength={1000}
        disabled={!canRaise || submitting}
        className="min-h-20"
        aria-label="Raise a doubt"
      />
      <div className="flex items-center justify-between gap-3">
        <Badge tone="neutral">{content.length} / 1000</Badge>
        <Button type="submit" size="sm" variant="accent" loading={submitting} disabled={!canRaise}>
          Raise doubt
        </Button>
      </div>
    </form>
  );
}
