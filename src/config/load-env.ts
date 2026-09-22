import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Minimal `.env` file loader.
 *
 * Precedence (standard): variables already present in the real environment
 * WIN over values from the file; the file only fills in the gaps.
 *
 * Supported syntax: blank lines, `#` comments, `KEY=VALUE`, optional
 * surrounding single/double quotes. Deliberately NOT a full dotenv
 * implementation: no multiline values, no `${VAR}` interpolation, no
 * `export ` prefix. If any of those become necessary, adopt the `dotenv`
 * package and record an ADR — do not grow this file silently.
 */
export function loadEnvFile(
  filePath: string = ".env",
  target: Record<string, string | undefined> = process.env,
): void {
  let content: string;
  try {
    content = readFileSync(resolve(filePath), "utf8");
  } catch {
    return; // no .env file — configuration must come from the environment
  }

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq <= 0) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }

    if (target[key] !== undefined) continue; // real environment wins
    target[key] = value;
  }
}
