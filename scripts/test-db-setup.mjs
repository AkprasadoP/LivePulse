import { execSync } from "node:child_process";

/**
 * Ensures the integration-test database exists and has all migrations applied.
 * Requires the compose PostgreSQL container (docker compose up -d).
 *
 * The test DB is a separate database (livepulse_test) in the same PostgreSQL
 * instance: same engine/version, isolated data, so tests can truncate freely
 * without ever touching development data.
 */
const DB = "livepulse_test";
const URL = "postgresql://livepulse:livepulse@localhost:5433/livepulse_test";

const exists = execSync(
  `docker exec livepulse-postgres psql -U livepulse -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '${DB}'"`,
  { encoding: "utf8" },
).trim();

if (exists !== "1") {
  console.log(`creating database ${DB} ...`);
  execSync(
    `docker exec livepulse-postgres psql -U livepulse -d postgres -c "CREATE DATABASE ${DB}"`,
    {
      stdio: "inherit",
    },
  );
} else {
  console.log(`database ${DB} already exists`);
}

// Apply all migrations to the test database.
execSync("pnpm exec prisma migrate deploy", {
  stdio: "inherit",
  env: { ...process.env, DATABASE_URL: URL },
});

console.log("test database ready");
