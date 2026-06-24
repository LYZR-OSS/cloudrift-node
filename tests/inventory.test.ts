import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadOptional } from "../src/core/lazy.js";

const ROOT = process.cwd();
const SRC_DIR = join(ROOT, "src");
const DIST_DIR = join(ROOT, "dist");
const PACKAGE_JSON = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  exports: Record<string, { types: string; import: string; require: string }>;
  peerDependencies: Record<string, string>;
  peerDependenciesMeta: Record<string, { optional?: boolean }>;
  devDependencies: Record<string, string>;
};

const EXPECTED_EXPORTS = [
  ".",
  "./core",
  "./storage",
  "./messaging",
  "./cache",
  "./secrets",
  "./pubsub",
  "./document",
  "./email",
  "./sql",
] as const;

const PROVIDER_SDK_IMPORTS = [
  "@aws-sdk/",
  "@aws-crypto/",
  "@smithy/",
  "@azure/",
  "ioredis",
  "mongodb",
] as const;

describe("package inventory", () => {
  it("publishes the expected root and domain subpath exports", () => {
    expect(Object.keys(PACKAGE_JSON.exports).sort()).toEqual([...EXPECTED_EXPORTS].sort());

    for (const subpath of EXPECTED_EXPORTS) {
      const entry = PACKAGE_JSON.exports[subpath];
      expect(entry).toMatchObject({
        types: expect.stringMatching(/^\.\/dist\/.*\.d\.ts$/),
        import: expect.stringMatching(/^\.\/dist\/.*\.js$/),
        require: expect.stringMatching(/^\.\/dist\/.*\.cjs$/),
      });
    }
  });

  it("keeps every lazy optional import declared as an optional peer and dev dependency", () => {
    for (const pkg of dynamicOptionalPackages()) {
      expect(PACKAGE_JSON.peerDependencies, pkg).toHaveProperty(pkg);
      expect(PACKAGE_JSON.peerDependenciesMeta[pkg], pkg).toMatchObject({ optional: true });
      expect(PACKAGE_JSON.devDependencies, pkg).toHaveProperty(pkg);
    }
  });

  it("reports missing optional peers with the exact package and provider", async () => {
    await expect(loadOptional("__cloudrift_missing_peer__", "inventory_provider")).rejects.toThrow(
      /install __cloudrift_missing_peer__ to use the inventory_provider provider/,
    );
  });

  it("keeps built declarations free of provider SDK nominal imports when dist exists", () => {
    if (!existsSync(DIST_DIR)) {
      return;
    }

    for (const file of walk(DIST_DIR).filter((path) => /\.d\.[cm]?ts$/.test(path))) {
      const content = readFileSync(file, "utf8");
      for (const providerImport of PROVIDER_SDK_IMPORTS) {
        expect(content, file).not.toContain(`from "${providerImport}`);
        expect(content, file).not.toContain(`from '${providerImport}`);
        expect(content, file).not.toContain(`import("${providerImport}`);
        expect(content, file).not.toContain(`import('${providerImport}`);
      }
    }
  });
});

function dynamicOptionalPackages(): string[] {
  const packages = new Set<string>();
  const pattern = /loadOptional(?:<[\s\S]*?>)?\s*\(\s*["']([^"']+)["']/g;

  for (const file of walk(SRC_DIR).filter((path) => path.endsWith(".ts"))) {
    const content = readFileSync(file, "utf8");
    for (const match of content.matchAll(pattern)) {
      packages.add(match[1]);
    }
  }

  return [...packages].sort();
}

function walk(dir: string): string[] {
  const entries: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      entries.push(...walk(path));
    } else {
      entries.push(path);
    }
  }
  return entries;
}
