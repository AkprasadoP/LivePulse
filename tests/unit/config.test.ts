import { describe, expect, it } from "vitest";
import { loadConfig, ConfigValidationError } from "../../src/config/index.js";

const validEnv = {
  NODE_ENV: "test",
  PORT: "3000",
  DATABASE_URL: "postgresql://user:pass@localhost:5432/testdb",
  REDIS_URL: "redis://localhost:6379",
} satisfies Record<string, string>;

describe("loadConfig", () => {
  it("parses a fully valid environment", () => {
    const config = loadConfig(validEnv);
    expect(config.PORT).toBe(3000);
    expect(config.NODE_ENV).toBe("test");
    expect(config.LOG_LEVEL).toBe("info"); // default
  });

  it("applies defaults for NODE_ENV, PORT and LOG_LEVEL", () => {
    const config = loadConfig({
      DATABASE_URL: "postgresql://user:pass@localhost:5432/testdb",
      REDIS_URL: "redis://localhost:6379",
    });
    expect(config.NODE_ENV).toBe("development");
    expect(config.PORT).toBe(3000);
    expect(config.LOG_LEVEL).toBe("info");
  });

  it("coerces PORT from a string and rejects out-of-range values", () => {
    expect(loadConfig({ ...validEnv, PORT: "8080" }).PORT).toBe(8080);
    // 0 is explicitly allowed: OS-assigned ephemeral port (used by WS tests).
    expect(loadConfig({ ...validEnv, PORT: "0" }).PORT).toBe(0);
    expect(() => loadConfig({ ...validEnv, PORT: "70000" })).toThrow(ConfigValidationError);
    expect(() => loadConfig({ ...validEnv, PORT: "65536" })).toThrow(ConfigValidationError);
    expect(() => loadConfig({ ...validEnv, PORT: "not-a-number" })).toThrow(ConfigValidationError);
    expect(() => loadConfig({ ...validEnv, PORT: "-1" })).toThrow(ConfigValidationError);
  });

  it("rejects an invalid NODE_ENV value", () => {
    expect(() => loadConfig({ ...validEnv, NODE_ENV: "staging" })).toThrow(ConfigValidationError);
  });

  it("rejects non-postgresql DATABASE_URL and non-redis REDIS_URL", () => {
    expect(() => loadConfig({ ...validEnv, DATABASE_URL: "mysql://user@localhost/db" })).toThrow(
      ConfigValidationError,
    );
    expect(() => loadConfig({ ...validEnv, REDIS_URL: "http://localhost:6379" })).toThrow(
      ConfigValidationError,
    );
  });

  it("requires DATABASE_URL and REDIS_URL", () => {
    const missingBoth = { NODE_ENV: "test" };
    try {
      loadConfig(missingBoth);
      expect.unreachable("loadConfig should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      const issues = (error as ConfigValidationError).issues.join("\n");
      expect(issues).toContain("DATABASE_URL");
      expect(issues).toContain("REDIS_URL");
    }
  });

  it("lists all validation issues, not just the first one", () => {
    try {
      loadConfig({});
      expect.unreachable("loadConfig should have thrown");
    } catch (error) {
      const issues = (error as ConfigValidationError).issues;
      expect(issues.length).toBeGreaterThanOrEqual(2);
    }
  });
});
