import type { Connection } from "./connection.js";
import type { HandlerDependencies } from "./handlers.js";
import { send, broadcast } from "./handlers.js";
import { NotFoundError } from "../shared/errors.js";
import {
  quizStartedMessage,
  questionPublishedMessage,
  questionClosedMessage,
  answerAcceptedMessage,
  answerRejectedMessage,
  leaderboardUpdatedMessage,
  errorMessage,
  type ServerEnvelope,
} from "./protocol.js";

/**
 * Teacher + student quiz operations (Phase 3).
 *
 * quiz.start / question.publish / question.close live on the WebSocket (not
 * HTTP) because their *effect* is real-time propagation to every joined
 * connection; HTTP would add a second channel for the same fact. The
 * teacher identity comes from the connection's bound participant (TEACHER
 * role enforced by the guards in handlers.ts).
 *
 * All broadcasts go to every connection joined to the session via the
 * in-memory registry (single instance — ADR-003).
 */
function requireJoined(connection: Connection): string | null {
  return connection.joinedSessionId === null ? null : connection.joinedSessionId;
}

export async function handleQuizStart(
  connection: Connection,
  payload: { quizId: string },
  requestId: string,
  deps: HandlerDependencies,
): Promise<void> {
  const sessionId = requireJoined(connection);
  if (sessionId === null || connection.participantId === null) return;

  const quiz = await deps.quizRepository.getById(payload.quizId);
  // A quiz from another session is treated as unknown — it leaks nothing.
  if (!quiz || quiz.sessionId !== sessionId) {
    throw new NotFoundError("Quiz", payload.quizId);
  }
  const session = await deps.sessionRepository.getById(sessionId);
  if (!session) throw new NotFoundError("Session", sessionId);
  if (session.state !== "LIVE") {
    send(
      connection,
      errorMessage(requestId, {
        code: "SESSION_NOT_LIVE",
        message: "Start the session before starting a quiz",
        details: null,
      }),
      deps.log,
    );
    return;
  }

  const updated = await deps.quizRepository.transitionQuizState(quiz.id, "ACTIVE");
  deps.log.info({ sessionId, quizId: quiz.id }, "WebSocket quiz started");
  // COMMIT succeeded -> local broadcast -> post-commit publish (in that
  // order; Redis is never inside the PostgreSQL transaction — ADR-005).
  broadcast(
    deps,
    sessionId,
    quizStartedMessage(requestId, {
      sessionId,
      quizId: updated.id,
      state: updated.state,
    }),
  );
  deps.distributor?.publish({
    type: "quiz.started",
    sessionId,
    payload: { sessionId, quizId: updated.id, state: updated.state },
  });
}

export async function handleQuestionPublish(
  connection: Connection,
  payload: { questionId: string },
  requestId: string,
  deps: HandlerDependencies,
): Promise<void> {
  const sessionId = requireJoined(connection);
  if (sessionId === null || connection.participantId === null) return;

  const question = await deps.quizRepository.getQuestionById(payload.questionId);
  if (!question) throw new NotFoundError("Question", payload.questionId);
  const quiz = await deps.quizRepository.getById(question.quizId);
  if (!quiz || quiz.sessionId !== sessionId) {
    // Cross-session question is treated as unknown (leaks nothing).
    throw new NotFoundError("Question", payload.questionId);
  }
  if (quiz.state !== "ACTIVE") {
    send(
      connection,
      errorMessage(requestId, {
        code: "QUIZ_NOT_ACTIVE",
        message: "Start the quiz before publishing questions",
        details: null,
      }),
      deps.log,
    );
    return;
  }

  const updated = await deps.quizRepository.transitionQuestionState(question.id, "PUBLISHED");
  deps.log.info(
    { sessionId, quizId: quiz.id, questionId: question.id },
    "WebSocket question published",
  );
  broadcast(
    deps,
    sessionId,
    questionPublishedMessage(requestId, {
      sessionId,
      quizId: quiz.id,
      questionId: updated.id,
      position: updated.position,
      // correctAnswer NEVER crosses the wire; firstCorrectWins is public.
      prompt: updated.prompt,
      firstCorrectWins: updated.firstCorrectWins,
      acceptingAnswers: true,
    }),
  );
  // An empty leaderboard immediately after publish closes the "did my
  // standings reset" question for clients.
  broadcast(
    deps,
    sessionId,
    leaderboardUpdatedMessage(requestId, {
      sessionId,
      questionId: updated.id,
      standings: [],
    }),
  );
  // Notices map 1:1 to the origin's remote-visible broadcast frames: the
  // publish flow emits question.published AND the empty-leaderboard reset.
  deps.distributor?.publish({
    type: "question.published",
    sessionId,
    payload: {
      sessionId,
      quizId: quiz.id,
      questionId: updated.id,
      position: updated.position,
      prompt: updated.prompt,
      firstCorrectWins: updated.firstCorrectWins,
      acceptingAnswers: true,
    },
  });
  deps.distributor?.publish({
    type: "leaderboard.updated",
    sessionId,
    payload: { sessionId, questionId: updated.id, standings: [] },
  });
}

export async function handleQuestionClose(
  connection: Connection,
  payload: { questionId: string },
  requestId: string,
  deps: HandlerDependencies,
): Promise<void> {
  const sessionId = requireJoined(connection);
  if (sessionId === null || connection.participantId === null) return;

  const question = await deps.quizRepository.getQuestionById(payload.questionId);
  if (!question) throw new NotFoundError("Question", payload.questionId);
  const quiz = await deps.quizRepository.getById(question.quizId);
  if (!quiz || quiz.sessionId !== sessionId) {
    throw new NotFoundError("Question", payload.questionId);
  }

  const updated = await deps.quizRepository.transitionQuestionState(question.id, "CLOSED");
  deps.log.info(
    { sessionId, quizId: quiz.id, questionId: question.id },
    "WebSocket question closed",
  );
  broadcast(
    deps,
    sessionId,
    questionClosedMessage(requestId, {
      sessionId,
      quizId: quiz.id,
      questionId: updated.id,
    }),
  );
  broadcast(
    deps,
    sessionId,
    leaderboardUpdatedMessage(requestId, {
      sessionId,
      questionId: updated.id,
      standings: await deps.answerRepository.leaderboardForQuestion(question.id),
    }),
  );
  deps.distributor?.publish({
    type: "question.closed",
    sessionId,
    payload: { sessionId, quizId: quiz.id, questionId: updated.id },
  });
  deps.distributor?.publish({
    type: "leaderboard.updated",
    sessionId,
    payload: {
      sessionId,
      questionId: updated.id,
      standings: await deps.answerRepository.leaderboardForQuestion(question.id),
    },
  });
}

/**
 * quiz.answer — the Phase 3 centerpiece.
 *
 * Delivery semantics: the submitting connection always receives exactly one
 * targeted result correlated by requestId (answer.accepted with isWinner,
 * or error with the failure code). Duplicate submissions are idempotent
 * replays: the stored verdict is returned again. Then the session sees a
 * broadcast. If the submitting socket died before the response, the answer
 * REMAINS persisted — server-side success and client-side acknowledgement
 * are different things (see protocol doc, failure section).
 */
export async function handleQuizAnswer(
  connection: Connection,
  payload: { questionId: string; content: string },
  requestId: string,
  deps: HandlerDependencies,
): Promise<void> {
  const sessionId = requireJoined(connection);
  const participantId = connection.participantId;
  if (sessionId === null || participantId === null) return;

  const question = await deps.quizRepository.getQuestionById(payload.questionId);
  if (!question) throw new NotFoundError("Question", payload.questionId);
  const quiz = await deps.quizRepository.getById(question.quizId);
  if (!quiz || quiz.sessionId !== sessionId) {
    // Cross-session question is treated as unknown (leaks nothing).
    throw new NotFoundError("Question", payload.questionId);
  }

  // Persist + elect atomically (ADR-004). Duplicate-safe; re-checks question
  // state under the row lock, so an in-flight close is respected.
  const result = await deps.answerRepository.submitWithElection({
    question,
    participantId,
    content: payload.content,
  });

  if (result.outcome === "rejected") {
    send(
      connection,
      errorMessage(requestId, {
        code: "QUESTION_NOT_ACCEPTING_ANSWERS",
        message: "This question is not accepting answers",
        details: null,
      }),
      deps.log,
    );
    return;
  }

  // Targeted, request-correlated verdict for the submitter.
  send(
    connection,
    answerAcceptedMessage(requestId, {
      sessionId,
      questionId: question.id,
      participantId,
      displayName: connection.displayName ?? "",
      isCorrect: result.answer.isCorrect,
      isWinner: result.answer.isWinner,
      attemptNumber: result.answer.attemptNumber,
    }),
    deps.log,
  );

  // Broadcasts only for fresh, correctness-relevant submissions. A duplicate
  // replay re-sends the private verdict but does NOT re-broadcast or re-rank.
  if (result.outcome === "duplicate") {
    deps.log.info(
      { sessionId, questionId: question.id, participantId },
      "WebSocket duplicate answer replay",
    );
    return;
  }

  broadcast(
    deps,
    sessionId,
    answerAcceptedMessage(null, {
      sessionId,
      questionId: question.id,
      participantId,
      displayName: connection.displayName ?? "",
      isCorrect: result.answer.isCorrect,
      isWinner: result.answer.isWinner,
      attemptNumber: result.answer.attemptNumber,
    }),
  );
  const standings = await deps.answerRepository.leaderboardForQuestion(question.id);
  broadcast(
    deps,
    sessionId,
    leaderboardUpdatedMessage(null, {
      sessionId,
      questionId: question.id,
      standings,
    }),
  );
  // Notices map 1:1 to the origin's remote-visible broadcast frames (design
  // §8, amended during implementation): remote instances render one frame per
  // notice with NO database access on the receive path.
  deps.distributor?.publish({
    type: "answer.accepted",
    sessionId,
    payload: {
      sessionId,
      questionId: question.id,
      participantId,
      displayName: connection.displayName ?? "",
      isCorrect: result.answer.isCorrect,
      isWinner: result.answer.isWinner,
      attemptNumber: result.answer.attemptNumber,
    },
  });
  deps.distributor?.publish({
    type: "leaderboard.updated",
    sessionId,
    payload: { sessionId, questionId: question.id, standings },
  });
}
