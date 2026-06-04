import { describe, expect, it } from "vitest";

import { CloudRiftError } from "../src/core/errors.js";
import { isModuleNotFound, loadOptional } from "../src/core/lazy.js";

const PKG = "@scope/pkg";

describe("isModuleNotFound: non-object guard (lazy.ts:38)", () => {
  it("returns false for a string", () => {
    expect(isModuleNotFound("Cannot find module '@scope/pkg'", PKG)).toBe(false);
  });

  it("returns false for a number", () => {
    expect(isModuleNotFound(42, PKG)).toBe(false);
  });

  it("returns false for null", () => {
    expect(isModuleNotFound(null, PKG)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isModuleNotFound(undefined, PKG)).toBe(false);
  });
});

describe("isModuleNotFound: code-based classification (lazy.ts:42)", () => {
  it("returns true for ERR_MODULE_NOT_FOUND", () => {
    expect(isModuleNotFound({ code: "ERR_MODULE_NOT_FOUND" }, PKG)).toBe(true);
  });

  it("returns true for MODULE_NOT_FOUND", () => {
    expect(isModuleNotFound({ code: "MODULE_NOT_FOUND" }, PKG)).toBe(true);
  });

  it("returns true for ERR_PACKAGE_PATH_NOT_EXPORTED", () => {
    expect(isModuleNotFound({ code: "ERR_PACKAGE_PATH_NOT_EXPORTED" }, PKG)).toBe(true);
  });

  it("falls through to message check for a non-matching string code", () => {
    // Non-matching code + no usable message => false (does not short-circuit true).
    expect(isModuleNotFound({ code: "EACCES" }, PKG)).toBe(false);
    // Non-matching code but a message that does match => true (proves fall-through).
    expect(isModuleNotFound({ code: "EACCES", message: `Cannot find module '${PKG}'` }, PKG)).toBe(
      true,
    );
  });

  it("falls through to message check for a non-string code", () => {
    // typeof code === "string" must be false here, so the .has() branch is skipped.
    expect(isModuleNotFound({ code: 123 }, PKG)).toBe(false);
    expect(isModuleNotFound({ code: 123, message: `Cannot find module '${PKG}'` }, PKG)).toBe(true);
  });
});

describe("isModuleNotFound: message-based classification (lazy.ts:49-51)", () => {
  it("returns true for a 'Cannot find module' message containing the pkg", () => {
    expect(isModuleNotFound({ message: `Cannot find module '${PKG}'` }, PKG)).toBe(true);
  });

  it("returns true for a 'Cannot find package' message containing the pkg", () => {
    expect(isModuleNotFound({ message: `Cannot find package '${PKG}' imported from x` }, PKG)).toBe(
      true,
    );
  });

  it("returns true for a 'failed to load url' message containing the pkg", () => {
    expect(isModuleNotFound({ message: `Failed to load url ${PKG} (resolved id: x)` }, PKG)).toBe(
      true,
    );
  });

  it("returns false when the regex matches but the pkg is absent", () => {
    // Kills the message.includes(pkg) clause.
    expect(isModuleNotFound({ message: "Cannot find module 'other-package'" }, PKG)).toBe(false);
    expect(isModuleNotFound({ message: "Failed to load url some-other-thing" }, PKG)).toBe(false);
  });

  it("returns false when the pkg is present but neither regex matches", () => {
    // Kills the two regex clauses.
    expect(isModuleNotFound({ message: `Some unrelated error mentioning ${PKG}` }, PKG)).toBe(
      false,
    );
  });

  it("returns false for a non-string message", () => {
    expect(isModuleNotFound({ message: 123 }, PKG)).toBe(false);
  });
});

describe("loadOptional public behavior", () => {
  it("wraps a missing package in CloudRiftError with an install hint", async () => {
    const pkg = "@cloudrift/definitely-not-installed-xyz";
    const provider = "fake_provider";
    await expect(loadOptional(pkg, provider)).rejects.toBeInstanceOf(CloudRiftError);
    await expect(loadOptional(pkg, provider)).rejects.toThrow(
      `install ${pkg} to use the ${provider} provider`,
    );
  });

  it("rethrows a non-module-not-found error unchanged", async () => {
    // node: protocol + a path that imports cleanly would not throw; instead use a
    // module specifier whose import throws a non-module-not-found error. A data:
    // URL with invalid JS syntax throws a SyntaxError, which is not a
    // module-not-found error and must propagate unchanged (not wrapped).
    const badModule = "data:text/javascript,export const x = (";
    await expect(loadOptional(badModule, "fake_provider")).rejects.not.toBeInstanceOf(
      CloudRiftError,
    );
    // R2-2: pin the SPECIFIC rethrown error so the "rethrow unchanged" contract
    // is enforced — a syntactically invalid module surfaces a SyntaxError, which
    // must propagate verbatim rather than being wrapped/swallowed.
    await expect(loadOptional(badModule, "fake_provider")).rejects.toThrowError(SyntaxError);
  });
});
