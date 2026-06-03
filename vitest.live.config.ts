import { defineConfig } from "vitest/config";

/**
 * Vitest configuration for the opt-in LIVE test lane.
 *
 * These tests hit real cloud providers and are NEVER part of the default
 * `npm test` run. They are env-gated (see tests/live/env.ts) and SKIP — rather
 * than fail — when the required environment variables are absent.
 *
 * Run with:  CLOUDRIFT_LIVE_TESTS=1 npm run test:live
 */
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/live/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
