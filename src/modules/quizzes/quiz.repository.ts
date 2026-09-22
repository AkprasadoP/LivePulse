import type { PrismaClient, Prisma, Quiz, Question } from "@prisma/client";
import { NotFoundError } from "../../shared/errors.js";

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
}

export type { Quiz, Question };
