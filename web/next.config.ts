import type { NextConfig } from "next";

/**
 * LivePulse frontend configuration.
 *
 * The browser talks to the backend through a SAME-ORIGIN proxy:
 *
 *   browser  →  /api/*  (this Next server)  →  ${LIVEPULSE_BACKEND_URL}/*
 *
 * Why a proxy instead of calling the backend origin directly: the LivePulse
 * backend deliberately does not enable CORS, and access tokens are bearer
 * tokens (never cookies). Proxying keeps every HTTP call first-party, so the
 * browser never issues a cross-origin request and no CORS relaxation of the
 * backend is required. The WebSocket connects directly to the backend (see
 * NEXT_PUBLIC_WS_URL); WebSocket handshakes are not subject to CORS and the
 * token travels inside a frame, never in the URL.
 *
 * `cacheComponents` is intentionally OFF: nearly every surface here is
 * authenticated, live and client-driven, so the cache-component/Suspense
 * model would add friction without benefit.
 */
const backendUrl = process.env.LIVEPULSE_BACKEND_URL ?? "http://127.0.0.1:3000";

const nextConfig: NextConfig = {
  // Tailwind CSS v4 is compiled by its Turbopack loader (installed as
  // `@tailwindcss/turbopack` by the scaffold). Without this rule the plain
  // `@import "tailwindcss"` is emitted verbatim and NO utility classes exist.
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${backendUrl}/:path*`,
      },
    ];
  },
};

export default nextConfig;
