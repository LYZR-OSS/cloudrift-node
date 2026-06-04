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
    // Real cloud services are eventually consistent: a freshly-sent SQS message
    // may not appear within the first long-poll, and Secrets Manager
    // ListSecrets lags a just-created secret. These live tests are idempotent
    // round-trips, so retrying absorbs that transient consistency lag instead
    // of failing. This is harmless for the unit lane — it uses a different
    // config file, so only the live config retries.
    retry: 2,
  },
});
