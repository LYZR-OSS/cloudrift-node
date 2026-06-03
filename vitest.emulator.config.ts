import { defineConfig } from "vitest/config";

/**
 * AWS emulator test lane. Runs behavioral system tests against a LocalStack
 * container managed by Testcontainers. Requires Docker. Not part of the default
 * `npm test` lane (see `vitest.config.ts`, which excludes `tests/aws-emulator/**`).
 *
 * Run with: `npm run test:aws:emulator`.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/aws-emulator/**/*.test.ts"],
    globalSetup: "tests/aws-emulator/globalSetup.ts",
    // Container image pull + start is slow on a cold cache; give hooks plenty of
    // room. Per-test work is synchronous against LocalStack, so keep tests tight.
    hookTimeout: 120_000,
    testTimeout: 30_000,
  },
});
