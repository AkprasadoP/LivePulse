import { describe, expect, it, vi } from "vitest";
import { ApiClient } from "./client";
import { ApiError } from "./errors";

/** A fetch stand-in that records calls and replies from a queue. */
function makeFetch(responses: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (next === undefined) throw new Error("no queued response");
    if (next instanceof Error) throw next;
    return next;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeClient(options: {
  responses: Array<Response | Error>;
  token?: string | null;
  refresh?: () => Promise<string | null>;
  onAuthFailure?: () => void;
}) {
  const { impl, calls } = makeFetch(options.responses);
  const client = new ApiClient({
    baseUrl: "/api",
    fetchImpl: impl,
    getAccessToken: () => options.token ?? null,
    refreshAccessToken: options.refresh ?? (async () => null),
    ...(options.onAuthFailure ? { onAuthFailure: options.onAuthFailure } : {}),
  });
  return { client, calls };
}

describe("ApiClient", () => {
  it("prefixes the base URL and injects the bearer token", async () => {
    const { client, calls } = makeClient({ responses: [json({ ok: true })], token: "access-1" });

    await client.request("/me");

    expect(calls[0]!.url).toBe("/api/me");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer access-1");
  });

  it("omits Authorization for auth:false endpoints", async () => {
    const { client, calls } = makeClient({ responses: [json({ ok: true })], token: "access-1" });

    await client.request("/auth/login", { method: "POST", body: {}, auth: false });

    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("encodes a JSON body and sets Content-Type", async () => {
    const { client, calls } = makeClient({ responses: [json({ ok: true })] });

    await client.request("/sessions", { method: "POST", body: { name: "Physics" } });

    expect(calls[0]!.init.body).toBe(JSON.stringify({ name: "Physics" }));
    expect((calls[0]!.init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
  });

  it("returns undefined for a 204 with no body", async () => {
    const { client } = makeClient({ responses: [new Response(null, { status: 204 })] });

    await expect(client.request("/auth/logout", { method: "POST" })).resolves.toBeUndefined();
  });

  it("refreshes once on a 401 and returns the retried payload", async () => {
    const refresh = vi.fn(async () => "access-2");
    const { client, calls } = makeClient({
      responses: [json({ message: "expired" }, 401), json({ user: { id: "u1" } })],
      token: "access-1",
      refresh,
    });

    const result = await client.request<{ user: { id: string } }>("/me");

    expect(result.user.id).toBe("u1");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
    // The retried call carries the refreshed token.
    expect((calls[1]!.init.headers as Record<string, string>).Authorization).toBe("Bearer access-2");
  });

  it("surfaces the 401 and reports auth failure when refresh cannot recover", async () => {
    const onAuthFailure = vi.fn();
    const { client, calls } = makeClient({
      responses: [json({ message: "Invalid token" }, 401)],
      token: "access-1",
      refresh: async () => null,
      onAuthFailure,
    });

    await expect(client.request("/me")).rejects.toMatchObject({ status: 401 });
    expect(onAuthFailure).toHaveBeenCalledTimes(1);
    // No retry happened: only the original request was sent.
    expect(calls).toHaveLength(1);
  });

  it("does not attempt a refresh for auth:false endpoints", async () => {
    const refresh = vi.fn(async () => "access-2");
    const { client } = makeClient({
      responses: [json({ message: "Invalid email or password" }, 401)],
      refresh,
    });

    await expect(
      client.request("/auth/login", { method: "POST", body: {}, auth: false }),
    ).rejects.toMatchObject({ status: 401, isUnauthorized: true });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("maps a transport failure to a network ApiError (status 0)", async () => {
    const { client } = makeClient({ responses: [new TypeError("Failed to fetch")] });

    const error = await client.request("/me").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).isNetwork).toBe(true);
    expect((error as ApiError).status).toBe(0);
  });

  it("extracts field issues from a 400 validation body", async () => {
    const { client } = makeClient({
      responses: [
        json(
          {
            statusCode: 400,
            error: "Bad Request",
            message: "Request validation failed",
            // The real backend shape: a flat array under `details`.
            details: [{ path: "questions.0.prompt", message: "Too short" }],
          },
          400,
        ),
      ],
    });

    const error = (await client.request("/sessions/x/quizzes", { method: "POST" }).catch(
      (caught: unknown) => caught,
    )) as ApiError;

    expect(error.isValidation).toBe(true);
    expect(error.fieldIssues).toEqual([{ path: "questions.0.prompt", message: "Too short" }]);
  });

  it("reads a nested issues array without crashing", async () => {
    const { client } = makeClient({
      responses: [
        json({ statusCode: 400, error: "Bad Request", details: { issues: [{ path: "name" }] } }, 400),
      ],
    });

    const error = (await client.request("/sessions", { method: "POST" }).catch(
      (caught: unknown) => caught,
    )) as ApiError;

    expect(error.fieldIssues).toEqual([{ path: "name", message: "Invalid value" }]);
  });

  it("never passes the client instance as `this` to fetch", async () => {
    // Regression: `this.fetchImpl(url, …)` hands fetch the ApiClient instance
    // as its receiver. Browsers brand-check `fetch` and throw
    // "TypeError: Illegal invocation" for any non-global receiver, which the
    // catch-all in `send()` would misreport as a network error. Real fetch
    // accepts only undefined/null/globalThis — assert we never do worse.
    const receivers: unknown[] = [];
    const impl = function (this: unknown, _url: string | URL | Request, _init?: RequestInit) {
      receivers.push(this);
      return Promise.resolve(json({ ok: true }));
    };
    const client = new ApiClient({
      baseUrl: "/api",
      fetchImpl: impl as unknown as typeof fetch,
    });

    await client.request("/me");

    expect(receivers).toHaveLength(1);
    expect(receivers[0]).not.toBe(client);
    expect([undefined, null, globalThis]).toContain(receivers[0]);
  });

  it("does not retry more than once on a repeated 401", async () => {
    const refresh = vi.fn(async () => "access-2");
    const { client, calls } = makeClient({
      responses: [json({ message: "expired" }, 401), json({ message: "still bad" }, 401)],
      token: "access-1",
      refresh,
    });

    await expect(client.request("/me")).rejects.toMatchObject({ status: 401 });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
  });
});

describe("describeApiError", () => {
  it("gives a human sentence for every error class", async () => {
    const { describeApiError } = await import("./errors");
    expect(
      describeApiError(new ApiError({ status: 0, code: "NETWORK", message: "x" })),
    ).toMatch(/can't reach/i);
    expect(
      describeApiError(new ApiError({ status: 401, code: "HTTP_401", message: "x" })),
    ).toMatch(/sign in again/i);
    expect(
      describeApiError(new ApiError({ status: 403, code: "HTTP_403", message: "" })),
    ).toMatch(/permission/i);
    expect(
      describeApiError(new ApiError({ status: 404, code: "HTTP_404", message: "" })),
    ).toMatch(/couldn't find/i);
    expect(
      describeApiError(new ApiError({ status: 500, code: "HTTP_500", message: "" })),
    ).toMatch(/try again/i);
    expect(describeApiError(new Error("boom"))).toMatch(/something went wrong/i);
  });
});
