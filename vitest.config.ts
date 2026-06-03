import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // The AWS emulator and live lanes have their own configs (Docker / real
    // cloud). Keep the default lane deterministic and resource-free.
    exclude: ["tests/aws-emulator/**", "tests/live/**", ...configDefaults.exclude],
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
    },
  },
});
