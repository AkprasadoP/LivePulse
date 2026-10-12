import { API_BASE_URL } from "@/lib/config";
import { ApiError, apiErrorFromResponse } from "./errors";

/**
 * One HTTP client for the whole app. UI components never call `fetch`.
 *
 * Responsibilities centralized here:
 *  - base URL (same-origin `/api` proxy — no CORS)
 *  - `Authorization: Bearer` injection
 *  - JSON encode/decode and the 204/empty-body case
 *  - one-shot 401 refresh: on an authorized 401 the client asks the auth layer
 *    for a fresh access token and retries ONCE. Concurrent 401s share the auth
 *    layer's single in-flight refresh (dedup lives there, not here).
 *  - typed ApiError mapping (never leaks raw JSON into the UI)
 */
export interface RequestOptions {
  method?: "GET" | "POST" | "DELETE";
  body?: unknown;
  /** Send Authorization? Default true. Auth endpoints pass false. */
  auth?: boolean;
  /** Attempt the refresh-and-retry path on 401? Default true. */
  retryOnUnauthorized?: boolean;
  signal?: AbortSignal;
}

export interface AuthHooks {
  getAccessToken: () => string | null;
  /** Exchange the refresh token for a new access token; null when it fails. */
  refreshAccessToken: () => Promise<string | null>;
  /** Called when a refresh attempt fails (session truly gone). */
  onAuthFailure?: () => void;
}

export interface ApiClientOptions extends Partial<AuthHooks> {
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private hooks: AuthHooks;

  public constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.hooks = {
      getAccessToken: options.getAccessToken ?? (() => null),
      refreshAccessToken: options.refreshAccessToken ?? (async () => null),
      ...(options.onAuthFailure ? { onAuthFailure: options.onAuthFailure } : {}),
    };
  }

  /** Wire (or re-wire) the auth layer. Called by AuthProvider on mount. */
  public configure(hooks: AuthHooks): void {
    this.hooks = hooks;
  }

  public async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const auth = options.auth ?? true;
    const retry = options.retryOnUnauthorized ?? true;

    const response = await this.send(path, options);

    if (response.status === 401 && auth && retry) {
      const refreshed = await this.hooks.refreshAccessToken();
      if (refreshed !== null) {
        // Use the token the refresh JUST returned rather than re-reading
        // getAccessToken(): the retry must not depend on the auth layer having
        // finished updating its own store before we send.
        const retried = await this.send(
          path,
          { ...options, retryOnUnauthorized: false },
          refreshed,
        );
        if (!retried.ok) throw await apiErrorFromResponse(retried);
        return this.parse<T>(retried);
      }
      this.hooks.onAuthFailure?.();
      throw await apiErrorFromResponse(response);
    }

    if (!response.ok) throw await apiErrorFromResponse(response);
    return this.parse<T>(response);
  }

  private async send(
    path: string,
    options: RequestOptions,
    accessToken?: string,
  ): Promise<Response> {
    const url = `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    if ((options.auth ?? true) === true) {
      const token = accessToken ?? this.hooks.getAccessToken();
      if (token) headers.Authorization = `Bearer ${token}`;
    }
    // Invoke through a local reference. Calling `this.fetchImpl(...)` would
    // pass this ApiClient instance as the receiver, and browsers brand-check
    // `fetch` — a foreign receiver throws "TypeError: Illegal invocation",
    // which would surface as a network error for EVERY request. A plain call
    // passes `undefined`, which every environment accepts.
    const fetchFn = this.fetchImpl;
    try {
      return await fetchFn(url, {
        method: options.method ?? "GET",
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw new ApiError({
        status: 0,
        code: "NETWORK",
        message: error instanceof Error ? error.message : "Network request failed",
      });
    }
  }

  private async parse<T>(response: Response): Promise<T> {
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    if (text.length === 0) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ApiError({
        status: response.status,
        code: "INVALID_RESPONSE",
        message: "The server returned an unexpected response",
      });
    }
  }
}

/** The app-wide client. AuthProvider wires its hooks on mount. */
export const api = new ApiClient({ baseUrl: API_BASE_URL });

export function configureApiClient(hooks: AuthHooks): void {
  api.configure(hooks);
}
