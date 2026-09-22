import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Unit tests only — integration suites live in tests/integration and run
    // against the real PostgreSQL instance (see vitest.integration.config.ts).
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
    globals: false,
    testTimeout: 15_000,
    hookTimeout: 15_000,
    // Fail the run if no tests were collected — silent green runs hide regressions.
    passWithNoTests: false,
  },
});
