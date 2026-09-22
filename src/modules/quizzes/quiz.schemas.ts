import { z } from "zod";

export const createQuizSchema = z.object({
  title: z.string().min(1).max(200),
  questions: z
    .array(
      z.object({
        prompt: z.string().min(1).max(2_000),
        correctAnswer: z.string().min(1).max(2_000).optional(),
        firstCorrectWins: z.boolean().optional(),
      }),
    )
    .max(100) // sanity cap for Phase 1; raise when a real flow needs more
    .optional(),
});

export const quizIdParamsSchema = z.object({
  quizId: z.uuid(),
});

export type CreateQuizRequest = z.infer<typeof createQuizSchema>;
