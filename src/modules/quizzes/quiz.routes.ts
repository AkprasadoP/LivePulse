import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { QuizRepository } from "./quiz.repository.js";
import { quizIdParamsSchema } from "./quiz.schemas.js";
import { serializeQuiz } from "./quiz.serializer.js";
import { NotFoundError } from "../../shared/errors.js";

export interface QuizRoutesOptions {
  prisma: PrismaClient;
}

export async function quizRoutes(app: FastifyInstance, options: QuizRoutesOptions): Promise<void> {
  const quizzes = new QuizRepository(options.prisma);

  app.get("/quizzes/:quizId", async (request) => {
    const { quizId } = quizIdParamsSchema.parse(request.params);
    const quiz = await quizzes.getById(quizId);
    if (!quiz) throw new NotFoundError("Quiz", quizId);
    return { quiz: serializeQuiz(quiz) };
  });
}
