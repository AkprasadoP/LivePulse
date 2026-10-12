import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Frontend test runner.
 *
 * jsdom + Testing Library, with the same `@/*` alias the app uses so tests
 * import the real modules. CSS is not processed — tests assert on behaviour
 * and semantics, never on styling.
 *
 * No React plugin here on purpose: it would drag in a second, incompatible
 * Vite major (Vitest 3 bundles Vite 7). Vitest already transpiles JSX through
 * esbuild honouring `jsx: react-jsx` in tsconfig, which is all these tests
 * need — there is no Fast Refresh to preserve in a test run.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*\.test\.{ts,tsx}", "tests/**/*\.test\.{ts,tsx}"],
    restoreMocks: true,
    unstubGlobals: true,
  },
});
