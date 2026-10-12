/**
 * Token storage.
 *
 * Browser-security note (documented in docs/frontend/README.md): the backend
 * issues bearer tokens in JSON bodies — there is no httpOnly-cookie option —
 * so the frontend must hold them in JavaScript-accessible storage. The split:
 *
 *   access token  → memory only (short-lived, 15 min, never persisted)
 *   refresh token → localStorage (the durable credential; survives reloads)
 *
 * An XSS payload could therefore read the refresh token. That is a genuine
 * limitation of the backend's token contract, reported rather than papered
 * over. On page load the stored refresh token is exchanged for a fresh
 * in-memory access token.
 *
 * Cross-tab: the backend rotates the refresh token single-use, so tabs must
 * agree on the current one. A storage event adopts another tab's newer token.
 * The access token is NOT cleared on adoption (it remains valid for the same
 * user), which avoids a rotation ping-pong between active tabs.
 */
const REFRESH_TOKEN_KEY = "livepulse.refresh_token";

function canUseStorage(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

export class TokenStore {
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private storageBound = false;
  private readonly listeners = new Set<() => void>();
  private readonly storageListeners = new Set<() => void>();

  /**
   * Read the stored refresh token, but only while we don't hold one. A cached
   * token is authoritative until the storage event (another tab) or an explicit
   * write replaces it — so we are not re-parsing storage on every call.
   * Re-reading when empty also self-heals: if this tab starts with no session
   * and another tab signs in (or this tab's write was lost), we pick it up
   * instead of staying signed out forever.
   */
  private hydrate(): void {
    if (this.refreshToken !== null || !canUseStorage()) return;
    this.refreshToken = window.localStorage.getItem(REFRESH_TOKEN_KEY);
  }

  public getAccessToken(): string | null {
    return this.accessToken;
  }

  public getRefreshToken(): string | null {
    this.hydrate();
    return this.refreshToken;
  }

  public hasSession(): boolean {
    return this.getRefreshToken() !== null;
  }

  public setTokens(tokens: { accessToken: string; refreshToken?: string }): void {
    const wasAuthenticated = this.hasSession();
    this.accessToken = tokens.accessToken;
    if (tokens.refreshToken !== undefined) {
      this.refreshToken = tokens.refreshToken;
      if (canUseStorage()) window.localStorage.setItem(REFRESH_TOKEN_KEY, tokens.refreshToken);
    }
    if (!wasAuthenticated) this.emit();
  }

  public clear(): void {
    this.accessToken = null;
    this.refreshToken = null;
    if (canUseStorage()) window.localStorage.removeItem(REFRESH_TOKEN_KEY);
    this.emit();
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Observe refresh-token changes made by OTHER tabs (storage events). */
  public attachStorageSync(listener: () => void): void {
    this.storageListeners.add(listener);
    this.bindStorage();
  }

  public detachStorageSync(listener: () => void): void {
    this.storageListeners.delete(listener);
  }

  private bindStorage(): void {
    if (this.storageBound || !canUseStorage()) return;
    this.storageBound = true;
    window.addEventListener("storage", (event) => {
      if (event.key !== null && event.key !== REFRESH_TOKEN_KEY) return;
      this.refreshToken = window.localStorage.getItem(REFRESH_TOKEN_KEY);
      for (const listener of this.storageListeners) listener();
    });
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

export const tokenStore = new TokenStore();
