import { z } from "zod";

/**
 * Phase 10.4 HTTP auth schemas. Email SHAPE is validated here; identity
 * canonicalization (trim + lowercase) happens in CredentialRepository on
 * every write and lookup path, so no caller can bypass it.
 */
export const registerSchema = z.object({
  // Trimmed here so surrounding whitespace is forgiven; case is normalized
  // by canonicalizeEmail() in CredentialRepository (single choke point).
  email: z.string().trim().min(3).max(320).pipe(z.email()),
  password: z.string().min(8).max(128),
  displayName: z.string().min(1).max(100),
});

export const loginSchema = z.object({
  email: z.string().min(1).max(320),
  password: z.string().min(1).max(128),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1).max(512),
});

export const logoutSchema = z.object({
  refreshToken: z.string().min(1).max(512),
});

export type RegisterRequest = z.infer<typeof registerSchema>;
export type LoginRequest = z.infer<typeof loginSchema>;
export type RefreshRequest = z.infer<typeof refreshSchema>;
export type LogoutRequest = z.infer<typeof logoutSchema>;
