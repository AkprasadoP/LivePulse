"use client";

import { useState } from "react";
import type { SessionState } from "@/lib/api/types";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { InlineAlert } from "@/components/ui/feedback";
import type { ActionResult } from "../use-live-session";

/**
 * The session lifecycle: CREATED → LIVE → ENDED. Ending is terminal, so it is
 * confirmed. The buttons reflect the server's state, not a client guess.
 */
export function SessionControls({
  state,
  onSetState,
}: {
  state: SessionState | null;
  onSetState: (next: Exclude<SessionState, "CREATED">) => Promise<ActionResult>;
}) {
  const [busy, setBusy] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function transition(next: Exclude<SessionState, "CREATED">) {
    setBusy(true);
    setError(null);
    const result = await onSetState(next);
    if (!result.ok) setError(result.message);
    setBusy(false);
    setConfirmEnd(false);
  }

  if (state === "ENDED") {
    return (
      <InlineAlert tone="info">
        This session has ended. Answers and doubts are frozen.
      </InlineAlert>
    );
  }

  return (
    <div className="space-y-3">
      {error ? (
        <InlineAlert tone="danger" role="alert">
          {error}
        </InlineAlert>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {state === "CREATED" ? (
          <Button variant="accent" loading={busy} onClick={() => void transition("LIVE")}>
            Go live
          </Button>
        ) : (
          <Button variant="danger" loading={busy} onClick={() => setConfirmEnd(true)}>
            End session
          </Button>
        )}
      </div>

      <Modal
        open={confirmEnd}
        onClose={() => setConfirmEnd(false)}
        title="End this session?"
        description="Ending is permanent. Students will not be able to answer or raise doubts afterwards."
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmEnd(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="danger" loading={busy} onClick={() => void transition("ENDED")}>
              End session
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-muted">
          The current question, leaderboard and doubt queue stay readable, but the room stops
          accepting input.
        </p>
      </Modal>
    </div>
  );
}
