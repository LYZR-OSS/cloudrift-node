import js from "@eslint/js";
import tseslint from "typescript-eslint";

const nodeGlobals = {
  AbortController: "readonly",
  AbortSignal: "readonly",
  Buffer: "readonly",
  clearInterval: "readonly",
  clearTimeout: "readonly",
  console: "readonly",
  process: "readonly",
  setInterval: "readonly",
  setTimeout: "readonly",
};

const vitestGlobals = {
  afterAll: "readonly",
  afterEach: "readonly",
  beforeAll: "readonly",
  beforeEach: "readonly",
  describe: "readonly",
  expect: "readonly",
  it: "readonly",
  test: "readonly",
  vi: "readonly",
};

export default [
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: nodeGlobals,
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["tests/**/*.ts", "vitest.config.ts"],
    languageOptions: {
      globals: {
        ...nodeGlobals,
        ...vitestGlobals,
      },
    },
  },
];
