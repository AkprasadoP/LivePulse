-- Phase 3: live quiz execution + first-correct-answer election.
--
-- Hand-completed statements are marked below. Prisma cannot express partial
-- unique indexes; they are the atomic winner-election mechanism and the
-- one-published-question invariant — see docs/decisions/004.

-- AlterTable
ALTER TABLE "answers" ADD COLUMN     "isWinner" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex (from schema: displayName is now the development identity seam key)
CREATE UNIQUE INDEX "users_displayName_key" ON "users"("displayName");

-- ---------------------------------------------------------------------------
-- HAND-WRITTEN (Prisma cannot express partial unique indexes)
-- ---------------------------------------------------------------------------

-- Winner election: at most ONE winning answer per question, enforced by the
-- database itself. The winning INSERT is the election — concurrent correct
-- submissions lose here with a constraint violation, atomically. See ADR-004.
CREATE UNIQUE INDEX "answers_one_winner_per_question_key"
  ON "answers" ("questionId")
  WHERE "isWinner" = true;

-- Delivery invariant: at most ONE published (answer-accepting) question per
-- quiz. Makes the publish transition CAS-style even for direct DB writes.
CREATE UNIQUE INDEX "questions_one_published_per_quiz_key"
  ON "questions" ("quizId")
  WHERE "state" = 'PUBLISHED';
