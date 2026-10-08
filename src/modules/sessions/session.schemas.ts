import { z } from "zod";

export const sessionIdParamsSchema = z.object({
  sessionId: z.uuid(),
});

export const createSessionSchema = z.object({
  name: z.string().min(1).max(200),
  // Phase 10.7: no client-supplied creator identity. The creator is the
  // authenticated token subject (route-level), never request input.
});

export const sessionStateTransitionSchema = z.object({
  state: z.enum(["LIVE", "ENDED"]),
});

export type CreateSessionRequest = z.infer<typeof createSessionSchema>;
export type SessionStateTransitionRequest = z.infer<typeof sessionStateTransitionSchema>;
