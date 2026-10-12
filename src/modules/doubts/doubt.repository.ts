import { type PrismaClient, type Doubt } from "@prisma/client";

/**
 * Data access for the Phase 6 doubt queue.
 *
 * PostgreSQL is the queue's source of truth (ADR-007). Redis is notification
 * only. The ordering authority is `doubts.enqueueSeq`, a per-session
 * monotonically increasing integer assigned by PostgreSQL inside the inserting
 * transaction while holding the session row lock — so sequence order equals
 * durable acceptance (commit) order. It is never client-set.
 *
 * Canonical order: (priority DESC, enqueueSeq ASC) over status = OPEN.
 * "FIFO" therefore means ascending enqueueSeq among equal priority — never
 * network arrival, wall clock, UUIDv7, or Redis delivery order.
 */

export interface CreateDoubtInput {
  sessionId: string;
  participantId: string;
  content: string;
  /** Optional client idempotency key for create retries (never ordering). */
  clientDoubtId?: string | undefined;
}

export type CreateDoubtResult =
  | { outcome: "created"; doubt: Doubt }
  | { outcome: "duplicate"; doubt: Doubt }
  | { outcome: "session_not_found" }
  | { outcome: "not_live" };

/** A doubt plus its author's display name (for event/snapshot payloads). */
export type DoubtWithAuthor = Doubt & {
  participant: { user: { displayName: string } };
};

export class DoubtRepository {
  public constructor(private readonly prisma: PrismaClient) {}

  /**
   * Durably accept a doubt and assign its queue sequence.
   *
   * One transaction:
   *   1. lock the session row (SELECT ... FOR UPDATE) and read its state;
   *   2. check the client idempotency key INSIDE that lock;
   *   3. allocate enqueueSeq from sessions.doubtSeq;
   *   4. insert the doubt.
   *
   * The lock is held until COMMIT, so T1's `enqueueSeq = 41` commits before
   * T2's `enqueueSeq = 42` — sequence order is real acceptance order.
   *
   * The idempotency check MUST live inside the lock: checking it outside the
   * transaction would let two concurrent retries both pass the check and
   * insert two rows. The partial unique index is only the database backstop.
   */
  public async create(input: CreateDoubtInput): Promise<CreateDoubtResult> {
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ doubtSeq: number; state: string }>>`
        SELECT "doubtSeq", "state" FROM "sessions" WHERE "id" = ${input.sessionId} FOR UPDATE
      `;
      const row = locked[0];
      if (row === undefined) return { outcome: "session_not_found" as const };
      if (row.state !== "LIVE") return { outcome: "not_live" as const };

      if (input.clientDoubtId !== undefined) {
        const existing = await tx.doubt.findFirst({
          where: {
            sessionId: input.sessionId,
            participantId: input.participantId,
            doubtRequestId: input.clientDoubtId,
          },
        });
        if (existing) return { outcome: "duplicate" as const, doubt: existing };
      }

      const nextSeq = row.doubtSeq + 1;
      await tx.session.update({ where: { id: input.sessionId }, data: { doubtSeq: nextSeq } });
      const doubt = await tx.doubt.create({
        data: {
          sessionId: input.sessionId,
          participantId: input.participantId,
          content: input.content,
          enqueueSeq: nextSeq,
          priority: 0, // server-controlled; bump is deferred (ADR-007)
          status: "OPEN",
          ...(input.clientDoubtId === undefined ? {} : { doubtRequestId: input.clientDoubtId }),
        },
      });
      return { outcome: "created" as const, doubt };
    });
  }

  public async getById(id: string): Promise<Doubt | null> {
    return this.prisma.doubt.findUnique({ where: { id } });
  }

  /**
   * Atomic terminal transition (OPEN -> RESOLVED / DISMISSED). The WHERE clause
   * is the concurrency guarantee: exactly one of two concurrent teachers (or a
   * resolve racing a dismiss) transitions the row; the loser gets null.
   * `resolvedAt` is the terminal timestamp for both outcomes.
   * `explanation` is required for RESOLVED, ignored for DISMISSED.
   */
  public async transitionStatus(
    doubtId: string,
    sessionId: string,
    to: "RESOLVED" | "DISMISSED",
    explanation?: string,
  ): Promise<Doubt | null> {
    const data: { status: "RESOLVED" | "DISMISSED"; resolvedAt: Date; explanation?: string } = {
      status: to,
      resolvedAt: new Date(),
    };
    if (to === "RESOLVED" && explanation !== undefined) {
      data.explanation = explanation;
    }
    const updated = await this.prisma.doubt.updateMany({
      where: { id: doubtId, sessionId, status: "OPEN" },
      data,
    });
    if (updated.count !== 1) return null;
    return this.prisma.doubt.findUnique({ where: { id: doubtId } });
  }

  /**
   * The canonical queue read: OPEN doubts of a session in canonical order,
   * with their author's display name. `limit` is a payload cap for recovery,
   * never a capacity limit — the database keeps every row.
   */
  public async listOpen(sessionId: string, limit?: number): Promise<DoubtWithAuthor[]> {
    return this.prisma.doubt.findMany({
      where: { sessionId, status: "OPEN" },
      orderBy: [{ priority: "desc" }, { enqueueSeq: "asc" }],
      ...(limit === undefined ? {} : { take: limit }),
      include: { participant: { include: { user: { select: { displayName: true } } } } },
    });
  }

  /** Total OPEN doubts of a session (used only for the recovery `truncated` flag). */
  public async countOpen(sessionId: string): Promise<number> {
    return this.prisma.doubt.count({ where: { sessionId, status: "OPEN" } });
  }
}
