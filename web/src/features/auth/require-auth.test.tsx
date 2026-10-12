import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RequireAuth } from "./require-auth";

const state = vi.hoisted(() => ({
  status: "loading" as "loading" | "authenticated" | "anonymous",
  pathname: "/dashboard",
  replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: state.replace, push: vi.fn() }),
  usePathname: () => state.pathname,
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    [key: string]: unknown;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("@/features/auth/auth-provider", () => ({
  useAuth: () => ({ status: state.status }),
}));

beforeEach(() => {
  state.status = "loading";
  state.pathname = "/dashboard";
  state.replace.mockClear();
});

describe("RequireAuth", () => {
  it("shows a restoring-session skeleton while hydrating, without redirecting", () => {
    render(
      <RequireAuth>
        <div>secret</div>
      </RequireAuth>,
    );

    expect(screen.getByText("Restoring your session…")).toBeInTheDocument();
    expect(screen.queryByText("secret")).not.toBeInTheDocument();
    expect(state.replace).not.toHaveBeenCalled();
  });

  it("redirects an anonymous visitor to the sign-in page", () => {
    state.status = "anonymous";

    render(
      <RequireAuth>
        <div>secret</div>
      </RequireAuth>,
    );

    expect(screen.queryByText("secret")).not.toBeInTheDocument();
    expect(state.replace).toHaveBeenCalledWith("/login");
    expect(state.replace).toHaveBeenCalledTimes(1);
  });

  it("preserves the intended path so the user lands where they meant to", () => {
    state.status = "anonymous";
    state.pathname = "/sessions/018f3c2e-1111-4222-8333-444455556666";

    render(
      <RequireAuth>
        <div>secret</div>
      </RequireAuth>,
    );

    expect(state.replace).toHaveBeenCalledWith(
      "/login?next=%2Fsessions%2F018f3c2e-1111-4222-8333-444455556666",
    );
  });

  it("renders protected content only once authenticated", () => {
    state.status = "authenticated";

    render(
      <RequireAuth>
        <div>secret</div>
      </RequireAuth>,
    );

    expect(screen.getByText("secret")).toBeInTheDocument();
    expect(state.replace).not.toHaveBeenCalled();
  });
});
