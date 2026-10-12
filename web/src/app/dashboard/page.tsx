"use client";

import { useAuth } from "@/features/auth/auth-provider";
import { RequireAuth } from "@/features/auth/require-auth";
import { SiteHeader } from "@/components/layout/site-header";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { CreateSessionCard } from "@/features/sessions/create-session-card";
import { JoinSessionCard } from "@/features/sessions/join-session-card";
import { YourSessions } from "@/features/sessions/your-sessions";

function DashboardContent() {
  const { user } = useAuth();

  return (
    <div className="min-h-dvh">
      <SiteHeader />
      <main id="main" className="lp-container pt-10 pb-28 sm:pb-14">
        <div className="max-w-2xl">
          <h1 className="lp-display text-3xl text-ink">
            {user ? `Hello, ${user.displayName.split(" ")[0]}.` : "Hello."}
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-ink-muted">
            Open a session to teach, or join one with a link. Everything you run or attend is kept
            below.
          </p>
        </div>

        <div className="mt-8 grid gap-5 lg:grid-cols-2">
          <Card>
            <CardHeader
              title="Teach a session"
              description="You own the session — only you can run its quiz."
            />
            <CardBody>
              <CreateSessionCard />
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Join a session"
              description="Use the link your teacher shared."
            />
            <CardBody>
              <JoinSessionCard />
            </CardBody>
          </Card>
        </div>

        <Card className="mt-5">
          <CardHeader
            title="Your sessions"
            description="States are read back from the server each time you visit."
          />
          <CardBody className="p-0 sm:p-0">
            <div className="px-4 sm:px-5">
              <YourSessions />
            </div>
          </CardBody>
        </Card>
      </main>
    </div>
  );
}

export default function DashboardPage() {
  return (
    <RequireAuth>
      <DashboardContent />
    </RequireAuth>
  );
}
