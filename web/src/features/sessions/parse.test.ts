import { describe, expect, it } from "vitest";
import { parseSessionIdInput } from "./parse";

const ID = "018f3c2e-1111-4222-8333-444455556666";

describe("parseSessionIdInput", () => {
  it("accepts a full absolute link", () => {
    expect(parseSessionIdInput(`https://livepulse.school/sessions/${ID}`)).toBe(ID);
  });

  it("accepts a path-only link", () => {
    expect(parseSessionIdInput(`/sessions/${ID}`)).toBe(ID);
  });

  it("accepts a bare id", () => {
    expect(parseSessionIdInput(ID)).toBe(ID);
  });

  it("tolerates surrounding whitespace, query strings and hashes", () => {
    expect(parseSessionIdInput(`  /sessions/${ID}?ref=email  `)).toBe(ID);
    expect(parseSessionIdInput(`/sessions/${ID}#live`)).toBe(ID);
  });

  it("takes the session id out of a URL rather than the host", () => {
    expect(parseSessionIdInput(`https://host.example/#/sessions/${ID}`)).toBe(ID);
  });

  it("rejects empty and unusable input", () => {
    expect(parseSessionIdInput("")).toBeNull();
    expect(parseSessionIdInput("   ")).toBeNull();
    expect(parseSessionIdInput("https://livepulse.school/")).toBeNull();
    expect(parseSessionIdInput("ask your teacher")).toBeNull();
  });
});
