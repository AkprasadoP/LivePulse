import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TeacherRoom } from "./teacher-room";
import { StudentRoom } from "./student-room";
import type { LiveSessionController } from "../use-live-session";
import { initialLiveSessionState } from "../live-store";
import type { ParticipantRole } from "@/lib/api/types";

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

const ok = () => Promise.resolve({ ok: true } as const);

function controller(role: ParticipantRole): LiveSessionController {
  const state = {
    ...initialLiveSessionState("s1"),
    joined: true,
    sessionState: "LIVE" as const,
    role,
    participantId: role === "TEACHER" ? "p-teacher" : "p-student",
    displayName: role === "TEACHER" ? "Ms. Ray" : "Ana",
  };

  return {
    status: "connected",
    state,
    sessionName: "Physics — Period 3",
    roster: [],
    quizCatalog: [],
    loadError: null,
    sessionMissing: false,
    actions: {
      setSessionState: ok,
      createQuiz: ok,
      loadQuiz: ok,
      startQuiz: ok,
      publishQuestion: ok,
      closeQuestion: ok,
      submitAnswer: ok,
      createDoubt: ok,
      resolveDoubt: ok,
      dismissDoubt: ok,
      refreshDoubts: ok,
    },
    verifyConnection: vi.fn(),
    leave: vi.fn(),
    refreshSessionState: vi.fn(async () => {}),
  };
}

describe("role-based rooms", () => {
  it("gives the teacher quiz and session controls", () => {
    render(<TeacherRoom session={controller("TEACHER")} />);

    expect(screen.getByText("Quizzes")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New quiz" })).toBeInTheDocument();
    expect(screen.getByText("Answer activity")).toBeInTheDocument();
    expect(screen.getByText("In the room")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "End session" })).toBeInTheDocument();
  });

  it("does not give the teacher the student doubt composer", () => {
    render(<TeacherRoom session={controller("TEACHER")} />);

    expect(screen.queryByLabelText("Raise a doubt")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Raise doubt" })).not.toBeInTheDocument();
  });

  it("gives the student an answer surface and a doubt composer", () => {
    render(<StudentRoom session={controller("STUDENT")} />);

    expect(screen.getByLabelText("Raise a doubt")).toBeInTheDocument();
    expect(screen.getByText("Leaderboard")).toBeInTheDocument();
    expect(screen.getByText("Current question")).toBeInTheDocument();
  });

  it("withholds quiz authoring from the student", () => {
    render(<StudentRoom session={controller("STUDENT")} />);

    expect(screen.queryByRole("button", { name: "New quiz" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "End session" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Go live" })).not.toBeInTheDocument();
  });
});
