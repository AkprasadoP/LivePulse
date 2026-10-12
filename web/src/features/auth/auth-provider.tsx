"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { authApi } from "@/lib/api/auth";
import { configureApiClient } from "@/lib/api/client";
import type { AuthResponse, AuthUser } from "@/lib/api/types";
import { isAccessTokenExpired } from "@/lib/auth/jwt";
import { tokenStore } from "@/lib/storage/token-store";

export type AuthStatus = "loading" | "authenticated" | "anonymous";

interface AuthContextValue {
  status: AuthStatus;
  user: AuthUser | null;
  login: (email: string, password: string) => Promise<AuthUser>;
  register: (input: {
    email: string;
    password: string;
    displayName: string;
  }) => Promise<AuthUser>;
  logout: () => Promise<void>;
  /** A usable access token, refreshing when absent/expired. Null ⇒ signed out. */
  ensureAccessToken: () => Promise<string | null>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<AuthUser | null>(null);
  const mounted = useRef(true);
  const refreshInFlight = useRef<Promise<string | null> | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /**
   * Single-flight refresh. Rotation is single-use on the backend, so two
   * concurrent refreshes with the same token would trip reuse-detection and
   * sign the user out everywhere — dedup here is a correctness requirement,
   * not an optimisation.
   */
  const refresh = useCallback(async (): Promise<string | null> => {
    if (refreshInFlight.current) return refreshInFlight.current;
    const refreshToken = tokenStore.getRefreshToken();
    if (!refreshToken) return null;
    const run = (async () => {
      try {
        const tokens = await authApi.refresh(refreshToken);
        tokenStore.setTokens(tokens);
        return tokens.accessToken;
      } catch {
        tokenStore.clear();
        if (mounted.current) {
          setUser(null);
          setStatus("anonymous");
        }
        return null;
      } finally {
        refreshInFlight.current = null;
      }
    })();
    refreshInFlight.current = run;
    return run;
  }, []);

  const handleAuthFailure = useCallback(() => {
    tokenStore.clear();
    if (mounted.current) {
      setUser(null);
      setStatus("anonymous");
    }
  }, []);

  const ensureAccessToken = useCallback(async (): Promise<string | null> => {
    const existing = tokenStore.getAccessToken();
    if (existing && !isAccessTokenExpired(existing)) return existing;
    return refresh();
  }, [refresh]);

  // Wire the shared HTTP client to this auth layer.
  useEffect(() => {
    configureApiClient({
      getAccessToken: () => tokenStore.getAccessToken(),
      refreshAccessToken: refresh,
      onAuthFailure: handleAuthFailure,
    });
  }, [refresh, handleAuthFailure]);

  // Cold start: exchange a stored refresh token for a session.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!tokenStore.hasSession()) {
        if (!cancelled) setStatus("anonymous");
        return;
      }
      const token = await ensureAccessToken();
      if (cancelled) return;
      if (!token) {
        setStatus("anonymous");
        return;
      }
      try {
        const { user: me } = await authApi.me();
        if (cancelled) return;
        setUser(me);
        setStatus("authenticated");
      } catch {
        if (!cancelled) {
          tokenStore.clear();
          setUser(null);
          setStatus("anonymous");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ensureAccessToken]);

  // Another tab rotated the refresh token: adopt it so tabs agree.
  useEffect(() => {
    const sync = () => {
      if (!tokenStore.hasSession()) {
        tokenStore.clear();
        if (mounted.current) {
          setUser(null);
          setStatus("anonymous");
        }
      }
    };
    tokenStore.attachStorageSync(sync);
    return () => tokenStore.detachStorageSync(sync);
  }, []);

  const applyAuth = useCallback((response: AuthResponse) => {
    tokenStore.setTokens(response);
    setUser(response.user);
    setStatus("authenticated");
    return response.user;
  }, []);

  const login = useCallback(
    async (email: string, password: string) => applyAuth(await authApi.login({ email, password })),
    [applyAuth],
  );

  const register = useCallback(
    async (input: { email: string; password: string; displayName: string }) =>
      applyAuth(await authApi.register(input)),
    [applyAuth],
  );

  const logout = useCallback(async () => {
    const refreshToken = tokenStore.getRefreshToken();
    try {
      await authApi.logout(refreshToken);
    } catch {
      // Sign-out must never be blocked by a failing network call.
    }
    tokenStore.clear();
    setUser(null);
    setStatus("anonymous");
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ status, user, login, register, logout, ensureAccessToken }),
    [status, user, login, register, logout, ensureAccessToken],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within <AuthProvider>");
  return context;
}
