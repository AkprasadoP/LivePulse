/**
 * Accepts whatever a student is likely to paste — a full link, a path, or a
 * bare id — and returns the session id, or null when nothing usable is found.
 *
 * The backend validates `sessionId` as a UUID before touching the database
 * (`INVALID_SESSION_ID` / HTTP 400), so accepting only id-shaped input means a
 * typo or a pasted sentence becomes a clear "check your link" message instead
 * of a request the server can only reject. Existence is still the server's
 * call — this only rejects input that cannot possibly be an id.
 */
const BARE_ID = /^[0-9a-zA-Z_-]{8,64}$/;
const SESSION_PATH = /\/sessions\/([^/?#\s]+)/;

export function parseSessionIdInput(raw: string): string | null {
  const value = raw.trim();
  if (value.length === 0) return null;

  // A bare id (someone copied just the value out of a link).
  if (BARE_ID.test(value)) return value;

  // A link whose session segment is id-shaped.
  const fromPath = SESSION_PATH.exec(value);
  if (fromPath?.[1] && BARE_ID.test(fromPath[1])) return fromPath[1];

  return null;
}
