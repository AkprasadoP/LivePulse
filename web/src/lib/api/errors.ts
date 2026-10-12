/** A structured API failure. UI code switches on `status`/`code`, never on strings. */
export class ApiError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly details: unknown;

  public constructor(input: { status: number; code: string; message: string; details?: unknown }) {
    super(input.message);
    this.name = "ApiError";
    this.status = input.status;
    this.code = input.code;
    this.details = input.details ?? null;
  }

  public get isUnauthorized(): boolean {
    return this.status === 401;
  }
  public get isForbidden(): boolean {
    return this.status === 403;
  }
  public get isNotFound(): boolean {
    return this.status === 404;
  }
  public get isValidation(): boolean {
    return this.status === 400;
  }
  public get isConflict(): boolean {
    return this.status === 409;
  }
  public get isNetwork(): boolean {
    return this.status === 0;
  }

  /**
   * Extract the `{path, message}` pairs the backend attaches to a 400.
   *
   * `ApiError.details` holds the whole response body, and the HTTP handler puts
   * `details` on that body as a FLAT ARRAY (`details: [{path, message}]`) when a
   * Zod schema rejects the request. The defensive branches cover a nested
   * `{details: {issues: []}}` shape and a top-level `issues` array too, so a
   * future shape change degrades to "no field issues" instead of a crash.
   */
  public get fieldIssues(): Array<{ path: string; message: string }> {
    const normalize = (value: unknown): Array<{ path: string; message: string }> => {
      if (!Array.isArray(value)) return [];
      return value.flatMap((entry) => {
        if (typeof entry !== "object" || entry === null) return [];
        const issue = entry as { path?: unknown; message?: unknown };
        return [
          {
            path: typeof issue.path === "string" ? issue.path : "",
            message: typeof issue.message === "string" ? issue.message : "Invalid value",
          },
        ];
      });
    };

    const shape = this.details;
    if (Array.isArray(shape)) return normalize(shape);
    if (typeof shape !== "object" || shape === null) return [];

    const record = shape as Record<string, unknown>;
    const details = record.details;
    if (Array.isArray(details)) return normalize(details);
    if (typeof details === "object" && details !== null) {
      const issues = (details as Record<string, unknown>).issues;
      if (Array.isArray(issues)) return normalize(issues);
      return [];
    }
    if (Array.isArray(record.issues)) return normalize(record.issues);
    return [];
  }
}

/** Build an ApiError from a fetch Response, tolerating non-JSON bodies. */
export async function apiErrorFromResponse(response: Response): Promise<ApiError> {
  let body: unknown = null;
  let text = "";
  try {
    text = await response.text();
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    body = text.length > 0 ? { message: text } : null;
  }
  const record = (body ?? {}) as { message?: unknown; error?: unknown; code?: unknown };
  const message = typeof record.message === "string" ? record.message : response.statusText;
  const code = typeof record.code === "string" ? record.code : `HTTP_${response.status}`;
  return new ApiError({
    status: response.status,
    code,
    message: message || "Request failed",
    details: body,
  });
}

/**
 * A short, human sentence for an ApiError. Never dumps JSON; validation issues
 * are summarized rather than rendered raw.
 */
export function describeApiError(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return "Something went wrong. Please try again.";
  }
  if (error.isNetwork) {
    return "Can't reach LivePulse. Check your connection and try again.";
  }
  if (error.isUnauthorized) {
    return "Your session has expired. Please sign in again.";
  }
  if (error.isForbidden) {
    return error.message && error.message !== "Forbidden"
      ? error.message
      : "You don't have permission to do that.";
  }
  if (error.isNotFound) {
    return "We couldn't find that. It may have been removed.";
  }
  if (error.isValidation) {
    const issues = error.fieldIssues;
    if (issues.length > 0) {
      return issues.length === 1
        ? issues[0]!.message
        : `Please fix ${issues.length} fields and try again.`;
    }
    return "That request wasn't valid. Check the highlighted fields.";
  }
  if (error.isConflict) {
    return error.message || "That conflicts with something that already exists.";
  }
  if (error.status >= 500) {
    return "LivePulse hit an error. Please try again in a moment.";
  }
  return error.message || "Request failed.";
}
