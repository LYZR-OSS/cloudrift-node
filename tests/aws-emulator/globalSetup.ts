import { LocalstackContainer, type StartedLocalStackContainer } from "@testcontainers/localstack";
import type { GlobalSetupContext } from "vitest/node";

/**
 * Vitest global setup for the AWS emulator lane. Starts a single LocalStack
 * container for the whole run and publishes its endpoint via `provide()` so
 * individual test files can read it with `inject("localstackEndpoint")`.
 *
 * The returned function tears the container down after the lane finishes.
 */
let container: StartedLocalStackContainer | undefined;

export default async function setup({ provide }: GlobalSetupContext): Promise<() => Promise<void>> {
  container = await new LocalstackContainer("localstack/localstack:3").start();
  provide("localstackEndpoint", container.getConnectionUri());

  return async () => {
    await container?.stop();
    container = undefined;
  };
}

declare module "vitest" {
  export interface ProvidedContext {
    localstackEndpoint: string;
  }
}
