import { Prisma, type PrismaClient, type Answer } from "@prisma/client";
import type { Question } from "@prisma/client";
import { NotFoundError } from "../../shared/errors.js";

/**
 * Data access for answer submission with first-correct-wins election.
 *
 * The critical guarantee lives in the database, not in this class: the
 * partial unique index `answers_one_winner_per_question_key` on
 * (questionId) WHERE isWinner = true makes the winning INSERT itself the
 * election. See docs/decisions/004 for the full analysis.
 */
export class AnswerRepository {
  public constructor(private readonly prisma: PrismaClient) {}

  /**
   * Persist one submission and elect the first correct winner atomically.
   *
   * Serialization contract (chosen deliberately, documented in ADR-004):
   * the answer row is created INSIDE a transaction that first locks the
   * question row with FOR NO KEY UPDATE (via raw SQL — Prisma cannot express
   * row locks). The lock conflicts with itself AND with the close UPDATE, so:
   *
   *   - two correct submissions serialize: the second blocks until the first
   *     commits, then re-reads and sees the winner — its own INSERT proceeds
   *     with isWinner = false. Every valid answer is persisted; exactly one
   *     is elected. (FOR SHARE would NOT do this: shared locks are mutually
   *     compatible, so both submitters would race to the winner index and
   *     the loser would abort with its answer unpersisted.)
   *   - the close transition (PUBLISHED -> CLOSED) is a writer on the same
   *     row and therefore conflicts with an in-flight submission: no answer
   *     is ever persisted after the question closed (either order wins the
   *     row lock atomically — close-then-submit sees CLOSED and rejects;
   *     submit-then-close persists the answer first).
   *   - the session state transition (LIVE -> ENDED) also conflicts: the
   *     transaction locks the session row with FOR NO KEY UPDATE, which
   *     conflicts with the session's conditional UPDATE (check-and-set). This
   *     guarantees no answer is accepted after the session ends, regardless
   *     of which transaction commits first.
   *
   * `submittedAt` ordering is NOT the winner criterion: "first" is defined
   * by which submission's transaction acquires the row lock and commits the
   * winning INSERT — the atomic operation this phase documents (see protocol
   * doc "Ordering" section). The partial unique index on (questionId) WHERE
   * isWinner stays as defense-in-depth for any future code path that skips
   * the lock.
   */
  public async submitWithElection(input: {
    question: Question;
    participantId: string;
    content: string;
    sessionId: string;
  }): Promise<
    | { outcome: "accepted"; answer: Answer }
    | { outcome: "accepted-winner"; answer: Answer }
    | { outcome: "duplicate"; answer: Answer }
    | { outcome: "rejected"; reason: "not_accepting_answers" | "session_ended" }
  > {
    const { question, participantId, content, sessionId } = input;

    return this.prisma.$transaction(
      async (tx) => {
        // 1. Lock the session row (FOR NO KEY UPDATE: serializes with the
        //    session state transition's conditional UPDATE). This guarantees
        //    that no answer is accepted after the session ends — whichever
        //    transaction commits first wins the race atomically.
        const lockedSession = await tx.$queryRaw<Array<{ state: string }>>`
          SELECT "state" FROM "sessions" WHERE "id" = ${sessionId} FOR NO KEY UPDATE
        `;
        const sessionState = lockedSession[0]?.state;
        if (sessionState === undefined) {
          throw new NotFoundError("Session", sessionId);
        }
        if (sessionState === "ENDED") {
          return { outcome: "rejected" as const, reason: "session_ended" as const };
        }

        // 2. Lock the question row (FOR NO KEY UPDATE: serializes concurrent
        //    submitters with each other and with the close transition).
        const locked = await tx.$queryRaw<Array<{ state: string }>>`
          SELECT "state" FROM "questions" WHERE "id" = ${question.id} FOR NO KEY UPDATE
        `;
        const questionState = locked[0]?.state;
        if (questionState === undefined) {
          throw new NotFoundError("Question", question.id);
        }

        // 3. Re-check acceptance under the lock (question may have closed
        //    between the handler's pre-check and this transaction).
        if (questionState !== "PUBLISHED") {
          return { outcome: "rejected" as const, reason: "not_accepting_answers" as const };
        }

        // 4. Duplicate detection: an existing attempt by this participant
        //    (attemptNumber 1 in this phase) means the retry arrived after a
        //    committed first submission. Idempotent-replay: return the stored
        //    answer with its original verdict instead of a constraint error.
        //    A duplicate is ALWAYS `duplicate`, even when the stored answer is
        //    the winner: the caller replays the private verdict but must not
        //    re-broadcast, or a retry of the winning answer would re-rank the
        //    session (Phase 3 "broadcast once" contract).
        const previous = await tx.answer.findFirst({
          where: { questionId: question.id, participantId, attemptNumber: 1 },
        });
        if (previous) {
          return { outcome: "duplicate" as const, answer: previous };
        }

        // 5. Correctness is decided by the SERVER against the stored key.
        //    correctAnswer is nullable: null key => ungraded (isCorrect null).
        const isCorrect =
          question.correctAnswer === null ? null : content === question.correctAnswer;

        // 6. Election: the first correct submission INSERTs isWinner = true.
        //    Under the lock + read-then-insert, only one transaction can reach
        //    this INSERT with isWinner true; the partial unique index is the
        //    backstop if that ever changes.
        let isWinner = false;
        if (isCorrect === true) {
          const winnerCount = await tx.answer.count({
            where: { questionId: question.id, isWinner: true },
          });
          if (winnerCount === 0) {
            isWinner = true;
          }
        }

        // 7. Persist (single INSERT; the unique attempt constraint still
        //    guards against any duplicate attemptNumber slipping through).
        const answer = await tx.answer.create({
          data: {
            questionId: question.id,
            participantId,
            content,
            attemptNumber: 1,
            isCorrect,
            isWinner,
          },
        });
        return { outcome: isWinner ? ("accepted-winner" as const) : ("accepted" as const), answer };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  }

  /**
   * Minimum leaderboard: derived from authoritative answer state — grouped
   * correct answers per participant. No dedicated ranking structures; the
   * (questionId, submittedAt) index serves the per-question reads.
   */
  public async leaderboardForQuestion(
    questionId: string,
  ): Promise<
    Array<{ participantId: string; displayName: string; correctCount: number; isWinner: boolean }>
  > {
    return this.prisma.$queryRaw`
      SELECT
        sp."id"              AS "participantId",
        u."displayName",
        COUNT(*)::int        AS "correctCount",
        COALESCE(BOOL_OR(a."isWinner"), false) AS "isWinner"
      FROM "answers" a
      JOIN "session_participants" sp ON sp."id" = a."participantId"
      JOIN "users" u ON u."id" = sp."userId"
      WHERE a."questionId" = ${questionId} AND a."isCorrect" = true
      GROUP BY sp."id", u."displayName"
      ORDER BY "isWinner" DESC, "correctCount" DESC, u."displayName" ASC
    `;
  }
}
