import { afterEach, describe, expect, it } from "vitest";
import { loadEnvFile } from "../../src/config/load-env.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("loadEnvFile", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function makeEnvFile(content: string): string {
    const dir = mkdtempSync(join(tmpdir(), "livepulse-env-"));
    tempDirs.push(dir);
    const filePath = join(dir, ".env");
    writeFileSync(filePath, content, "utf8");
    return filePath;
  }

  it("parses KEY=VALUE pairs, comments and blank lines", () => {
    const path = makeEnvFile(
      [
        "# comment line",
        "",
        "DATABASE_URL=postgresql://u:p@localhost:5433/db",
        "REDIS_URL=redis://localhost:6380",
        'QUOTED="hello world"',
        "SINGLE='single quoted'",
      ].join("\n"),
    );
    const target: Record<string, string | undefined> = {};
    loadEnvFile(path, target);
    expect(target.DATABASE_URL).toBe("postgresql://u:p@localhost:5433/db");
    expect(target.REDIS_URL).toBe("redis://localhost:6380");
    expect(target.QUOTED).toBe("hello world");
    expect(target.SINGLE).toBe("single quoted");
  });

  it("never overrides variables already present in the environment", () => {
    const path = makeEnvFile("PORT=9999");
    const target: Record<string, string | undefined> = { PORT: "3000" };
    loadEnvFile(path, target);
    expect(target.PORT).toBe("3000");
  });

  it("silently does nothing when the file is missing", () => {
    const target: Record<string, string | undefined> = {};
    expect(() => loadEnvFile("/nonexistent/.env", target)).not.toThrow();
    expect(Object.keys(target)).toHaveLength(0);
  });

  it("ignores malformed lines without an = separator", () => {
    const path = makeEnvFile("NOT_A_PAIR\nALSO_BAD=\n=NO_KEY");
    const target: Record<string, string | undefined> = {};
    loadEnvFile(path, target);
    expect(target.NOT_A_PAIR).toBeUndefined();
    expect(target.ALSO_BAD).toBe("");
    expect(target["=NO_KEY"]).toBeUndefined();
  });
});
