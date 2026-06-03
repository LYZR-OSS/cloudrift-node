import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "core/index": "src/core/index.ts",
    "storage/index": "src/storage/index.ts",
    "messaging/index": "src/messaging/index.ts",
    "cache/index": "src/cache/index.ts",
    "secrets/index": "src/secrets/index.ts",
    "pubsub/index": "src/pubsub/index.ts",
    "document/index": "src/document/index.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  target: "es2022",
});
