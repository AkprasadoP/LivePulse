import { describe, expect, it } from "vitest";
import type { QuizState, QuestionState } from "@prisma/client";
import { canTransitionQuiz, canTransitionQuestion } from "../../src/modules/quizzes/quiz.state.js";

describe("quiz state machine", () => {
  const cases: Array<[QuizState, QuizState, boolean]> = [
    ["DRAFT", "ACTIVE", true],
    ["ACTIVE", "COMPLETED", true],
    ["DRAFT", "COMPLETED", false], // questions must actually run
    ["DRAFT", "DRAFT", false],
    ["ACTIVE", "DRAFT", false], // no un-start
    ["ACTIVE", "ACTIVE", false],
    ["COMPLETED", "ACTIVE", false], // terminal
    ["COMPLETED", "DRAFT", false],
  ];

  for (const [from, to, allowed] of cases) {
    it(`${from} -> ${to} is ${allowed ? "valid" : "invalid"}`, () => {
      expect(canTransitionQuiz(from, to)).toBe(allowed);
    });
  }
});

describe("question state machine", () => {
  const cases: Array<[QuestionState, QuestionState, boolean]> = [
    ["DRAFT", "PUBLISHED", true],
    ["PUBLISHED", "CLOSED", true],
    ["DRAFT", "CLOSED", false], // closing an unpublished question is meaningless
    ["PUBLISHED", "DRAFT", false], // no un-publish
    ["DRAFT", "DRAFT", false],
    ["PUBLISHED", "PUBLISHED", false],
    ["CLOSED", "PUBLISHED", false], // terminal: republish would fork the race
    ["CLOSED", "DRAFT", false],
  ];

  for (const [from, to, allowed] of cases) {
    it(`${from} -> ${to} is ${allowed ? "valid" : "invalid"}`, () => {
      expect(canTransitionQuestion(from, to)).toBe(allowed);
    });
  }
});
