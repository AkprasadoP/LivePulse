import { defineConfig } from "vitest/config";

/**
 * Integration tests run against the real Dockerized PostgreSQL
 * (database livepulse_test, prepared by scripts/test-db-setup.mjs).
 *
 * Suites share one database, so files must not run in parallel: sequential
 * execution in a single fork guarantees TRUNCATE in one suite cannot race
 * another suite's queries.
 */
export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    environment: "node",
    globals: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
    passWithNoTests: false,
    fileParallelism: false,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
