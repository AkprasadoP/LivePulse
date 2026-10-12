import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

/**
 * jsdom 30 exposes `window.localStorage` as a getter that resolves to Node's
 * built-in web storage — which Node disables unless it is started with
 * `--localstorage-file`. In that configuration the getter returns `undefined`,
 * so the browser API the app relies on is simply missing.
 *
 * Install a spec-faithful in-memory `Storage` when that happens. This is not a
 * fake for the *application*: `localStorage` is a real browser primitive, and
 * the shim implements the same contract (null on missing keys, string
 * coercion, `length`, `key()`).
 */
function ensureLocalStorage(): void {
  if (typeof window === "undefined") return;
  if (typeof window.localStorage !== "undefined") return;

  let store = new Map<string, string>();
  const storage: Storage = {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store = new Map<string, string>();
    },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  };

  Object.defineProperty(window, "localStorage", {
    value: storage,
    configurable: true,
    writable: true,
  });
}

ensureLocalStorage();

afterEach(() => {
  cleanup();
  window.localStorage?.clear();
});
