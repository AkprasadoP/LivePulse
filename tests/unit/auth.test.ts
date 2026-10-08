import { describe, expect, it } from "vitest";
import * as jose from "jose";
import { canonicalizeEmail } from "../../src/modules/auth/email.js";
import {
  hashPassword,
  verifyPassword,
  TEST_ARGON2_PROFILE,
} from "../../src/modules/auth/password.js";
import {
  TokenService,
  hashRefreshToken,
  ACCESS_TOKEN_TTL_SECONDS,
} from "../../src/modules/auth/token.service.js";

const SECRET = "test-access-secret-that-is-long-enough-32b";

describe("email canonicalization", () => {
  it.each([
    ["User@Example.COM", "user@example.com"],
    ["  spaced@example.com  ", "spaced@example.com"],
    ["ALREADY@lower.com", "already@lower.com"],
    ["MiXeD@Sub.Domain.COM", "mixed@sub.domain.com"],
  ])("canonicalizes %s", (raw, expected) => {
    expect(canonicalizeEmail(raw)).toBe(expected);
  });
});

describe("password hashing (test profile)", () => {
  it("roundtrips and rejects wrong passwords", async () => {
    const hash = await hashPassword("correct-horse-42", TEST_ARGON2_PROFILE);
    expect(hash).not.toContain("correct-horse-42");
    expect(await verifyPassword(hash, "correct-horse-42")).toBe(true);
    expect(await verifyPassword(hash, "wrong")).toBe(false);
  });

  it("fails closed on malformed stored hashes", async () => {
    expect(await verifyPassword("not-a-hash", "anything")).toBe(false);
  });
});

describe("token service", () => {
  it("issues and verifies access tokens", async () => {
    const svc = new TokenService(SECRET);
    const token = await svc.issueAccessToken("user-123");
    expect(await svc.verifyAccessToken(token)).toEqual({ ok: true, userId: "user-123" });
  });

  it("rejects tampered and wrong-secret tokens as invalid", async () => {
    const svc = new TokenService(SECRET);
    const token = await svc.issueAccessToken("user-123");
    const tampered = token.slice(0, -2) + (token.endsWith("aa") ? "bb" : "aa");
    expect(await svc.verifyAccessToken(tampered)).toEqual({ ok: false, reason: "invalid" });
    expect(
      await new TokenService("a-different-secret-that-is-long-enough!!").verifyAccessToken(token),
    ).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("reports expiry distinctly from invalid", async () => {
    const secret = new TextEncoder().encode(SECRET);
    const expired = await new jose.SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("user-123")
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) - 10)
      .sign(secret);
    expect(await new TokenService(SECRET).verifyAccessToken(expired)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("rejects short secrets at construction", () => {
    expect(() => new TokenService("too-short")).toThrow();
  });

  it("mints opaque refresh tokens stored as deterministic hashes", () => {
    const svc = new TokenService(SECRET);
    const { token, tokenHash } = svc.mintRefreshToken();
    expect(token).toHaveLength(43);
    expect(tokenHash).not.toContain(token);
    expect(tokenHash).toBe(hashRefreshToken(token));
    expect(svc.mintRefreshToken().token).not.toBe(token);
  });

  it("access TTL is the documented 15 minutes", () => {
    expect(ACCESS_TOKEN_TTL_SECONDS).toBe(900);
  });
});
