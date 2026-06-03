/**
 * Azure Event Grid pub/sub backend (`@azure/eventgrid`).
 *
 * Publishes `CloudEvent` messages to an Event Grid topic endpoint. Mirrors
 * `cloudrift-py`'s `cloudrift/pubsub/azure_eventgrid.py`.
 */

import type { randomUUID as RandomUUID } from "node:crypto";
import { randomUUID } from "node:crypto";
import type { EventGridPublisherClient, SendCloudEventInput } from "@azure/eventgrid";
import type { KeyCredential } from "@azure/core-auth";
import type { TokenCredential } from "@azure/core-auth";

import { PubSubError, PublishError, TopicNotFoundError } from "../core/errors.js";
import { loadOptional } from "../core/lazy.js";
import { PubSubBackend, type PubSubMessage } from "./base.js";

const EVENTGRID_PKG = "@azure/eventgrid";
const IDENTITY_PKG = "@azure/identity";
const PROVIDER = "azure_eventgrid";

type CloudEventClient = EventGridPublisherClient<"CloudEvent">;

interface EventGridModule {
  EventGridPublisherClient: new (
    endpointUrl: string,
    inputSchema: "CloudEvent",
    credential: KeyCredential | TokenCredential,
  ) => CloudEventClient;
  AzureKeyCredential: new (key: string) => KeyCredential;
}

interface IdentityModule {
  ManagedIdentityCredential: new (options?: { clientId?: string }) => TokenCredential;
  ClientSecretCredential: new (
    tenantId: string,
    clientId: string,
    clientSecret: string,
  ) => TokenCredential;
}

type ClientFactory = () => Promise<{
  client: CloudEventClient;
  credential: TokenCredential | undefined;
}>;

export class AzureEventGridBackend extends PubSubBackend {
  private readonly factory: ClientFactory;
  private client: CloudEventClient | undefined;
  private credential: TokenCredential | undefined;
  private initializing: Promise<CloudEventClient> | undefined;
  private readonly uuid: typeof RandomUUID = randomUUID;

  private constructor(factory: ClientFactory) {
    super();
    this.factory = factory;
  }

  // --------------------------------------------------------------------
  // Factory constructors
  // --------------------------------------------------------------------

  static fromAccessKey(opts: { endpoint: string; accessKey: string }): AzureEventGridBackend {
    return new AzureEventGridBackend(async () => {
      const mod = await loadOptional<EventGridModule>(EVENTGRID_PKG, PROVIDER);
      const credential = new mod.AzureKeyCredential(opts.accessKey);
      const client = new mod.EventGridPublisherClient(opts.endpoint, "CloudEvent", credential);
      return { client, credential: undefined };
    });
  }

  static fromManagedIdentity(opts: { endpoint: string; clientId?: string }): AzureEventGridBackend {
    return new AzureEventGridBackend(async () => {
      const mod = await loadOptional<EventGridModule>(EVENTGRID_PKG, PROVIDER);
      const identity = await loadOptional<IdentityModule>(IDENTITY_PKG, PROVIDER);
      const credential =
        opts.clientId !== undefined
          ? new identity.ManagedIdentityCredential({ clientId: opts.clientId })
          : new identity.ManagedIdentityCredential();
      let client: CloudEventClient;
      try {
        client = new mod.EventGridPublisherClient(opts.endpoint, "CloudEvent", credential);
      } catch (err) {
        await closeCredential(credential);
        throw err;
      }
      return { client, credential };
    });
  }

  static fromServicePrincipal(opts: {
    endpoint: string;
    tenantId: string;
    clientId: string;
    clientSecret: string;
  }): AzureEventGridBackend {
    return new AzureEventGridBackend(async () => {
      const mod = await loadOptional<EventGridModule>(EVENTGRID_PKG, PROVIDER);
      const identity = await loadOptional<IdentityModule>(IDENTITY_PKG, PROVIDER);
      const credential = new identity.ClientSecretCredential(
        opts.tenantId,
        opts.clientId,
        opts.clientSecret,
      );
      let client: CloudEventClient;
      try {
        client = new mod.EventGridPublisherClient(opts.endpoint, "CloudEvent", credential);
      } catch (err) {
        await closeCredential(credential);
        throw err;
      }
      return { client, credential };
    });
  }

  // --------------------------------------------------------------------
  // Lazy client init
  // --------------------------------------------------------------------

  private async ensure(): Promise<CloudEventClient> {
    if (this.client !== undefined) {
      return this.client;
    }
    if (this.initializing === undefined) {
      this.initializing = this.factory().then(({ client, credential }) => {
        this.credential = credential;
        return client;
      });
    }
    try {
      this.client = await this.initializing;
      return this.client;
    } catch (err) {
      this.initializing = undefined;
      this.credential = undefined;
      throw err;
    }
  }

  override async close(): Promise<void> {
    // Mirror Python close(): always release the publisher client's HTTP
    // transport first, then conditionally close the credential.
    const client = this.client as { close?: () => Promise<void> | void } | undefined;
    if (client !== undefined && typeof client.close === "function") {
      await client.close();
    }
    const cred = this.credential as { close?: () => Promise<void> | void } | undefined;
    if (cred !== undefined && typeof cred.close === "function") {
      await cred.close();
    }
    this.client = undefined;
    this.credential = undefined;
    this.initializing = undefined;
  }

  // --------------------------------------------------------------------
  // PubSubBackend implementation
  // --------------------------------------------------------------------

  override async publish(
    topic: string,
    message: string,
    attributes?: Record<string, string>,
  ): Promise<string> {
    const client = await this.ensure();
    const eventId = this.uuid();
    const event: SendCloudEventInput<string> = {
      type: "cloudrift.event",
      source: topic,
      id: eventId,
      data: message,
      extensionAttributes: attributes ?? {},
    };
    try {
      await client.send([event]);
      return eventId;
    } catch (err) {
      throw this.translate(err, topic);
    }
  }

  override async publishBatch(topic: string, messages: PubSubMessage[]): Promise<string[]> {
    const client = await this.ensure();
    const ids: string[] = [];
    const events: Array<SendCloudEventInput<string>> = messages.map((msg) => {
      const eventId = this.uuid();
      ids.push(eventId);
      return {
        type: "cloudrift.event",
        source: topic,
        id: eventId,
        data: msg.message ?? JSON.stringify(msg),
        extensionAttributes: msg.attributes ?? {},
      };
    });
    try {
      await client.send(events);
      return ids;
    } catch (err) {
      throw this.translate(err, topic);
    }
  }

  override async healthCheck(): Promise<boolean> {
    // Event Grid doesn't have a lightweight ping; best-effort check.
    return true;
  }

  private translate(err: unknown, topic: string): Error {
    const status = statusCode(err);
    if (status === 404) {
      return new TopicNotFoundError(`Topic not found: ${topic}`, { cause: err });
    }
    if (status === 403) {
      return new PubSubError(`Access denied for topic: ${topic}`, { cause: err });
    }
    return new PublishError(errorMessage(err), { cause: err });
  }
}

function statusCode(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) {
    return undefined;
  }
  const status = (err as { statusCode?: unknown }).statusCode;
  return typeof status === "number" ? status : undefined;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

async function closeCredential(credential: TokenCredential | undefined): Promise<void> {
  const closable = credential as (TokenCredential & { close?: () => Promise<void> }) | undefined;
  if (closable && typeof closable.close === "function") {
    await closable.close();
  }
}
