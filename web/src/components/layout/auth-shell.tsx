import Link from "next/link";
import type { ReactNode } from "react";
import { Logo } from "./logo";
import { StatusDot } from "@/components/ui/badge";

/**
 * The sign-in / register composition: an editorial left panel (hidden on small
 * screens) and the form on the right. Desktop and mobile are treated as
 * distinct layouts rather than one squeezed.
 */
export function AuthShell({
  title,
  subtitle,
  children,
  footer,
  aside,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  footer: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[1fr_1.05fr]">
      {/* Editorial panel — desktop only. */}
      <aside className="relative hidden flex-col justify-between border-r border-border bg-surface p-10 lg:flex">
        <Link href="/" className="rounded-xs" aria-label="LivePulse home">
          <Logo />
        </Link>
        <div className="max-w-md">
          <h2 className="lp-display text-4xl leading-tight text-ink">
            The room, in real time.
          </h2>
          <p className="mt-4 text-sm leading-relaxed text-ink-muted">
            Quizzes that grade as answers commit, a doubt queue in the order the server accepted
            it, and presence built from real connections.
          </p>
          <ul className="mt-8 space-y-3 text-sm text-ink-muted">
            {[
              "First correct answer wins — decided by the database, not the network.",
              "Reconnect and the whole session reconciles from durable state.",
              "Nothing is invented on the client.",
            ].map((line) => (
              <li key={line} className="flex items-start gap-2.5">
                <StatusDot tone="accent" />
                <span>{line}</span>
              </li>
            ))}
          </ul>
        </div>
        <p className="text-xs text-ink-subtle">LivePulse — real-time classroom</p>
      </aside>

      {/* Form panel. */}
      <main id="main" className="flex flex-col justify-center px-5 py-12 sm:px-10">
        <div className="mx-auto w-full max-w-sm">
          <Link
            href="/"
            className="mb-8 inline-flex rounded-xs lg:hidden"
            aria-label="LivePulse home"
          >
            <Logo />
          </Link>
          {aside}
          <h1 className="text-2xl font-semibold tracking-tight text-ink">{title}</h1>
          <p className="mt-1.5 text-sm text-ink-muted">{subtitle}</p>
          <div className="mt-7">{children}</div>
          <div className="mt-6 text-sm text-ink-muted">{footer}</div>
        </div>
      </main>
    </div>
  );
}
