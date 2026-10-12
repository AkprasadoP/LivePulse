import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "./auth-provider";
import { tokenStore } from "@/lib/storage/token-store";

type Auth = ReturnType<typeof useAuth>;

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  me: vi.fn(),
  login: vi.fn(),
  register: vi.fn(),
  logout: vi.fn(),
  configureApiClient: vi.fn(),
}));

vi.mock("@/lib/api/auth", () => ({
  authApi: {
    refresh: mocks.refresh,
    me: mocks.me,
    login: mocks.login,
    register: mocks.register,
    logout: mocks.logout,
  },
}));

vi.mock("@/lib/api/client", () => ({
  configureApiClient: mocks.configureApiClient,
}));

const REFRESH_KEY = "livepulse.refresh_token";

function renderAuth() {
  const captured: { current: Auth | null } = { current: null };

  function Capture() {
    const auth = useAuth();
    captured.current = auth;
    return <div data-testid="status">{auth.status}</div>;
  }

  render(
    <AuthProvider>
      <Capture />
    </AuthProvider>,
  );
  return captured;
}

/** Wait for the provider to settle on an auth status. */
async function expectStatus(value: "loading" | "authenticated" | "anonymous") {
  await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent(value));
}

beforeEach(() => {
  // Clear through the store so in-memory state and storage agree.
  tokenStore.clear();
  window.localStorage.clear();
  mocks.refresh.mockReset();
  mocks.me.mockReset();
  mocks.login.mockReset();
  mocks.register.mockReset();
  mocks.logout.mockReset();
  mocks.configureApiClient.mockReset();
});

describe("AuthProvider cold start", () => {
  it("resolves to anonymous without touching the network when nothing is stored", async () => {
    renderAuth();

    await expectStatus("anonymous");
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.me).not.toHaveBeenCalled();
  });

  it("exchanges a stored refresh token for a session", async () => {
    window.localStorage.setItem(REFRESH_KEY, "refresh-1");
    mocks.refresh.mockResolvedValue({
      accessToken: "access-1",
      refreshToken: "refresh-2",
      expiresIn: 900,
    });
    mocks.me.mockResolvedValue({
      user: { id: "u1", email: "a@b.co", displayName: "Ana" },
    });

    renderAuth();

    await expectStatus("authenticated");
    expect(mocks.refresh).toHaveBeenCalledWith("refresh-1");
    expect(mocks.me).toHaveBeenCalledTimes(1);
  });

  it("clears the session and goes anonymous when refresh fails", async () => {
    window.localStorage.setItem(REFRESH_KEY, "refresh-bad");
    mocks.refresh.mockRejectedValue(new Error("401"));

    renderAuth();

    await expectStatus("anonymous");
    expect(window.localStorage.getItem(REFRESH_KEY)).toBeNull();
  });

  it("goes anonymous when the stored token exchanges but /me is refused", async () => {
    window.localStorage.setItem(REFRESH_KEY, "refresh-1");
    mocks.refresh.mockResolvedValue({
      accessToken: "access-1",
      refreshToken: "refresh-2",
      expiresIn: 900,
    });
    mocks.me.mockRejectedValue(new Error("401"));

    renderAuth();

    await expectStatus("anonymous");
    expect(window.localStorage.getItem(REFRESH_KEY)).toBeNull();
  });

  it("wires the HTTP client's auth hooks exactly once", async () => {
    renderAuth();

    await expectStatus("anonymous");
    expect(mocks.configureApiClient).toHaveBeenCalledTimes(1);
    const hooks = mocks.configureApiClient.mock.calls[0]![0] as {
      getAccessToken: () => string | null;
      refreshAccessToken: () => Promise<string | null>;
      onAuthFailure: () => void;
    };
    expect(hooks.getAccessToken()).toBeNull();
    expect(typeof hooks.refreshAccessToken).toBe("function");
    expect(typeof hooks.onAuthFailure).toBe("function");
  });
});

describe("AuthProvider single-flight refresh", () => {
  it("shares one in-flight refresh between concurrent callers", async () => {
    window.localStorage.setItem(REFRESH_KEY, "refresh-1");
    let resolveRefresh: (value: { accessToken: string; refreshToken: string; expiresIn: number }) => void =
      () => undefined;
    mocks.refresh.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    mocks.me.mockResolvedValue({ user: { id: "u1", email: "a@b.co", displayName: "Ana" } });

    const auth = renderAuth();
    await waitFor(() => expect(auth.current).not.toBeNull());

    const first = auth.current!.ensureAccessToken();
    const second = auth.current!.ensureAccessToken();

    resolveRefresh({ accessToken: "access-1", refreshToken: "refresh-2", expiresIn: 900 });

    await expect(first).resolves.toBe("access-1");
    await expect(second).resolves.toBe("access-1");
    // Rotation is single-use on the backend: two refreshes would trip the
    // reuse detector and sign the user out everywhere.
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });
});

describe("AuthProvider sign-in and sign-out", () => {
  it("login stores tokens and reports the authenticated user", async () => {
    const auth = renderAuth();
    await expectStatus("anonymous");

    mocks.login.mockResolvedValue({
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresIn: 900,
      user: { id: "u1", email: "a@b.co", displayName: "Ana" },
    });

    await auth.current!.login("a@b.co", "password123");

    await expectStatus("authenticated");
    expect(window.localStorage.getItem(REFRESH_KEY)).toBe("refresh-1");
    expect(mocks.login).toHaveBeenCalledWith({ email: "a@b.co", password: "password123" });
  });

  it("logout clears local credentials even if the server call fails", async () => {
    window.localStorage.setItem(REFRESH_KEY, "refresh-1");
    mocks.refresh.mockResolvedValue({
      accessToken: "access-1",
      refreshToken: "refresh-2",
      expiresIn: 900,
    });
    mocks.me.mockResolvedValue({ user: { id: "u1", email: "a@b.co", displayName: "Ana" } });

    const auth = renderAuth();
    await expectStatus("authenticated");

    mocks.logout.mockRejectedValue(new Error("offline"));
    await auth.current!.logout();

    await expectStatus("anonymous");
    expect(window.localStorage.getItem(REFRESH_KEY)).toBeNull();
  });
});
