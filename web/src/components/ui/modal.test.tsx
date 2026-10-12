import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Modal } from "./modal";

/**
 * Mirrors the real case: the "End session" dialog is declared inside the live
 * session's sticky, backdrop-blurred header — a stacking context of its own.
 * Before portalling, the `fixed inset-0` overlay was laid out against the
 * header box instead of the viewport, so the scrim stopped covering the page
 * and clicks passed through it.
 */
function HeaderHost({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <header className="sticky top-0 z-10 backdrop-blur">
      <button type="button">header button</button>
      <Modal
        open={open}
        onClose={onClose}
        title="End this session?"
        description="Ending is permanent."
        footer={<button type="button">End session</button>}
      >
        <p>Body copy</p>
      </Modal>
    </header>
  );
}

describe("Modal", () => {
  it("renders the dialog as a direct child of body, outside its React parent", () => {
    render(<HeaderHost open onClose={() => {}} />);

    const dialog = screen.getByRole("dialog", { name: "End this session?" });
    // The overlay (fixed inset-0) is what gets portalled, so it — not the
    // dialog — must sit directly under body.
    const overlay = dialog.parentElement;
    expect(overlay).toHaveClass("fixed", "inset-0");
    expect(overlay?.parentElement).toBe(document.body);
    expect(document.querySelector("header")?.contains(dialog)).toBe(false);
  });

  it("renders nothing when closed", () => {
    render(<HeaderHost open={false} onClose={() => {}} />);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it("closes on Escape", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<HeaderHost open onClose={onClose} />);

    await user.keyboard("{Escape}");

    expect(onClose).toHaveBeenCalled();
  });

  it("closes when the scrim is clicked", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<HeaderHost open onClose={onClose} />);

    await user.click(screen.getByRole("button", { name: "Close dialog" }));

    expect(onClose).toHaveBeenCalled();
  });

  it("labels the dialog for screen readers and marks it modal", () => {
    render(<HeaderHost open onClose={() => {}} />);

    const dialog = screen.getByRole("dialog", { name: "End this session?" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByText("Body copy")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "End session" })).toBeInTheDocument();
  });
});
