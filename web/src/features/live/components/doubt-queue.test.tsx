import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DoubtQueuePanel, RaiseDoubtForm } from "./doubt-queue";
import type { DoubtView } from "@/lib/ws/protocol";

function doubt(overrides: Partial<DoubtView> = {}): DoubtView {
  return {
    doubtId: "d1",
    participantId: "p1",
    displayName: "Ana",
    content: "Why is the sky blue?",
    priority: 0,
    enqueueSeq: 1,
    status: "OPEN",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

const noop = () => Promise.resolve({ ok: true } as const);

describe("DoubtQueuePanel", () => {
  it("gives a teacher resolve and dismiss controls", () => {
    render(
      <DoubtQueuePanel
        doubts={[doubt()]}
        truncated={false}
        canModerate
        onResolve={vi.fn(noop)}
        onDismiss={vi.fn(noop)}
        onRefresh={vi.fn(noop)}
      />,
    );

    expect(screen.getByText("Why is the sky blue?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resolve" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
  });

  it("withholds moderation controls from students", () => {
    render(
      <DoubtQueuePanel
        doubts={[doubt()]}
        truncated={false}
        canModerate={false}
        onResolve={vi.fn(noop)}
        onDismiss={vi.fn(noop)}
        onRefresh={vi.fn(noop)}
      />,
    );

    expect(screen.getByText("Why is the sky blue?")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resolve" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Dismiss" })).not.toBeInTheDocument();
  });

  it("renders the queue in the order the server sent it", () => {
    render(
      <DoubtQueuePanel
        doubts={[
          doubt({ doubtId: "a", content: "first" }),
          doubt({ doubtId: "b", content: "second" }),
          doubt({ doubtId: "c", content: "third" }),
        ]}
        truncated={false}
        canModerate
        onResolve={vi.fn(noop)}
        onDismiss={vi.fn(noop)}
        onRefresh={vi.fn(noop)}
      />,
    );

    expect(screen.getByText(/first/).textContent).toBeTruthy();
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[0]!.textContent).toContain("first");
    expect(items[1]!.textContent).toContain("second");
    expect(items[2]!.textContent).toContain("third");
  });

  it("shows an empty state rather than a blank panel", () => {
    render(
      <DoubtQueuePanel
        doubts={[]}
        truncated={false}
        canModerate
        onResolve={vi.fn(noop)}
        onDismiss={vi.fn(noop)}
        onRefresh={vi.fn(noop)}
      />,
    );

    expect(screen.getByText("No open doubts")).toBeInTheDocument();
  });

  it("dispatches the right doubtId for resolve and dismiss", async () => {
    const onResolve = vi.fn(noop);
    const onDismiss = vi.fn(noop);
    const user = userEvent.setup();

    render(
      <DoubtQueuePanel
        doubts={[doubt({ doubtId: "d42" })]}
        truncated={false}
        canModerate
        onResolve={onResolve}
        onDismiss={onDismiss}
        onRefresh={vi.fn(noop)}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Resolve" }));
    expect(onResolve).toHaveBeenCalledWith("d42");

    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledWith("d42");
  });
});

describe("RaiseDoubtForm", () => {
  it("submits the content with an idempotency key", async () => {
    const onSubmit = vi.fn((content: string, clientDoubtId?: string) =>
      Promise.resolve({ ok: true as const, content, clientDoubtId }),
    );
    const user = userEvent.setup();

    render(<RaiseDoubtForm canRaise onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText("Raise a doubt"), "Can you re-explain that?");
    await user.click(screen.getByRole("button", { name: "Raise doubt" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const [content, clientDoubtId] = onSubmit.mock.calls[0]!;
    expect(content).toBe("Can you re-explain that?");
    expect(typeof clientDoubtId).toBe("string");
    expect(clientDoubtId!.length).toBeGreaterThan(0);
  });

  it("keeps the text and reports the failure when the server rejects", async () => {
    const onSubmit = vi.fn(() =>
      Promise.resolve({
        ok: false as const,
        error: new Error("SESSION_NOT_LIVE: not live"),
        message: "The session needs to be live first.",
      }),
    );
    const user = userEvent.setup();

    render(<RaiseDoubtForm canRaise onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText("Raise a doubt"), "Hello?");
    await user.click(screen.getByRole("button", { name: "Raise doubt" }));

    expect(await screen.findByText("The session needs to be live first.")).toBeInTheDocument();
    expect(screen.getByLabelText("Raise a doubt")).toHaveValue("Hello?");
  });

  it("blocks submission when the student cannot raise doubts", async () => {
    const onSubmit = vi.fn(() => Promise.resolve({ ok: true } as const));

    render(<RaiseDoubtForm canRaise={false} onSubmit={onSubmit} />);

    expect(screen.getByLabelText("Raise a doubt")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Raise doubt" })).toBeDisabled();
  });

  it("does not send an empty doubt", async () => {
    const onSubmit = vi.fn(() => Promise.resolve({ ok: true } as const));
    const user = userEvent.setup();

    render(<RaiseDoubtForm canRaise onSubmit={onSubmit} />);

    await user.click(screen.getByRole("button", { name: "Raise doubt" }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText("Write your question first.")).toBeInTheDocument();
  });
});
