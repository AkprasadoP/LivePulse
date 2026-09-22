import type { SessionState } from "@prisma/client";

/**
 * Session lifecycle, from docs/database/schema.md §3:
 *
 *   CREATED -> LIVE -> ENDED
 *      |
 *      +-------> ENDED        (cancel before going live — approved decision)
 *
 * ENDED is terminal; no transition may leave it. Quiz and question state
 * machines exist in the schema but no transitions are exposed in Phase 1.
 */
const allowedTransitions: Record<SessionState, readonly SessionState[]> = {
  CREATED: ["LIVE", "ENDED"],
  LIVE: ["ENDED"],
  ENDED: [],
};

export function canTransition(from: SessionState, to: SessionState): boolean {
  return allowedTransitions[from].includes(to);
}

export const SESSION_TRANSITIONS = allowedTransitions;
