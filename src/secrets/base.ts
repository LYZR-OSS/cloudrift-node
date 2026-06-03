import { SecretError } from "../core/errors.js";

/**
 * Abstract base class for cloud secret management backends.
 *
 * Backends hold long-lived clients. Use `await backend.close()` (or
 * `await using backend = ...`) to release sockets cleanly.
 *
 * Mirrors `cloudrift-py` `SecretBackend`. Concrete default methods
 * (`getSecretJson`, `healthCheck`, `close`, async-dispose) live here.
 */
export abstract class SecretBackend {
  /** Retrieve the plaintext value of a secret by name. */
  abstract getSecret(name: string): Promise<string>;

  /**
   * Retrieve a secret and parse its value as JSON.
   *
   * Default implementation: `getSecret` then `JSON.parse`. A parse failure is
   * translated into a `SecretError`.
   */
  async getSecretJson(name: string): Promise<Record<string, unknown>> {
    const raw = await this.getSecret(name);
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch (err) {
      throw new SecretError(`Secret '${name}' is not valid JSON`, {
        cause: err,
      });
    }
  }

  /** Create or update a secret. */
  abstract setSecret(name: string, value: string): Promise<void>;

  /** Delete a secret by name. */
  abstract deleteSecret(name: string): Promise<void>;

  /** List secret names, optionally filtered by prefix. */
  abstract listSecrets(prefix?: string): Promise<string[]>;

  /** Return true if the secret store is reachable. */
  async healthCheck(): Promise<boolean> {
    try {
      await this.listSecrets("__cloudrift_health__");
      return true;
    } catch {
      return false;
    }
  }

  /** Close the underlying client and release sockets. Default is a no-op. */
  async close(): Promise<void> {
    /* no-op by default */
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
