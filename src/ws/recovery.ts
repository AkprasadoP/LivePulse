import type { PrismaClient, Quiz, Question, Answer } from "@prisma/client";
import { z } from "zod";
import { recoverySnapshotSchema, type DoubtView } from "./protocol.js";
import type { AnswerRepository } from "../modules/answers/answer.repository.js";
import type { DoubtRepository } from "../modules/doubts/doubt.repository.js";

/**
 * Payload cap for doubts inside a snapshot response. This bounds the join/list
 * frame; it is NOT a queue capacity — PostgreSQL keeps and serves every row.
 */
export const DOUBT_SNAPSHOT_LIMIT = 100;

/**
 * Phase 5 recovery snapshot builder (ADR-006).
 *
 * Assembles the authoritative state a reconnecting client needs, purely
 * from PostgreSQL — the same tables every missable live event announced:
 *
 *   quiz.started        → quizzes.state
 *   question.published  → questions.state = PUBLISHED
 *   answer.accepted     → answers row
 *   leaderboard.updated → derivable from answers
 *   question.closed     → questions.state = CLOSED
 *
 * Boundary rules:
 *   - NO Redis involvement; NO in-memory registry reads. Any instance can
 *     build this snapshot for any session (cross-instance reconnect is the
 *     same code path as same-instance reconnect).
 *   - Pure read: never writes, never mutates session/quiz/question state.
 *   - correctAnswer NEVER crosses the wire.
 *   - Failure is non-fatal: the caller catches and degrades to
 *     `recovery: null` so recovery can never break joining itself.
 */

export type RecoverySnapshot = z.infer<typeof recoverySnapshotSchema>;

/** The question section: PUBLISHED or CLOSED, most recently touched first. */
function pickCurrentQuestion(questions: Question[]): Question | null {
  const candidates = questions.filter((q) => q.state !== "DRAFT");
  if (candidates.length === 0) return null;
  // At most one is ever PUBLISHED (DB partial unique index); among the rest
  // the most recently transitioned (updatedAt DESC) wins, position ASC as
  // the deterministic tie-break.
  return [...candidates].sort(
    (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || a.position - b.position,
  )[0] as Question;
}

/** The bound participant's stored attempt-1 verdict for one question, if any. */
function pickOwnAnswer(
  answers: Answer[],
  questionId: string | null,
): RecoverySnapshot["ownAnswer"] {
  if (questionId === null) return null;
  const own = answers.find((a) => a.questionId === questionId && a.attemptNumber === 1);
  if (!own) return null;
  return {
    questionId: own.questionId,
    content: own.content,
    isCorrect: own.isCorrect,
    isWinner: own.isWinner,
    attemptNumber: own.attemptNumber,
    submittedAt: own.submittedAt.toISOString(),
  };
}

export interface RecoverySnapshotDeps {
  prisma: PrismaClient;
  answerRepository: AnswerRepository;
  /** Phase 6: the OPEN doubt queue is part of the authoritative snapshot. */
  doubtRepository: DoubtRepository;
}

/**
 * Read the snapshot for one session. `participantId` may be null (view-only
 * join): the snapshot is identical except `ownAnswer` is always null.
 *
 * Returns `null` when the session has nothing to reconcile — no quizzes AND no
 * open doubts. A doubt-only session still gets a snapshot (empty quizzes
 * section, populated doubts section). `null` is the minimal, honest snapshot.
 */
export async function buildRecoverySnapshot(
  deps: RecoverySnapshotDeps,
  sessionId: string,
  participantId: string | null,
): Promise<RecoverySnapshot | null> {
  const { prisma, answerRepository, doubtRepository } = deps;

  // One query per concern; all reads. Quizzes include their questions so the
  // current-question selection happens in memory (sessions have a handful of
  // quizzes with ordered questions — not an open-ended scan).
  const quizzes = await prisma.quiz.findMany({
    where: { sessionId },
    orderBy: { createdAt: "asc" },
    include: { questions: { orderBy: { position: "asc" } } },
  });

  // Phase 6: the OPEN queue is authoritative current state too. Read it with
  // the canonical order and a payload cap; the count drives the truncation
  // flag (rows are never deleted by the cap).
  const [openDoubts, openDoubtCount] = await Promise.all([
    doubtRepository.listOpen(sessionId, DOUBT_SNAPSHOT_LIMIT),
    doubtRepository.countOpen(sessionId),
  ]);

  if (quizzes.length === 0 && openDoubtCount === 0) return null;

  // The current question, if any, drives both its section and the standings.
  const currentQuestion = pickCurrentQuestion(quizzes.flatMap((quiz) => quiz.questions));

  // Only answers for the current question matter to the snapshot's ownAnswer
  // and standings sections. (Per-question standings mirror the close-time
  // broadcast exactly; a cross-question leaderboard is a later-phase feature.)
  const answers =
    participantId !== null && currentQuestion !== null
      ? await prisma.answer.findMany({
          where: { participantId, questionId: currentQuestion.id },
        })
      : [];

  const ownAnswer = pickOwnAnswer(answers, currentQuestion?.id ?? null);
  const standings =
    currentQuestion !== null
      ? await answerRepository.leaderboardForQuestion(currentQuestion.id)
      : [];

  return recoverySnapshotSchema.parse({
    quizzes: quizzes.map((quiz: Quiz) => ({
      quizId: quiz.id,
      state: quiz.state,
      startedAt: quiz.startedAt?.toISOString() ?? null,
    })),
    question:
      currentQuestion === null
        ? null
        : {
            quizId: currentQuestion.quizId,
            questionId: currentQuestion.id,
            position: currentQuestion.position,
            prompt: currentQuestion.prompt,
            hasCorrectAnswer: currentQuestion.correctAnswer !== null,
            firstCorrectWins: currentQuestion.firstCorrectWins,
            state: currentQuestion.state as "PUBLISHED" | "CLOSED",
            acceptingAnswers: currentQuestion.state === "PUBLISHED",
          },
    ownAnswer,
    standings,
    doubts: {
      open: openDoubts.map((doubt): DoubtView => ({
        doubtId: doubt.id,
        participantId: doubt.participantId,
        displayName: doubt.participant.user.displayName,
        content: doubt.content,
        priority: doubt.priority,
        enqueueSeq: doubt.enqueueSeq,
        status: doubt.status,
        createdAt: doubt.createdAt.toISOString(),
      })),
      truncated: openDoubtCount > openDoubts.length,
    },
  });
}
