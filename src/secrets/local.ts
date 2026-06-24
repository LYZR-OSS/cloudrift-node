import { readFile, rename, writeFile } from "node:fs/promises";

import { SecretError, SecretNotFoundError } from "../core/errors.js";
import { SecretBackend } from "./base.js";

/**
 * Non-cloud secret backends: environment variables, a JSON file, or an
 * in-memory mapping.
 *
 * These fill the gap between "no secrets manager" and a full cloud provider —
 * useful for local development, self-hosted/on-prem deployments, CI, and tests.
 * They share the same `SecretBackend` interface as the AWS/Azure backends, so
 * swapping the provider requires no code change.
 *
 * Mirrors `cloudrift-py` `cloudrift.secrets.local`.
 */

/**
 * Read/write secrets from process environment variables.
 *
 * A secret named `db` maps to the environment variable `{prefix}db` (the prefix
 * lets you namespace secrets, e.g. `SECRET_`).
 */
export class EnvSecretBackend extends SecretBackend {
  private readonly prefix: string;

  constructor(options: { prefix?: string } = {}) {
    super();
    this.prefix = options.prefix ?? "";
  }

  private key(name: string): string {
    return `${this.prefix}${name}`;
  }

  async getSecret(name: string): Promise<string> {
    const value = process.env[this.key(name)];
    if (value === undefined) {
      throw new SecretNotFoundError(`Secret '${name}' not found in environment`);
    }
    return value;
  }

  async setSecret(name: string, value: string): Promise<void> {
    process.env[this.key(name)] = value;
  }

  async deleteSecret(name: string): Promise<void> {
    delete process.env[this.key(name)];
  }

  async listSecrets(prefix = ""): Promise<string[]> {
    const names = Object.keys(process.env)
      .filter((k) => k.startsWith(this.prefix))
      .map((k) => k.slice(this.prefix.length));
    return names.filter((n) => n.startsWith(prefix));
  }
}

/** Hold secrets in an in-memory object. Useful for tests and dev seeding. */
export class MappingSecretBackend extends SecretBackend {
  private readonly store: Map<string, string>;

  constructor(options: { mapping?: Record<string, string> } = {}) {
    super();
    this.store = new Map(Object.entries(options.mapping ?? {}));
  }

  async getSecret(name: string): Promise<string> {
    const value = this.store.get(name);
    if (value === undefined) {
      throw new SecretNotFoundError(`Secret '${name}' not found`);
    }
    return value;
  }

  async setSecret(name: string, value: string): Promise<void> {
    this.store.set(name, value);
  }

  async deleteSecret(name: string): Promise<void> {
    this.store.delete(name);
  }

  async listSecrets(prefix = ""): Promise<string[]> {
    return [...this.store.keys()].filter((n) => n.startsWith(prefix));
  }
}

/**
 * Persist secrets in a JSON file mapping name -> value (a string; store JSON by
 * serializing it). Writes are atomic via a temp file + rename. A missing file
 * reads as empty.
 */
export class FileSecretBackend extends SecretBackend {
  private readonly path: string;

  constructor(options: { path: string }) {
    super();
    this.path = options.path;
  }

  private async load(): Promise<Record<string, string>> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return {};
      }
      throw new SecretError(`Secret file '${this.path}' is unreadable: ${String(err)}`, {
        cause: err,
      });
    }

    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      throw new SecretError(`Secret file '${this.path}' is unreadable: ${String(err)}`, {
        cause: err,
      });
    }

    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new SecretError(`Secret file '${this.path}' must contain a JSON object`);
    }
    return data as Record<string, string>;
  }

  private async save(data: Record<string, string>): Promise<void> {
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(data), "utf-8");
    await rename(tmp, this.path);
  }

  async getSecret(name: string): Promise<string> {
    const data = await this.load();
    const value = data[name];
    if (value === undefined) {
      throw new SecretNotFoundError(`Secret '${name}' not found in ${this.path}`);
    }
    return value;
  }

  async setSecret(name: string, value: string): Promise<void> {
    const data = await this.load();
    data[name] = value;
    await this.save(data);
  }

  async deleteSecret(name: string): Promise<void> {
    const data = await this.load();
    delete data[name];
    await this.save(data);
  }

  async listSecrets(prefix = ""): Promise<string[]> {
    const data = await this.load();
    return Object.keys(data).filter((n) => n.startsWith(prefix));
  }
}
