"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect } from "react";
import { RequireAuth } from "@/features/auth/require-auth";
import { useLiveSession } from "@/features/live/use-live-session";
import { TeacherRoom } from "@/features/live/components/teacher-room";
import { StudentRoom } from "@/features/live/components/student-room";
import { ConnectionStatusPill } from "@/features/live/components/connection-status";
import { sessionIndex } from "@/lib/storage/session-index";
import { buttonStyles } from "@/components/ui/button";
import { Logo } from "@/components/layout/logo";
import { Card, CardBody } from "@/components/ui/card";
import { EmptyState, Skeleton } from "@/components/ui/feedback";

/**
 * One live session, two rooms.
 *
 * The route is identical for both roles: `session.joined` is what tells us
 * whether this connection is the session's teacher or a student, and that role
 * is resolved by the server from the authenticated user — the client never
 * decides it.
 */
export default function LiveSessionPage() {
  const params = useParams<{ sessionId: string }>();
  const sessionId = typeof params?.sessionId === "string" ? params.sessionId : "";

  return (
    <RequireAuth>{sessionId ? <SessionView sessionId={sessionId} /> : <MissingId />}</RequireAuth>
  );
}

function SessionView({ sessionId }: { sessionId: string }) {
  const session = useLiveSession(sessionId);
  const { state, sessionName } = session;

  // Remember the session (and the role the server granted) so the dashboard
  // can list it later.
  useEffect(() => {
    if (state.role && state.sessionId === sessionId) {
      sessionIndex.upsert({
        id: sessionId,
        name: sessionName ?? "Live session",
        role: state.role,
      });
    }
  }, [state.role, state.sessionId, sessionId, sessionName]);

  if (session.sessionMissing) {
    return <SessionGone />;
  }

  if (!state.joined) {
    return <JoiningShell sessionId={sessionId} status={session.status} />;
  }

  return state.role === "TEACHER" ? (
    <TeacherRoom session={session} />
  ) : (
    <StudentRoom session={session} />
  );
}

/** Shown while the socket authenticates and joins — never a blank page. */
function JoiningShell({
  sessionId,
  status,
}: {
  sessionId: string;
  status: ReturnType<typeof useLiveSession>["status"];
}) {
  return (
    <div className="min-h-dvh">
      <div className="border-b border-border">
        <div className="lp-container flex h-14 items-center justify-between">
          <Link href="/dashboard" aria-label="LivePulse home">
            <Logo />
          </Link>
          <ConnectionStatusPill status={status} />
        </div>
      </div>
      <main id="main" className="lp-container max-w-3xl space-y-5 py-8" aria-busy="true">
        <span className="sr-only">Joining the session…</span>
        <Skeleton className="h-7 w-64" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-28 w-full" />
        <Card>
          <CardBody>
            <EmptyState
              title="Joining the session"
              description={`Session ${sessionId.slice(0, 8)}…`}
            />
          </CardBody>
        </Card>
      </main>
    </div>
  );
}

function SessionGone() {
  return (
    <CenteredMessage
      title="This session can't be found"
      description="The link may be wrong, or the session was removed. Ask your teacher to share it again."
    />
  );
}

function MissingId() {
  return (
    <CenteredMessage
      title="That link looks incomplete"
      description="Open the session from your dashboard, or paste the full link your teacher shared."
    />
  );
}

function CenteredMessage({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <div className="border-b border-border">
        <div className="lp-container flex h-14 items-center">
          <Link href="/dashboard" aria-label="LivePulse home">
            <Logo />
          </Link>
        </div>
      </div>
      <main id="main" className="lp-container flex max-w-lg flex-1 items-center py-10">
        <Card className="w-full">
          <CardBody>
            <EmptyState
              title={title}
              description={description}
              action={
                <Link href="/dashboard" className={buttonStyles("secondary", "sm")}>
                  Back to dashboard
                </Link>
              }
            />
          </CardBody>
        </Card>
      </main>
    </div>
  );
}
