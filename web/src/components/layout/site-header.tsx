"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useAuth } from "@/features/auth/auth-provider";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Logo } from "./logo";

/**
 * The signed-in top bar. Deliberately thin: one row, brand on the left, the
 * user on the right. Navigation lives in the page content, not here, because
 * LivePulse has exactly two destinations (dashboard, live session).
 */
export function SiteHeader({ children }: { children?: React.ReactNode }) {
  const { user, logout } = useAuth();
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  return (
    <header className="sticky top-0 z-10 border-b border-border bg-canvas/85 backdrop-blur">
      <div className="lp-container flex h-14 items-center justify-between gap-4">
        <Link
          href="/dashboard"
          className="rounded-xs focus-visible:outline-2"
          aria-label="LivePulse home"
        >
          <Logo />
        </Link>

        <div className="flex items-center gap-3">
          {children}
          {user ? (
            <div className="flex items-center gap-2.5">
              <div className="hidden items-center gap-2 sm:flex">
                <Avatar name={user.displayName} seed={user.id} size="sm" />
                <span className="max-w-[12rem] truncate text-sm text-ink-muted">
                  {user.displayName}
                </span>
              </div>
              <Button
                variant="ghost"
                size="sm"
                loading={signingOut}
                onClick={async () => {
                  setSigningOut(true);
                  try {
                    await logout();
                  } finally {
                    router.replace("/");
                  }
                }}
              >
                Sign out
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
}
