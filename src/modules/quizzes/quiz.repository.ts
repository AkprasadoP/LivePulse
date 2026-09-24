import {
  Prisma,
  type PrismaClient,
  type Quiz,
  type Question,
  type QuizState,
  type QuestionState,
} from "@prisma/client";
import { NotFoundError, InvalidStateTransitionError } from "../../shared/errors.js";

export interface CreateQuizInput {
  title: string;
  // `| undefined` is deliberate: the Zod-inferred request body type assigns
  // optional properties explicitly, and tsconfig uses exactOptionalPropertyTypes.
  questions?:
    | Array<{
        prompt: string;
        correctAnswer?: string | undefined;
        firstCorrectWins?: boolean | undefined;
      }>
    | undefined;
}

export type QuizWithQuestions = Prisma.QuizGetPayload<{ include: { questions: true } }>;

/**
 * Data access for quizzes and their questions.
 * Quiz/question lifecycle transitions are intentionally NOT exposed yet —
 * teacher actions arrive in Phase 3. (Questions are created in DRAFT state,
 * inline with the quiz, per the approved Phase 1 decision.)
 */
export class QuizRepository {
  public constructor(private readonly prisma: PrismaClient) {}

  /**
   * Creates a quiz and (optionally) its ordered questions in one
   * transaction. Positions are assigned by array order, 1-based.
   */
  public async createForSession(
    sessionId: string,
    input: CreateQuizInput,
  ): Promise<QuizWithQuestions> {
    // Fail before the transaction if the session does not exist.
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: { id: true },
    });
    if (!session) throw new NotFoundError("Session", sessionId);

    return this.prisma.$transaction(async (tx) => {
      const quiz = await tx.quiz.create({
        data: { sessionId, title: input.title },
      });

      if (input.questions && input.questions.length > 0) {
        await tx.question.createMany({
          data: input.questions.map((q, index) => ({
            quizId: quiz.id,
            position: index + 1,
            prompt: q.prompt,
            correctAnswer: q.correctAnswer ?? null,
            firstCorrectWins: q.firstCorrectWins ?? true,
          })),
        });
      }

      const full = await tx.quiz.findUniqueOrThrow({
        where: { id: quiz.id },
        include: { questions: { orderBy: { position: "asc" } } },
      });
      return full;
    });
  }

  public async getById(id: string): Promise<QuizWithQuestions | null> {
    return this.prisma.quiz.findUnique({
      where: { id },
      include: { questions: { orderBy: { position: "asc" } } },
    });
  }

  public async listBySession(sessionId: string): Promise<Quiz[]> {
    return this.prisma.quiz.findMany({
      where: { sessionId },
      orderBy: { createdAt: "asc" },
    });
  }

  public async getQuestionById(id: string): Promise<Question | null> {
    return this.prisma.question.findUnique({ where: { id } });
  }

  /**
   * Atomic quiz transition (check-and-set in one UPDATE — same pattern as
   * SessionRepository.transitionState). Timestamps set in the same statement.
   */
  public async transitionQuizState(id: string, to: QuizState): Promise<Quiz> {
    const current = await this.prisma.quiz.findUnique({ where: { id }, select: { state: true } });
    if (!current) throw new NotFoundError("Quiz", id);
    if (!canTransitionQuiz(current.state, to)) {
      throw new InvalidStateTransitionError("quiz", id, current.state, to);
    }
    const data: Prisma.QuizUpdateInput =
      to === "ACTIVE"
        ? { state: to, startedAt: new Date() }
        : to === "COMPLETED"
          ? { state: to, endedAt: new Date() }
          : { state: to };
    const updated = await this.prisma.quiz.updateMany({
      where: { id, state: current.state },
      data,
    });
    if (updated.count !== 1) {
      throw new InvalidStateTransitionError("quiz", id, current.state, to);
    }
    const quiz = await this.prisma.quiz.findUnique({ where: { id } });
    if (!quiz) throw new NotFoundError("Quiz", id);
    return quiz;
  }

  /**
   * Atomic question transition. DRAFT -> PUBLISHED additionally relies on the
   * partial unique index "questions_one_published_per_quiz_key": if another
   * question of this quiz is already PUBLISHED, the database rejects the
   * transition and we surface it as an invalid-transition error. That makes
   * the one-published-question invariant hold even under concurrent publishes.
   */
  public async transitionQuestionState(id: string, to: QuestionState): Promise<Question> {
    const current = await this.prisma.question.findUnique({
      where: { id },
      select: { state: true, quizId: true },
    });
    if (!current) throw new NotFoundError("Question", id);
    if (!canTransitionQuestion(current.state, to)) {
      throw new InvalidStateTransitionError("question", id, current.state, to);
    }
    try {
      // (Question publish/close timestamps are not modeled; updatedAt tracks
      // the transition. Add explicit columns only if a phase needs them.)
      const updated = await this.prisma.question.updateMany({
        where: { id, state: current.state },
        data: { state: to },
      });
      if (updated.count !== 1) {
        throw new InvalidStateTransitionError("question", id, current.state, to);
      }
    } catch (error) {
      // The partial unique index fired: another question is already PUBLISHED.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new InvalidStateTransitionError("question", id, current.state, to);
      }
      throw error;
    }
    const question = await this.prisma.question.findUnique({ where: { id } });
    if (!question) throw new NotFoundError("Question", id);
    return question;
  }
}

import { canTransitionQuiz, canTransitionQuestion } from "./quiz.state.js";

export type { Quiz, Question };
