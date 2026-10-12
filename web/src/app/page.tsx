import Link from "next/link";
import type { Metadata } from "next";
import { Logo } from "@/components/layout/logo";
import { buttonStyles } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export const metadata: Metadata = {
  title: "LivePulse — real-time classroom",
  description:
    "Run live quizzes, a doubt queue and presence for your classroom. First correct answer wins, and every result is durable.",
};

const CAPABILITIES = [
  {
    title: "Live quizzes",
    body: "Publish a question and the whole room sees it at once. Publish the next one when you are ready — the leaderboard resets per question.",
  },
  {
    title: "First correct wins",
    body: "Grading happens on the server the moment an answer commits. The first submission to win the race is the winner — not the first one sent.",
  },
  {
    title: "A doubt queue that holds",
    body: "Students raise doubts during the session. You resolve or dismiss them, and the order is the order the server accepted them in.",
  },
  {
    title: "Presence you can trust",
    body: "See who is actually connected, not who claims to be. Presence is derived from live connections, never from a form field.",
  },
  {
    title: "Reconnect without losing the room",
    body: "Drop a connection and rejoin: the current question, your own answer, the standings and the queue all come back from durable state.",
  },
  {
    title: "Durable by default",
    body: "Answers, participants and doubts live in PostgreSQL. A websocket blip never costs a result.",
  },
] as const;

const STEPS = [
  {
    role: "Teacher",
    title: "Open a session",
    body: "Name it, start it, and share the link. You own the session — only you can run it.",
  },
  {
    role: "Teacher",
    title: "Write a quiz",
    body: "Add questions with an answer key when you want graded scoring, or leave the key blank for an open response.",
  },
  {
    role: "Both",
    title: "Run it live",
    body: "Publish, watch answers land, keep an eye on the board and clear doubts as they arrive.",
  },
] as const;

export default function LandingPage() {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-border">
        <div className="lp-container flex h-16 items-center justify-between">
          <Logo />
          <nav className="flex items-center gap-2">
            <Link href="/login" className={buttonStyles("ghost", "sm")}>
              Sign in
            </Link>
            <Link href="/register" className={buttonStyles("primary", "sm")}>
              Create account
            </Link>
          </nav>
        </div>
      </header>

      <main id="main" className="flex-1">
        {/* Hero — editorial display type, one accent, lots of air. */}
        <section className="lp-container grid gap-10 py-16 md:grid-cols-[1.15fr_0.85fr] md:items-center md:py-24">
          <div className="max-w-2xl">
            <Badge tone="accent">Real-time classroom</Badge>
            <h1 className="lp-display mt-5 text-5xl text-ink sm:text-6xl">
              Run the room,
              <br />
              not a spreadsheet.
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-ink-muted">
              LivePulse turns a lesson into a live session: quizzes that grade the instant an answer
              commits, a doubt queue that keeps its order, and presence you can actually rely on.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link href="/register" className={buttonStyles("accent", "lg")}>
                Start a session
              </Link>
              <Link href="/login" className={buttonStyles("secondary", "lg")}>
                Join with a link
              </Link>
            </div>
            <p className="mt-4 text-sm text-ink-subtle">
              No install. Works in the browser on a laptop or phone.
            </p>
          </div>

          {/* A static product sketch — composition, not fake live data. */}
          <div aria-hidden="true" className="relative hidden md:block">
            <div className="rounded-lg border border-border bg-surface p-5 shadow-card">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium uppercase tracking-wide text-ink-subtle">
                  Question 3 of 8
                </span>
                <span className="inline-flex items-center gap-1.5 rounded-xs border border-live/30 bg-live-soft px-2 py-0.5 text-[0.6875rem] font-medium uppercase tracking-wide text-live">
                  <span className="h-1.5 w-1.5 rounded-full bg-live" />
                  Live
                </span>
              </div>
              <p className="mt-4 text-lg font-medium leading-snug text-ink">
                Which layer keeps durable state when a connection drops?
              </p>
              <div className="mt-4 rounded-sm border border-border bg-surface-muted px-3 py-2.5 text-sm text-ink">
                PostgreSQL
              </div>
              <div className="mt-2.5 flex items-center gap-2 rounded-sm border border-live/30 bg-live-soft px-3 py-2 text-sm text-live">
                <span className="h-1.5 w-1.5 rounded-full bg-live" />
                <span className="font-medium">Correct</span>
                <span className="rounded-xs border border-live/30 px-1.5 py-0.5 text-[0.625rem] uppercase tracking-wide">
                  first correct
                </span>
              </div>
              <div className="mt-5 space-y-2 border-t border-border pt-4">
                {[
                  ["Priya", "2"],
                  ["Marco", "2"],
                  ["Aisha", "1"],
                ].map(([name, score], index) => (
                  <div key={name} className="flex items-center justify-between text-sm">
                    <span className="flex items-center gap-2 text-ink-muted">
                      <span className="w-3 text-xs text-ink-subtle">{index + 1}</span>
                      {name}
                    </span>
                    <span className="lp-tnum text-ink">{score}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* How it works. */}
        <section className="border-y border-border bg-surface">
          <div className="lp-container py-16">
            <h2 className="lp-display text-3xl text-ink">Three steps to a live lesson</h2>
            <div className="mt-10 grid gap-8 sm:grid-cols-3">
              {STEPS.map((step, index) => (
                <div key={step.title} className="border-t border-border-strong pt-4">
                  <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-ink-subtle">
                    <span className="lp-tnum">{String(index + 1).padStart(2, "0")}</span>
                    <span aria-hidden="true">·</span>
                    <span>{step.role}</span>
                  </div>
                  <h3 className="mt-3 text-base font-semibold text-ink">{step.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-ink-muted">{step.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Capabilities. */}
        <section className="lp-container py-16">
          <h2 className="lp-display text-3xl text-ink">Built for a real classroom</h2>
          <div className="mt-10 grid gap-x-10 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
            {CAPABILITIES.map((item) => (
              <div key={item.title}>
                <h3 className="text-sm font-semibold text-ink">{item.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-ink-muted">{item.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Closing CTA. */}
        <section className="border-t border-border">
          <div className="lp-container flex flex-col items-start justify-between gap-6 py-14 sm:flex-row sm:items-center">
            <div>
              <h2 className="lp-display text-3xl text-ink">Ready when the bell rings.</h2>
              <p className="mt-2 text-sm text-ink-muted">
                Create an account, open a session, and share the link.
              </p>
            </div>
            <Link href="/register" className={buttonStyles("accent", "lg")}>
              Create account
            </Link>
          </div>
        </section>
      </main>

      <footer className="border-t border-border">
        <div className="lp-container flex flex-col gap-3 py-8 text-xs text-ink-subtle sm:flex-row sm:items-center sm:justify-between">
          <Logo />
          <p>
            LivePulse — a real-time classroom platform. Sessions, answers and doubts are stored in
            PostgreSQL.
          </p>
        </div>
      </footer>
    </div>
  );
}
