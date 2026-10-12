"use client";

import { useEffect } from "react";
import type { LiveSessionController } from "../use-live-session";
import { SessionHeader } from "./session-header";
import { SessionControls } from "./session-controls";
import { QuestionPanel } from "./question-panel";
import { AnswerActivityPanel } from "./answer-activity";
import { TeacherQuizPanel } from "./teacher-quiz-panel";
import { PresencePanel } from "./presence-panel";
import { LeaderboardPanel } from "./leaderboard-panel";
import { DoubtQueuePanel } from "./doubt-queue";
import { InlineAlert } from "@/components/ui/feedback";

/**
 * The teacher control room — the strongest screen in the product.
 *
 * Composition: the room (current question + quiz controls) takes the main
 * column while the pulse of the class (presence, leaderboard, doubts) sits in
 * a rail. Below `lg` the rail simply stacks underneath, so a tablet still
 * works without a separate layout.
 */
export function TeacherRoom({ session }: { session: LiveSessionController }) {
  const { state, status, sessionName, roster, quizCatalog, loadError, actions } = session;

  // Quizzes discovered from the recovery snapshot carry only their state, not
  // their questions — fetch the content for each one we don't have yet.
  useEffect(() => {
    for (const quiz of state.quizzes) {
      if (!quizCatalog.some((catalogQuiz) => catalogQuiz.id === quiz.quizId)) {
        void actions.loadQuiz(quiz.quizId);
      }
    }
  }, [state.quizzes, quizCatalog, actions]);

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
        actions={
          <SessionControls state={state.sessionState} onSetState={actions.setSessionState} />
        }
      />

      {/* pb-28 keeps the rail's last controls clear of the toast band at the
          bottom of the viewport on small screens. */}
      <main id="main" className="lp-container space-y-5 pt-6 pb-28 sm:pb-10">
        {loadError ? (
          <InlineAlert tone="danger" role="alert">
            {loadError}
          </InlineAlert>
        ) : null}

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="min-w-0 space-y-5">
            <QuestionPanel
              question={state.currentQuestion}
              emptyHint="Create a quiz, start it, then publish a question. Students see it immediately."
            />
            <TeacherQuizPanel
              quizzes={quizCatalog}
              liveQuizzes={state.quizzes}
              currentQuestion={state.currentQuestion}
              sessionState={state.sessionState}
              actions={actions}
              onCreateQuiz={actions.createQuiz}
              onLoadQuiz={actions.loadQuiz}
            />
          </div>

          <aside className="min-w-0 space-y-5">
            <PresencePanel
              presence={state.presence}
              roster={roster}
              selfParticipantId={state.participantId}
            />
            <LeaderboardPanel
              standings={state.standings}
              hasQuestion={state.currentQuestion !== null}
              selfParticipantId={state.participantId}
            />
            <AnswerActivityPanel
              activity={state.activity}
              hasQuestion={state.currentQuestion !== null}
            />
            <DoubtQueuePanel
              doubts={state.doubts}
              truncated={state.doubtsTruncated}
              canModerate
              onResolve={actions.resolveDoubt}
              onDismiss={actions.dismissDoubt}
              onRefresh={actions.refreshDoubts}
            />
          </aside>
        </div>
      </main>
    </div>
  );
}
