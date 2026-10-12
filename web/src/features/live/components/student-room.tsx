"use client";

import type { LiveSessionController } from "../use-live-session";
import { SessionHeader } from "./session-header";
import { QuestionPanel } from "./question-panel";
import { StudentAnswer } from "./student-answer";
import { LeaderboardPanel } from "./leaderboard-panel";
import { DoubtQueuePanel, RaiseDoubtForm } from "./doubt-queue";
import { PresencePanel } from "./presence-panel";
import { Card, CardBody } from "@/components/ui/card";
import { EmptyState, InlineAlert } from "@/components/ui/feedback";
import { Badge, StatusDot } from "@/components/ui/badge";

/**
 * The student view — mobile-first, one column, question first.
 *
 * Priority order mirrors how a student uses the room: the question they must
 * answer, the result of their answer, then the leaderboard and the doubt
 * queue. The connection state is always visible because a lagging connection
 * is the thing most likely to confuse.
 */
export function StudentRoom({ session }: { session: LiveSessionController }) {
  const { state, status, sessionName, roster, loadError, actions } = session;

  const isLive = state.sessionState === "LIVE";
  const canAnswer = status === "connected" && state.participantId !== null && isLive;
  const canRaise = status === "connected" && state.participantId !== null && isLive;

  return (
    <div className="min-h-dvh">
      <SessionHeader
        name={sessionName ?? "Live session"}
        state={state.sessionState}
        status={status}
        role={state.role}
        startedAt={state.startedAt}
        onlineCount={state.presence.length}
        totalParticipants={roster.length}
        onRefreshState={() => void session.refreshSessionState()}
      />

      {/* pb-28 keeps the doubt form clear of the toast band at the bottom of
          the viewport on small screens. */}
      <main id="main" className="lp-container max-w-3xl space-y-5 pt-6 pb-28 sm:pb-10">
        {loadError ? (
          <InlineAlert tone="danger" role="alert">
            {loadError}
          </InlineAlert>
        ) : null}

        {state.sessionState === "CREATED" ? (
          <Card>
            <CardBody>
              <EmptyState
                title="Waiting for your teacher"
                description="The session has not started yet. This page will switch to the live view on its own."
                icon={<StatusDot tone="warn" pulse />}
              />
            </CardBody>
          </Card>
        ) : state.sessionState === "ENDED" ? (
          <InlineAlert tone="info">
            This session has ended. Thanks for taking part — the leaderboard below is final.
          </InlineAlert>
        ) : null}

        <QuestionPanel
          question={state.currentQuestion}
          emptyHint="Nothing to answer yet. Your teacher will publish a question shortly."
        >
          {state.currentQuestion ? (
            <StudentAnswer
              question={state.currentQuestion}
              ownAnswer={state.ownAnswer}
              answerResult={state.answerResult}
              canAnswer={canAnswer}
              onSubmit={actions.submitAnswer}
            />
          ) : null}
        </QuestionPanel>

        <LeaderboardPanel
          standings={state.standings}
          hasQuestion={state.currentQuestion !== null}
          selfParticipantId={state.participantId}
        />

        <DoubtQueuePanel
          doubts={state.doubts}
          truncated={state.doubtsTruncated}
          canModerate={false}
          onResolve={actions.resolveDoubt}
          onDismiss={actions.dismissDoubt}
          onRefresh={actions.refreshDoubts}
          emptyDescription="Raise a question above and your teacher will see it here."
        >
          <RaiseDoubtForm canRaise={canRaise} onSubmit={actions.createDoubt} />
        </DoubtQueuePanel>

        <PresencePanel
          presence={state.presence}
          roster={roster}
          selfParticipantId={state.participantId}
        />

        <div className="flex items-center justify-center pt-2">
          <Badge tone="neutral">
            {state.participantId ? "Joined as a participant" : "Viewing without joining"}
          </Badge>
        </div>
      </main>
    </div>
  );
}
