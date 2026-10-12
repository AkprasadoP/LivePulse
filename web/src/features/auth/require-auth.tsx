"use client";

import { useRouter, usePathname } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { useAuth } from "./auth-provider";
import { Skeleton } from "@/components/ui/feedback";
import { Logo } from "@/components/layout/logo";

/**
 * Client-side route guard.
 *
 * The session lives in an in-memory access token plus a localStorage refresh
 * token — the backend has no cookie/session concept the server could read — so
 * the guard has to run in the browser. While the cold-start hydrate is in
 * flight it renders a neutral skeleton rather than flashing the sign-in page.
 * On an expired session it redirects, preserving the intended path in `?next=`.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (status === "anonymous") {
      const next =
        pathname && pathname !== "/dashboard" ? `?next=${encodeURIComponent(pathname)}` : "";
      router.replace(`/login${next}`);
    }
  }, [status, router, pathname]);

  if (status === "authenticated") return <>{children}</>;

  if (status === "anonymous") {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Logo />
      </div>
    );
  }

  return (
    <div className="lp-container space-y-6 py-10" aria-busy="true" aria-live="polite">
      <span className="sr-only">Restoring your session…</span>
      <Skeleton className="h-8 w-56" />
      <div className="grid gap-4 sm:grid-cols-2">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    </div>
  );
}
