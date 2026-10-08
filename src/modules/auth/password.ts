import argon2 from "argon2";

/**
 * Password hashing (Phase 10.3): Argon2id only.
 *
 * Parameters measured on Apple M2 (2026-10-08, argon2@0.45.1):
 *
 *   production  m=65536 KiB (64 MiB), t=3, p=1  → ~129 ms/hash, ~114 ms/verify
 *   test        m=1024 KiB (1 MiB),   t=1, p=1  → ~1 ms (suites stay fast)
 *
 * Rationale: 64 MiB / t=3 follows the RFC 9106 first-recommendation shape;
 * parallelism stays 1 deliberately (Node serves many concurrent logins on
 * one loop — per-hash threads would multiply CPU contention). The ~130 ms
 * cost applies only to register/login, never to request handling or WS
 * frames. bcrypt was rejected (72-byte password truncation).
 *
 * Profiles: `NODE_ENV === "test"` selects the test profile automatically;
 * production always uses the production profile. Never log or return hashes
 * (or passwords) — these functions have no logging and no serialization.
 *
 * Native-module note: argon2 ships prebuilt binaries for common platforms
 * (verified darwin-arm64). The Alpine production image builds from source,
 * so the Dockerfile build stage will need python3/make/g++ when auth ships
 * (later phase — not added here).
 */
export interface Argon2Profile {
  memoryCost: number;
  timeCost: number;
  parallelism: number;
}

export const PRODUCTION_ARGON2_PROFILE: Argon2Profile = {
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1,
};

export const TEST_ARGON2_PROFILE: Argon2Profile = {
  memoryCost: 1_024,
  timeCost: 1,
  parallelism: 1,
};

export function currentArgon2Profile(): Argon2Profile {
  return process.env.NODE_ENV === "test" ? TEST_ARGON2_PROFILE : PRODUCTION_ARGON2_PROFILE;
}

export async function hashPassword(
  password: string,
  profile: Argon2Profile = currentArgon2Profile(),
): Promise<string> {
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: profile.memoryCost,
    timeCost: profile.timeCost,
    parallelism: profile.parallelism,
  });
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    // Malformed stored hash: authentication fails closed, never throws.
    return false;
  }
}
