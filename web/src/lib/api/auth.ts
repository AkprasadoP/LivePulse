import { api } from "./client";
import type { AuthResponse, AuthTokens, MeResponse } from "./types";

/** Auth endpoints. `auth: false` — these establish identity and must not 401-retry. */
export const authApi = {
  register(input: { email: string; password: string; displayName: string }): Promise<AuthResponse> {
    return api.request<AuthResponse>("/auth/register", {
      method: "POST",
      body: input,
      auth: false,
      retryOnUnauthorized: false,
    });
  },

  login(input: { email: string; password: string }): Promise<AuthResponse> {
    return api.request<AuthResponse>("/auth/login", {
      method: "POST",
      body: input,
      auth: false,
      retryOnUnauthorized: false,
    });
  },

  refresh(refreshToken: string): Promise<AuthTokens> {
    return api.request<AuthTokens>("/auth/refresh", {
      method: "POST",
      body: { refreshToken },
      auth: false,
      retryOnUnauthorized: false,
    });
  },

  async logout(refreshToken: string | null): Promise<void> {
    // Idempotent 204 even for an unknown token; never blocks sign-out.
    if (!refreshToken) return;
    await api.request<void>("/auth/logout", {
      method: "POST",
      body: { refreshToken },
      auth: false,
      retryOnUnauthorized: false,
    });
  },

  me(): Promise<MeResponse> {
    return api.request<MeResponse>("/me");
  },
};
