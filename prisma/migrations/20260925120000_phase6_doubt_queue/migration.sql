-- Phase 6: persistent, concurrent doubt queue with PostgreSQL-enforced ordering.
--
-- PostgreSQL is the queue's source of truth; Redis stays notification-only
-- (ADR-007). Ordering is (priority DESC, enqueueSeq ASC) over OPEN rows.
--
-- Hand-completed statements are marked below. Prisma cannot express partial
-- unique indexes; like the Phase 3 winner/open-question indexes, the
-- idempotency guard lives here in raw SQL.

-- AlterEnum: teacher can clear a doubt without answering it (terminal).
ALTER TYPE "DoubtStatus" ADD VALUE 'DISMISSED';

-- AlterTable sessions: per-session enqueue counter. Incremented under the
-- session row lock inside the doubt-insert transaction, so enqueueSeq order
-- equals durable acceptance order.
ALTER TABLE "sessions" ADD COLUMN "doubtSeq" INTEGER NOT NULL DEFAULT 0;

-- AlterTable doubts: the ordering authority (server-assigned).
-- Added with a temporary default so it is NOT NULL on any existing rows, then
-- the default is dropped: enqueueSeq is always supplied by the repository.
ALTER TABLE "doubts" ADD COLUMN "enqueueSeq" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "doubts" ALTER COLUMN "enqueueSeq" DROP DEFAULT;

-- AlterTable doubts: optional client idempotency key for create retries.
ALTER TABLE "doubts" ADD COLUMN "doubtRequestId" VARCHAR(64);

-- Replace the deferred-ordering index (priority DESC, createdAt ASC) with the
-- committed queue index: OPEN doubts of a session in canonical order.
DROP INDEX "doubts_sessionId_status_priority_createdAt_idx";
CREATE INDEX "doubts_sessionId_status_priority_enqueueSeq_idx"
  ON "doubts"("sessionId", "status", "priority" DESC, "enqueueSeq" ASC);

-- Uniqueness of the ordering key within a session: no two doubts can share a
-- queue position. (Prisma schema expresses this as @@unique([sessionId, enqueueSeq]).)
CREATE UNIQUE INDEX "doubts_sessionId_enqueueSeq_key" ON "doubts"("sessionId", "enqueueSeq");

-- ---------------------------------------------------------------------------
-- HAND-WRITTEN (Prisma cannot express partial unique indexes)
-- ---------------------------------------------------------------------------

-- Create idempotency: a retried doubt.create (same clientDoubtId, same
-- participant, same session) can never create a second row. The in-transaction
-- check is the primary mechanism; this index is the database backstop, exactly
-- like the Phase 3 winner index. NULL clientDoubtId rows are unconstrained.
CREATE UNIQUE INDEX "doubts_client_request_key"
  ON "doubts"("sessionId", "participantId", "doubtRequestId")
  WHERE "doubtRequestId" IS NOT NULL;
