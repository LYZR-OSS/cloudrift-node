import { describe, expect, it } from "vitest";

import {
  CloudRiftError,
  StorageError,
  ObjectNotFoundError,
  StoragePermissionError,
  MessagingError,
  QueueNotFoundError,
  MessageSendError,
  DocumentConnectionError,
  CacheError,
  CacheConnectionError,
  CacheKeyNotFoundError,
  SecretError,
  SecretNotFoundError,
  SecretPermissionError,
  PubSubError,
  TopicNotFoundError,
  PublishError,
} from "../src/core/errors.js";

/**
 * Each entry: [ErrorClass, expected `name`, list of base classes the instance
 * must be `instanceof`]. The `name` field is the StringLiteral mutant target
 * (e.g. L18:17, L27:17, ...) — asserting the exact string kills those mutants.
 */
const CASES: Array<{
  Cls: new (message: string, options?: { cause?: unknown }) => CloudRiftError;
  name: string;
  bases: Array<new (...args: never[]) => Error>;
}> = [
  { Cls: CloudRiftError, name: "CloudRiftError", bases: [Error] },
  { Cls: StorageError, name: "StorageError", bases: [CloudRiftError, Error] },
  {
    Cls: ObjectNotFoundError,
    name: "ObjectNotFoundError",
    bases: [StorageError, CloudRiftError, Error],
  },
  {
    Cls: StoragePermissionError,
    name: "StoragePermissionError",
    bases: [StorageError, CloudRiftError, Error],
  },
  { Cls: MessagingError, name: "MessagingError", bases: [CloudRiftError, Error] },
  {
    Cls: QueueNotFoundError,
    name: "QueueNotFoundError",
    bases: [MessagingError, CloudRiftError, Error],
  },
  {
    Cls: MessageSendError,
    name: "MessageSendError",
    bases: [MessagingError, CloudRiftError, Error],
  },
  {
    Cls: DocumentConnectionError,
    name: "DocumentConnectionError",
    bases: [CloudRiftError, Error],
  },
  { Cls: CacheError, name: "CacheError", bases: [CloudRiftError, Error] },
  {
    Cls: CacheConnectionError,
    name: "CacheConnectionError",
    bases: [CacheError, CloudRiftError, Error],
  },
  {
    Cls: CacheKeyNotFoundError,
    name: "CacheKeyNotFoundError",
    bases: [CacheError, CloudRiftError, Error],
  },
  { Cls: SecretError, name: "SecretError", bases: [CloudRiftError, Error] },
  {
    Cls: SecretNotFoundError,
    name: "SecretNotFoundError",
    bases: [SecretError, CloudRiftError, Error],
  },
  {
    Cls: SecretPermissionError,
    name: "SecretPermissionError",
    bases: [SecretError, CloudRiftError, Error],
  },
  { Cls: PubSubError, name: "PubSubError", bases: [CloudRiftError, Error] },
  {
    Cls: TopicNotFoundError,
    name: "TopicNotFoundError",
    bases: [PubSubError, CloudRiftError, Error],
  },
  {
    Cls: PublishError,
    name: "PublishError",
    bases: [PubSubError, CloudRiftError, Error],
  },
];

describe("CloudRift error hierarchy", () => {
  for (const { Cls, name, bases } of CASES) {
    describe(name, () => {
      it("sets the exact name field to its own class name", () => {
        const err = new Cls("boom");
        // Kills the StringLiteral mutants on each `this.name = "..."` line.
        expect(err.name).toBe(name);
        // Guard against the mutant emptying the string.
        expect(err.name).not.toBe("");
      });

      it("preserves the message verbatim", () => {
        const err = new Cls("specific message text");
        expect(err.message).toBe("specific message text");
      });

      it("is instanceof every expected base class", () => {
        const err = new Cls("boom");
        for (const Base of bases) {
          expect(err).toBeInstanceOf(Base);
        }
      });

      it("propagates the cause when provided", () => {
        const cause = new Error("underlying");
        const err = new Cls("wrapped", { cause });
        expect(err.cause).toBe(cause);
      });

      it("leaves cause undefined when no options given", () => {
        const err = new Cls("no cause");
        expect(err.cause).toBeUndefined();
      });

      it("renders name and message together in the stack-style string", () => {
        const err = new Cls("boom");
        // Error.prototype.toString combines name and message; this fails if
        // the name string mutant collapses the class name.
        expect(err.toString()).toBe(`${name}: boom`);
      });
    });
  }

  it("subclasses are distinguishable from sibling branches", () => {
    // ObjectNotFoundError is storage, not messaging/cache/secret/pubsub.
    const e = new ObjectNotFoundError("x");
    expect(e).not.toBeInstanceOf(MessagingError);
    expect(e).not.toBeInstanceOf(CacheError);
    expect(e).not.toBeInstanceOf(SecretError);
    expect(e).not.toBeInstanceOf(PubSubError);
  });

  it("non-cause options object does not leak as cause", () => {
    const err = new CloudRiftError("m", {});
    expect(err.cause).toBeUndefined();
  });
});
