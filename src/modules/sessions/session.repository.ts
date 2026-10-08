import type {
  PrismaClient,
  Prisma,
  Session,
  SessionParticipant,
  SessionState,
} from "@prisma/client";
import { NotFoundError, InvalidStateTransitionError } from "../../shared/errors.js";
import { canTransition } from "./session.state.js";

export interface CreateSessionInput {
  name: string;
  creatorDisplayName: string;
}

export type SessionWithCreator = Prisma.SessionGetPayload<{ include: { creator: true } }>;

/**
 * Data access for sessions. Domain-specific operations only — no generic
 * repository abstraction (ADR philosophy: thin, explicit, inspectable).
 *
 * State transitions are performed with a single conditional UPDATE
 * (check-and-set), which is atomic in PostgreSQL: concurrent transitions
 * cannot interleave, exactly one caller wins, the loser gets
 * InvalidStateTransitionError. See ADR-002.
 */
export class SessionRepository {
  public constructor(private readonly prisma: PrismaClient) {}

  public async createWithCreator(input: CreateSessionInput): Promise<{
    session: Session;
    creatorUser: { id: string; displayName: string };
    teacherParticipant: SessionParticipant;
  }> {
    return this.prisma.$transaction(async (tx) => {
      // Auto-provisioned creator (approved Phase 1 decision — no auth yet).
      const creatorUser = await tx.user.create({
        data: { displayName: input.creatorDisplayName },
      });

      const session = await tx.session.create({
        data: { name: input.name, creatorId: creatorUser.id },
      });

      // The creator becomes the session's first TEACHER participant.
      const teacherParticipant = await tx.sessionParticipant.create({
        data: { sessionId: session.id, userId: creatorUser.id, role: "TEACHER" },
      });

      return { session, creatorUser, teacherParticipant };
    });
  }

  public async getById(id: string): Promise<SessionWithCreator | null> {
    return this.prisma.session.findUnique({ where: { id }, include: { creator: true } });
  }

  /**
   * Phase 10.6: create a session owned by an ALREADY authenticated user.
   * Same atomic shape as createWithCreator (session + TEACHER participant or
   * neither) but mints no user row — the creator identity comes from the
   * verified token subject, never from request input.
   */
  public async createWithExistingCreator(input: { name: string; creatorId: string }): Promise<{
    session: Session;
    teacherParticipant: SessionParticipant;
  }> {
    return this.prisma.$transaction(async (tx) => {
      const session = await tx.session.create({
        data: { name: input.name, creatorId: input.creatorId },
      });
      const teacherParticipant = await tx.sessionParticipant.create({
        data: { sessionId: session.id, userId: input.creatorId, role: "TEACHER" },
      });
      return { session, teacherParticipant };
    });
  }

  public async getByIdWithParticipants(id: string): Promise<{
    session: Session;
    participants: Array<SessionParticipant & { user: { id: string; displayName: string } }>;
  } | null> {
    const session = await this.prisma.session.findUnique({
      where: { id },
      include: { participants: { include: { user: { select: { id: true, displayName: true } } } } },
    });
    if (!session) return null;
    const { participants, ...rest } = session;
    return { session: rest, participants };
  }

  public async getParticipant(
    sessionId: string,
    userId: string,
  ): Promise<SessionParticipant | null> {
    return this.prisma.sessionParticipant.findUnique({
      where: { sessionId_userId: { sessionId, userId } },
    });
  }

  /**
   * Atomic state transition. `updatedAt`/timestamp columns are set in the
   * same statement, so a successful row update is the whole story.
   * Returns the updated session; throws on unknown id or invalid transition.
   */
  public async transitionState(id: string, to: SessionState): Promise<Session> {
    const current = await this.prisma.session.findUnique({
      where: { id },
      select: { state: true },
    });
    if (!current) throw new NotFoundError("Session", id);
    if (!canTransition(current.state, to)) {
      throw new InvalidStateTransitionError("session", id, current.state, to);
    }

    const timestampData: Prisma.SessionUpdateInput =
      to === "LIVE"
        ? { state: to, startedAt: new Date() }
        : to === "ENDED"
          ? { state: to, endedAt: new Date() }
          : { state: to };

    // check-and-set: the WHERE clause is the concurrency guarantee.
    const updated = await this.prisma.session.updateMany({
      where: { id, state: current.state },
      data: timestampData,
    });
    if (updated.count !== 1) {
      // A concurrent writer changed the state between our read and write.
      throw new InvalidStateTransitionError("session", id, current.state, to);
    }

    const session = await this.prisma.session.findUnique({ where: { id } });
    if (!session) throw new NotFoundError("Session", id); // deleted concurrently (cannot happen today)
    return session;
  }
}
