/**
 * Email identity canonicalization (Phase 10.3).
 *
 * Contract (approved 10.1): `trim()` + `toLowerCase()`, applied identically
 * on every write path and every lookup path. PostgreSQL unique indexes are
 * case-sensitive byte comparisons, so without app-layer canonicalization
 * `User@x.com` and `user@x.com` would be two logins for one human.
 * Shape validation (is this string an email at all?) belongs to the HTTP
 * schemas of Phase 10.4 — this function normalizes, it does not validate.
 */
export function canonicalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}
