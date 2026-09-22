import { z } from "zod";

export const sessionIdParamsSchema = z.object({
  sessionId: z.uuid(),
});

export const createSessionSchema = z.object({
  name: z.string().min(1).max(200),
  // No authentication yet: the creator is auto-provisioned (approved decision).
  creator: z
    .object({
      displayName: z.string().min(1).max(100),
    })
    .optional(),
});

export const sessionStateTransitionSchema = z.object({
  state: z.enum(["LIVE", "ENDED"]),
});

export type CreateSessionRequest = z.infer<typeof createSessionSchema>;
export type SessionStateTransitionRequest = z.infer<typeof sessionStateTransitionSchema>;
