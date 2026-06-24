import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CloudRiftError,
  EmailError,
  EmailSendError,
  EmailThrottledError,
  RecipientRejectedError,
  SenderUnverifiedError,
} from "../src/core/errors.js";
import { EmailBackend, type EmailMessage } from "../src/email/base.js";
import {
  AWSSESBackend,
  AzureACSEmailBackend,
  SMTPEmailBackend,
  getEmail,
} from "../src/email/index.js";

// ---------------------------------------------------------------------------
// SES SDK mock (@aws-sdk/client-sesv2 + credential-providers)
// ---------------------------------------------------------------------------

const sesHarness = vi.hoisted(() => ({
  sendInputs: [] as Array<Record<string, unknown>>,
  listCalls: 0,
  destroyed: 0,
  nextError: undefined as Error | undefined,
  listError: undefined as Error | undefined,
  omitMessageId: false,
}));

vi.mock("@aws-sdk/client-sesv2", () => {
  class SESv2Client {
    constructor(public config: unknown) {}
    async send(command: { input: Record<string, unknown>; kind: string }): Promise<unknown> {
      if (command.kind === "list") {
        sesHarness.listCalls += 1;
        if (sesHarness.listError) {
          const e = sesHarness.listError;
          sesHarness.listError = undefined;
          throw e;
        }
        return {};
      }
      sesHarness.sendInputs.push(command.input);
      if (sesHarness.nextError) {
        const e = sesHarness.nextError;
        sesHarness.nextError = undefined;
        throw e;
      }
      if (sesHarness.omitMessageId) {
        return {};
      }
      return { MessageId: "ses-message-id" };
    }
    destroy(): void {
      sesHarness.destroyed += 1;
    }
  }
  class SendEmailCommand {
    kind = "send";
    constructor(public input: Record<string, unknown>) {}
  }
  class ListEmailIdentitiesCommand {
    kind = "list";
    constructor(public input: Record<string, unknown>) {}
  }
  return { SESv2Client, SendEmailCommand, ListEmailIdentitiesCommand };
});

const credentialProviderMock = vi.hoisted(() => ({
  fromIni: vi.fn(() => async () => ({
    accessKeyId: "profile-key",
    secretAccessKey: "profile-secret",
  })),
}));
vi.mock("@aws-sdk/credential-providers", () => credentialProviderMock);

// ---------------------------------------------------------------------------
// nodemailer mock (createTransport + MailComposer)
// ---------------------------------------------------------------------------

const smtpHarness = vi.hoisted(() => ({
  transportOptions: [] as Array<Record<string, unknown>>,
  sentMessages: [] as Array<Record<string, unknown>>,
  closed: 0,
  verifyResult: true,
  nextError: undefined as Error | undefined,
}));

// MIME-build path uses createTransport({ streamTransport: true, buffer: true }).
const mimeHarness = vi.hoisted(() => ({
  messages: [] as Array<Record<string, unknown>>,
}));

vi.mock("nodemailer", () => {
  function createTransport(options: Record<string, unknown>) {
    const isStream = options.streamTransport === true;
    if (!isStream) {
      smtpHarness.transportOptions.push(options);
    }
    return {
      async sendMail(message: Record<string, unknown>) {
        if (isStream) {
          // MIME assembly path: return a deterministic raw buffer.
          mimeHarness.messages.push(message);
          return { message: Buffer.from(`MIME:${JSON.stringify(message)}`) };
        }
        smtpHarness.sentMessages.push(message);
        if (smtpHarness.nextError) {
          const e = smtpHarness.nextError;
          smtpHarness.nextError = undefined;
          throw e;
        }
        return { messageId: message.messageId as string };
      },
      async verify() {
        if (!smtpHarness.verifyResult) {
          throw new Error("verify failed");
        }
        return true as const;
      },
      close() {
        smtpHarness.closed += 1;
      },
    };
  }
  return { createTransport, default: { createTransport } };
});

// ---------------------------------------------------------------------------
// Azure ACS mock (@azure/communication-email + @azure/identity)
// ---------------------------------------------------------------------------

const acsHarness = vi.hoisted(() => ({
  ctorArgs: [] as unknown[][],
  sendMessages: [] as Array<Record<string, unknown>>,
  credentials: [] as Array<{ kind: string; args: unknown[]; closed: boolean }>,
  nextError: undefined as Error | undefined,
}));

vi.mock("@azure/communication-email", () => {
  class EmailClient {
    constructor(...args: unknown[]) {
      acsHarness.ctorArgs.push(args);
    }
    async beginSend(message: Record<string, unknown>) {
      acsHarness.sendMessages.push(message);
      return {
        async pollUntilDone() {
          if (acsHarness.nextError) {
            const e = acsHarness.nextError;
            acsHarness.nextError = undefined;
            throw e;
          }
          return { id: "acs-message-id" };
        },
      };
    }
  }
  return { EmailClient };
});

vi.mock("@azure/identity", () => {
  class ManagedIdentityCredential {
    record: { kind: string; args: unknown[]; closed: boolean };
    constructor(...args: unknown[]) {
      this.record = { kind: "managed", args, closed: false };
      acsHarness.credentials.push(this.record);
    }
    async close() {
      this.record.closed = true;
    }
  }
  class ClientSecretCredential {
    record: { kind: string; args: unknown[]; closed: boolean };
    constructor(...args: unknown[]) {
      this.record = { kind: "service-principal", args, closed: false };
      acsHarness.credentials.push(this.record);
    }
    async close() {
      this.record.closed = true;
    }
  }
  return { ManagedIdentityCredential, ClientSecretCredential };
});

function awsError(name: string, message = name): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

beforeEach(() => {
  sesHarness.sendInputs = [];
  sesHarness.listCalls = 0;
  sesHarness.destroyed = 0;
  sesHarness.nextError = undefined;
  sesHarness.listError = undefined;
  sesHarness.omitMessageId = false;
  smtpHarness.transportOptions = [];
  smtpHarness.sentMessages = [];
  smtpHarness.closed = 0;
  smtpHarness.verifyResult = true;
  smtpHarness.nextError = undefined;
  mimeHarness.messages = [];
  acsHarness.ctorArgs = [];
  acsHarness.sendMessages = [];
  acsHarness.credentials = [];
  acsHarness.nextError = undefined;
  credentialProviderMock.fromIni.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Factory dispatch
// ---------------------------------------------------------------------------

describe("getEmail factory", () => {
  it("normalizes the provider string", async () => {
    const backend = await getEmail(" SES ", { defaultFrom: "a@b.com" });
    expect(backend).toBeInstanceOf(AWSSESBackend);
  });

  it("throws CloudRiftError for an unknown provider", async () => {
    await expect(getEmail("mailchimp", {})).rejects.toBeInstanceOf(CloudRiftError);
    await expect(getEmail("mailchimp", {})).rejects.toThrow(/Unknown email provider/);
  });

  it("ses + awsAccessKeyId dispatches to fromAccessKey", async () => {
    const spy = vi.spyOn(AWSSESBackend, "fromAccessKey");
    const backend = await getEmail("ses", {
      awsAccessKeyId: "id",
      awsSecretAccessKey: "secret",
      defaultFrom: "a@b.com",
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(backend).toBeInstanceOf(AWSSESBackend);
  });

  it("ses + profileName dispatches to fromProfile", async () => {
    const spy = vi.spyOn(AWSSESBackend, "fromProfile");
    await getEmail("ses", { profileName: "dev" });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("ses with neither dispatches to fromIamRole", async () => {
    const spy = vi.spyOn(AWSSESBackend, "fromIamRole");
    await getEmail("ses", { region: "eu-west-1" });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("azure_acs + connectionString dispatches to fromConnectionString", async () => {
    const spy = vi.spyOn(AzureACSEmailBackend, "fromConnectionString");
    const backend = await getEmail("azure_acs", {
      connectionString: "endpoint=https://x.communication.azure.com;accesskey=KEY",
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(backend).toBeInstanceOf(AzureACSEmailBackend);
  });

  it("azure_acs + clientSecret dispatches to fromServicePrincipal", async () => {
    const spy = vi.spyOn(AzureACSEmailBackend, "fromServicePrincipal");
    await getEmail("azure_acs", {
      endpoint: "https://x.communication.azure.com",
      tenantId: "t",
      clientId: "c",
      clientSecret: "s",
    });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("azure_acs with only endpoint dispatches to fromManagedIdentity", async () => {
    const spy = vi.spyOn(AzureACSEmailBackend, "fromManagedIdentity");
    await getEmail("azure_acs", { endpoint: "https://x.communication.azure.com" });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("smtp default mode dispatches to fromStarttls (port 587)", async () => {
    const backend = (await getEmail("smtp", {
      host: "smtp.example.com",
      username: "u",
      password: "p",
    })) as SMTPEmailBackend;
    expect(backend).toBeInstanceOf(SMTPEmailBackend);
    await backend.send("to@x.com", "s", { bodyText: "hi", from: "a@b.com" });
    expect(smtpHarness.transportOptions[0]).toMatchObject({
      port: 587,
      secure: false,
      requireTLS: true,
    });
  });

  it("smtp tls mode uses port 465 and secure=true", async () => {
    const backend = await getEmail("smtp", {
      mode: "tls",
      host: "smtp.example.com",
      username: "u",
      password: "p",
    });
    await backend.send("to@x.com", "s", { bodyText: "hi", from: "a@b.com" });
    expect(smtpHarness.transportOptions[0]).toMatchObject({ port: 465, secure: true });
  });

  it("smtp plaintext mode uses port 25 and ignoreTLS", async () => {
    const backend = await getEmail("smtp", { mode: "plaintext", host: "localhost" });
    await backend.send("to@x.com", "s", { bodyText: "hi", from: "a@b.com" });
    expect(smtpHarness.transportOptions[0]).toMatchObject({
      port: 25,
      secure: false,
      ignoreTLS: true,
    });
  });

  it("smtp unknown mode throws CloudRiftError", async () => {
    await expect(getEmail("smtp", { mode: "ssl", host: "h" })).rejects.toThrow(/Unknown SMTP mode/);
  });

  it("smtp with no host throws EmailError (fail loud)", async () => {
    await expect(getEmail("smtp", { mode: "plaintext" })).rejects.toBeInstanceOf(EmailError);
    await expect(getEmail("smtp", { mode: "plaintext", host: "" })).rejects.toThrow(
      /SMTP host is required/,
    );
  });

  it("smtp starttls/tls without credentials throws EmailError", async () => {
    await expect(getEmail("smtp", { host: "smtp.example.com" })).rejects.toBeInstanceOf(EmailError);
    await expect(
      getEmail("smtp", { mode: "tls", host: "smtp.example.com", username: "u" }),
    ).rejects.toThrow(/requires both username and password/);
  });
});

// ---------------------------------------------------------------------------
// SES backend
// ---------------------------------------------------------------------------

describe("AWSSESBackend", () => {
  it("sends a simple (non-MIME) message when no attachments/headers", async () => {
    const backend = AWSSESBackend.fromIamRole({ defaultFrom: "noreply@example.com" });
    const id = await backend.send("to@x.com", "Subject", {
      bodyText: "hello",
      bodyHtml: "<p>hi</p>",
      cc: ["cc@x.com"],
    });
    expect(id).toBe("ses-message-id");
    const input = sesHarness.sendInputs[0]!;
    expect(input.FromEmailAddress).toBe("noreply@example.com");
    expect((input.Content as Record<string, unknown>).Simple).toBeDefined();
    expect((input.Content as Record<string, unknown>).Raw).toBeUndefined();
    expect(input.Destination).toMatchObject({
      ToAddresses: ["to@x.com"],
      CcAddresses: ["cc@x.com"],
    });
    await backend.close();
    expect(sesHarness.destroyed).toBe(1);
  });

  it("passes replyTo and bcc through Simple-content sends", async () => {
    const backend = AWSSESBackend.fromIamRole({ defaultFrom: "noreply@example.com" });
    await backend.send("to@x.com", "Subject", {
      bodyText: "hello",
      bcc: ["bcc1@x.com", "bcc2@x.com"],
      replyTo: ["reply@x.com"],
    });
    const input = sesHarness.sendInputs[0]!;
    expect((input.Destination as Record<string, unknown>).BccAddresses).toEqual([
      "bcc1@x.com",
      "bcc2@x.com",
    ]);
    expect(input.ReplyToAddresses).toEqual(["reply@x.com"]);
    await backend.close();
  });

  it("sends an html-only body (no Text part) in Simple content", async () => {
    const backend = AWSSESBackend.fromIamRole({ defaultFrom: "noreply@example.com" });
    await backend.send("to@x.com", "Subject", { bodyHtml: "<p>only html</p>" });
    const content = sesHarness.sendInputs[0]!.Content as Record<string, Record<string, unknown>>;
    const body = (content.Simple as Record<string, Record<string, unknown>>).Body as Record<
      string,
      unknown
    >;
    expect((body.Html as Record<string, unknown>).Data).toBe("<p>only html</p>");
    expect(body.Text).toBeUndefined();
    await backend.close();
  });

  it("throws EmailSendError when the SES response omits MessageId", async () => {
    const backend = AWSSESBackend.fromIamRole({ defaultFrom: "noreply@example.com" });
    sesHarness.omitMessageId = true;
    await expect(backend.send("to@x.com", "s", { bodyText: "hi" })).rejects.toBeInstanceOf(
      EmailSendError,
    );
    await backend.close();
  });

  it("builds a raw MIME message when attachments are present", async () => {
    const backend = AWSSESBackend.fromIamRole({ defaultFrom: "noreply@example.com" });
    await backend.send("to@x.com", "Subj", {
      bodyText: "hello",
      attachments: [{ filename: "a.txt", content: new TextEncoder().encode("data") }],
    });
    const input = sesHarness.sendInputs[0]!;
    const content = input.Content as Record<string, Record<string, unknown>>;
    expect(content.Raw).toBeDefined();
    expect(content.Simple).toBeUndefined();
    expect(Buffer.isBuffer((content.Raw as Record<string, unknown>).Data)).toBe(true);
    // The MIME builder received the body + attachment.
    const composed = mimeHarness.messages[0]!;
    expect(composed.from).toBe("noreply@example.com");
    expect(composed.text).toBe("hello");
    expect((composed.attachments as unknown[]).length).toBe(1);
  });

  it("builds a raw MIME message when custom headers are present", async () => {
    const backend = AWSSESBackend.fromIamRole({ defaultFrom: "noreply@example.com" });
    await backend.send("to@x.com", "Subj", {
      bodyText: "hello",
      headers: { "X-Custom": "1" },
    });
    const composed = mimeHarness.messages[0]!;
    expect(composed.headers).toMatchObject({ "X-Custom": "1" });
  });

  it("propagates replyTo into the MIME builder on the raw path", async () => {
    const backend = AWSSESBackend.fromIamRole({ defaultFrom: "noreply@example.com" });
    await backend.send("to@x.com", "Subj", {
      bodyText: "hello",
      replyTo: ["reply@x.com"],
      attachments: [{ filename: "a.txt", content: new TextEncoder().encode("x") }],
    });
    const composed = mimeHarness.messages[0]!;
    expect(composed.replyTo).toEqual(["reply@x.com"]);
  });

  it("MIME builder drops case-insensitive managed headers but keeps custom ones", async () => {
    const backend = AWSSESBackend.fromIamRole({ defaultFrom: "noreply@example.com" });
    await backend.send("to@x.com", "Real Subject", {
      bodyText: "hello",
      headers: {
        Subject: "spoofed",
        FROM: "evil@x.com",
        "Content-Type": "text/evil",
        "X-Keep": "yes",
      },
    });
    const composed = mimeHarness.messages[0]!;
    const headers = (composed.headers ?? {}) as Record<string, string>;
    // Managed headers (any case) must be filtered out so nodemailer owns them.
    expect("Subject" in headers).toBe(false);
    expect("FROM" in headers).toBe(false);
    expect("Content-Type" in headers).toBe(false);
    // Non-managed header survives, and the real subject is set on the message.
    expect(headers["X-Keep"]).toBe("yes");
    expect(composed.subject).toBe("Real Subject");
  });

  it("throws EmailError when no sender resolvable", async () => {
    const backend = AWSSESBackend.fromIamRole({});
    await expect(backend.send("to@x.com", "s", { bodyText: "hi" })).rejects.toBeInstanceOf(
      EmailError,
    );
  });

  it("throws EmailError when no body provided", async () => {
    const backend = AWSSESBackend.fromIamRole({ defaultFrom: "a@b.com" });
    await expect(backend.send("to@x.com", "s", {})).rejects.toBeInstanceOf(EmailError);
  });

  it("maps MessageRejected to RecipientRejectedError", async () => {
    const backend = AWSSESBackend.fromIamRole({ defaultFrom: "a@b.com" });
    sesHarness.nextError = awsError("MessageRejected");
    await expect(backend.send("to@x.com", "s", { bodyText: "hi" })).rejects.toBeInstanceOf(
      RecipientRejectedError,
    );
  });

  it("maps FromEmailAddressNotVerified to SenderUnverifiedError", async () => {
    const backend = AWSSESBackend.fromIamRole({ defaultFrom: "a@b.com" });
    sesHarness.nextError = awsError("FromEmailAddressNotVerified");
    await expect(backend.send("to@x.com", "s", { bodyText: "hi" })).rejects.toBeInstanceOf(
      SenderUnverifiedError,
    );
  });

  it("maps TooManyRequestsException to EmailThrottledError", async () => {
    const backend = AWSSESBackend.fromIamRole({ defaultFrom: "a@b.com" });
    sesHarness.nextError = awsError("TooManyRequestsException");
    await expect(backend.send("to@x.com", "s", { bodyText: "hi" })).rejects.toBeInstanceOf(
      EmailThrottledError,
    );
  });

  it("maps MailFromDomainNotVerified to SenderUnverifiedError", async () => {
    const backend = AWSSESBackend.fromIamRole({ defaultFrom: "a@b.com" });
    sesHarness.nextError = awsError("MailFromDomainNotVerified");
    await expect(backend.send("to@x.com", "s", { bodyText: "hi" })).rejects.toBeInstanceOf(
      SenderUnverifiedError,
    );
  });

  it("maps the legacy Throttling code to EmailThrottledError", async () => {
    const backend = AWSSESBackend.fromIamRole({ defaultFrom: "a@b.com" });
    sesHarness.nextError = awsError("Throttling");
    await expect(backend.send("to@x.com", "s", { bodyText: "hi" })).rejects.toBeInstanceOf(
      EmailThrottledError,
    );
  });

  it("maps SendingPausedException to EmailThrottledError", async () => {
    const backend = AWSSESBackend.fromIamRole({ defaultFrom: "a@b.com" });
    sesHarness.nextError = awsError("SendingPausedException");
    await expect(backend.send("to@x.com", "s", { bodyText: "hi" })).rejects.toBeInstanceOf(
      EmailThrottledError,
    );
  });

  it("falls back to the .Code property when there is no error name", async () => {
    const backend = AWSSESBackend.fromIamRole({ defaultFrom: "a@b.com" });
    // A botocore-style error exposing `Code` (capital C) and no string `name`.
    const err = { Code: "MessageRejected", message: "rejected" } as unknown as Error;
    sesHarness.nextError = err;
    await expect(backend.send("to@x.com", "s", { bodyText: "hi" })).rejects.toBeInstanceOf(
      RecipientRejectedError,
    );
  });

  it("falls back to the lowercase .code property when name and .Code are absent", async () => {
    const backend = AWSSESBackend.fromIamRole({ defaultFrom: "a@b.com" });
    const err = { code: "SendingPausedException", message: "paused" } as unknown as Error;
    sesHarness.nextError = err;
    await expect(backend.send("to@x.com", "s", { bodyText: "hi" })).rejects.toBeInstanceOf(
      EmailThrottledError,
    );
  });

  it("maps an unknown error to EmailSendError", async () => {
    const backend = AWSSESBackend.fromIamRole({ defaultFrom: "a@b.com" });
    sesHarness.nextError = awsError("SomeOtherError", "boom");
    await expect(backend.send("to@x.com", "s", { bodyText: "hi" })).rejects.toBeInstanceOf(
      EmailSendError,
    );
  });

  it("resolves named profiles through fromIni credentials", async () => {
    const backend = AWSSESBackend.fromProfile({ profileName: "dev" });
    expect(await backend.healthCheck()).toBe(true);
    expect(credentialProviderMock.fromIni).toHaveBeenCalledWith({ profile: "dev" });
    expect(sesHarness.listCalls).toBe(1);
    await backend.close();
  });

  it("healthCheck returns true when ListEmailIdentities succeeds", async () => {
    const backend = AWSSESBackend.fromIamRole({ defaultFrom: "a@b.com" });
    expect(await backend.healthCheck()).toBe(true);
    expect(sesHarness.listCalls).toBe(1);
    await backend.close();
  });

  it("healthCheck returns false when ListEmailIdentities throws", async () => {
    const backend = AWSSESBackend.fromIamRole({ defaultFrom: "a@b.com" });
    // listError is honored by the list branch of the SES mock, so the failure
    // path is genuinely exercised (not a tautology).
    sesHarness.listError = awsError("AccessDenied");
    expect(await backend.healthCheck()).toBe(false);
    expect(sesHarness.listCalls).toBe(1);
    await backend.close();
  });
});

// ---------------------------------------------------------------------------
// SMTP backend
// ---------------------------------------------------------------------------

describe("SMTPEmailBackend", () => {
  it("sends mail with auth and returns a message id", async () => {
    const backend = SMTPEmailBackend.fromStarttls({
      host: "smtp.example.com",
      username: "apikey",
      password: "secret",
      defaultFrom: "noreply@example.com",
    });
    const id = await backend.send(["to@x.com"], "Hi", {
      bodyText: "body",
      bcc: ["bcc@x.com"],
    });
    expect(id).toMatch(/^<[0-9a-f]+@example\.com>$/);
    const msg = smtpHarness.sentMessages[0]!;
    expect(msg.from).toBe("noreply@example.com");
    expect(msg.to).toEqual(["to@x.com"]);
    expect(msg.bcc).toEqual(["bcc@x.com"]);
    expect(smtpHarness.transportOptions[0]).toMatchObject({
      auth: { user: "apikey", pass: "secret" },
    });
    expect(smtpHarness.closed).toBe(1);
  });

  it("sends replyTo and attachments, honoring explicit and default content types", async () => {
    const backend = SMTPEmailBackend.fromStarttls({
      host: "smtp.example.com",
      username: "u",
      password: "p",
      defaultFrom: "noreply@example.com",
    });
    await backend.send("to@x.com", "Hi", {
      bodyText: "body",
      replyTo: ["reply@x.com"],
      attachments: [
        {
          filename: "report.pdf",
          content: new Uint8Array([1, 2, 3]),
          contentType: "application/pdf",
        },
        { filename: "blob.bin", content: new Uint8Array([4, 5]) },
      ],
    });
    const msg = smtpHarness.sentMessages[0]!;
    expect(msg.replyTo).toEqual(["reply@x.com"]);
    const atts = msg.attachments as Array<Record<string, unknown>>;
    expect(atts).toHaveLength(2);
    expect(atts[0]!.filename).toBe("report.pdf");
    expect(atts[0]!.contentType).toBe("application/pdf");
    // No explicit contentType => the octet-stream default.
    expect(atts[1]!.contentType).toBe("application/octet-stream");
  });

  it("maps transient 450/451/452 reply codes to EmailThrottledError", async () => {
    for (const responseCode of [450, 451, 452]) {
      smtpHarness.sentMessages = [];
      const backend = SMTPEmailBackend.fromStarttls({
        host: "h",
        username: "u",
        password: "p",
        defaultFrom: "a@b.com",
      });
      smtpHarness.nextError = Object.assign(new Error(`transient ${responseCode}`), {
        responseCode,
      });
      await expect(backend.send("to@x.com", "s", { bodyText: "hi" })).rejects.toBeInstanceOf(
        EmailThrottledError,
      );
    }
  });

  it("maps 551/553 reply codes (no EENVELOPE) to RecipientRejectedError", async () => {
    for (const responseCode of [551, 553]) {
      smtpHarness.sentMessages = [];
      const backend = SMTPEmailBackend.fromStarttls({
        host: "h",
        username: "u",
        password: "p",
        defaultFrom: "a@b.com",
      });
      smtpHarness.nextError = Object.assign(new Error(`refused ${responseCode}`), { responseCode });
      await expect(backend.send("to@x.com", "s", { bodyText: "hi" })).rejects.toBeInstanceOf(
        RecipientRejectedError,
      );
    }
  });

  it("maps a recipient-refused reply code to RecipientRejectedError", async () => {
    const backend = SMTPEmailBackend.fromStarttls({
      host: "h",
      username: "u",
      password: "p",
      defaultFrom: "a@b.com",
    });
    const err = Object.assign(new Error("refused"), { responseCode: 550 });
    smtpHarness.nextError = err;
    await expect(backend.send("to@x.com", "s", { bodyText: "hi" })).rejects.toBeInstanceOf(
      RecipientRejectedError,
    );
    expect(smtpHarness.closed).toBe(1);
  });

  it("maps a transient reply code to EmailThrottledError", async () => {
    const backend = SMTPEmailBackend.fromStarttls({
      host: "h",
      username: "u",
      password: "p",
      defaultFrom: "a@b.com",
    });
    smtpHarness.nextError = Object.assign(new Error("slow down"), { responseCode: 421 });
    await expect(backend.send("to@x.com", "s", { bodyText: "hi" })).rejects.toBeInstanceOf(
      EmailThrottledError,
    );
  });

  it("maps an EENVELOPE with rejected recipients to RecipientRejectedError", async () => {
    const backend = SMTPEmailBackend.fromStarttls({
      host: "h",
      username: "u",
      password: "p",
      defaultFrom: "a@b.com",
    });
    smtpHarness.nextError = Object.assign(new Error("bad envelope"), {
      code: "EENVELOPE",
      responseCode: 550,
      rejected: ["to@x.com"],
    });
    await expect(backend.send("to@x.com", "s", { bodyText: "hi" })).rejects.toBeInstanceOf(
      RecipientRejectedError,
    );
  });

  it("maps an EENVELOPE sender refusal (no rejected recipients) to SenderUnverifiedError", async () => {
    const backend = SMTPEmailBackend.fromStarttls({
      host: "h",
      username: "u",
      password: "p",
      defaultFrom: "a@b.com",
    });
    // nodemailer surfaces a MAIL-FROM rejection (SMTPSenderRefused) as
    // err.code === "EENVELOPE" with a 55x responseCode and no rejected[] array.
    smtpHarness.nextError = Object.assign(new Error("sender refused"), {
      code: "EENVELOPE",
      responseCode: 553,
    });
    await expect(backend.send("to@x.com", "s", { bodyText: "hi" })).rejects.toBeInstanceOf(
      SenderUnverifiedError,
    );
  });

  it("maps an unknown SMTP failure to EmailSendError", async () => {
    const backend = SMTPEmailBackend.fromStarttls({
      host: "h",
      username: "u",
      password: "p",
      defaultFrom: "a@b.com",
    });
    smtpHarness.nextError = new Error("connection reset");
    await expect(backend.send("to@x.com", "s", { bodyText: "hi" })).rejects.toBeInstanceOf(
      EmailSendError,
    );
  });

  it("healthCheck verifies the transport", async () => {
    const backend = SMTPEmailBackend.fromPlaintext({ host: "localhost" });
    expect(await backend.healthCheck()).toBe(true);
    smtpHarness.verifyResult = false;
    expect(await backend.healthCheck()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Azure ACS backend
// ---------------------------------------------------------------------------

describe("AzureACSEmailBackend", () => {
  it("connection-string auth constructs the client with one arg and sends", async () => {
    const backend = AzureACSEmailBackend.fromConnectionString({
      connectionString: "endpoint=https://x.communication.azure.com;accesskey=KEY",
      defaultFrom: "DoNotReply@example.com",
    });
    const id = await backend.send("to@x.com", "Subj", {
      bodyText: "hi",
      bodyHtml: "<p>hi</p>",
      cc: ["cc@x.com"],
      attachments: [{ filename: "a.bin", content: new Uint8Array([1, 2, 3]) }],
    });
    expect(id).toBe("acs-message-id");
    expect(acsHarness.ctorArgs[0]!.length).toBe(1);
    const msg = acsHarness.sendMessages[0]!;
    expect(msg.senderAddress).toBe("DoNotReply@example.com");
    expect((msg.recipients as Record<string, unknown>).to).toEqual([{ address: "to@x.com" }]);
    expect((msg.recipients as Record<string, unknown>).cc).toEqual([{ address: "cc@x.com" }]);
    expect((msg.content as Record<string, unknown>).plainText).toBe("hi");
    const att = (msg.attachments as Array<Record<string, unknown>>)[0]!;
    expect(att.name).toBe("a.bin");
    expect(att.contentType).toBe("application/octet-stream");
    expect(att.contentInBase64).toBe(Buffer.from([1, 2, 3]).toString("base64"));
  });

  it("maps replyTo and bcc into the ACS message shape", async () => {
    const backend = AzureACSEmailBackend.fromConnectionString({
      connectionString: "endpoint=https://x;accesskey=K",
      defaultFrom: "a@b.com",
    });
    await backend.send("to@x.com", "Subj", {
      bodyText: "hi",
      bcc: ["bcc@x.com"],
      replyTo: ["reply@x.com"],
    });
    const msg = acsHarness.sendMessages[0]!;
    expect((msg.recipients as Record<string, unknown>).bcc).toEqual([{ address: "bcc@x.com" }]);
    expect(msg.replyTo).toEqual([{ address: "reply@x.com" }]);
  });

  it("managed identity auth builds a ManagedIdentityCredential and closes it", async () => {
    const backend = AzureACSEmailBackend.fromManagedIdentity({
      endpoint: "https://x.communication.azure.com",
      defaultFrom: "a@b.com",
      clientId: "mi-client",
    });
    await backend.send("to@x.com", "s", { bodyText: "hi" });
    expect(acsHarness.credentials[0]).toMatchObject({
      kind: "managed",
      args: [{ clientId: "mi-client" }],
    });
    expect(acsHarness.ctorArgs[0]!.length).toBe(2);
    await backend.close();
    expect(acsHarness.credentials[0]?.closed).toBe(true);
  });

  it("service principal auth builds a ClientSecretCredential", async () => {
    const backend = AzureACSEmailBackend.fromServicePrincipal({
      endpoint: "https://x.communication.azure.com",
      tenantId: "t",
      clientId: "c",
      clientSecret: "s",
      defaultFrom: "a@b.com",
    });
    await backend.send("to@x.com", "s", { bodyText: "hi" });
    expect(acsHarness.credentials[0]).toMatchObject({
      kind: "service-principal",
      args: ["t", "c", "s"],
    });
  });

  it("maps a 429 to EmailThrottledError", async () => {
    const backend = AzureACSEmailBackend.fromConnectionString({
      connectionString: "endpoint=https://x;accesskey=K",
      defaultFrom: "a@b.com",
    });
    acsHarness.nextError = Object.assign(new Error("Too many"), { statusCode: 429 });
    await expect(backend.send("to@x.com", "s", { bodyText: "hi" })).rejects.toBeInstanceOf(
      EmailThrottledError,
    );
  });

  it("maps a 403 DomainNotLinked to SenderUnverifiedError", async () => {
    const backend = AzureACSEmailBackend.fromConnectionString({
      connectionString: "endpoint=https://x;accesskey=K",
      defaultFrom: "a@b.com",
    });
    acsHarness.nextError = Object.assign(new Error("DomainNotLinked to resource"), {
      statusCode: 403,
    });
    await expect(backend.send("to@x.com", "s", { bodyText: "hi" })).rejects.toBeInstanceOf(
      SenderUnverifiedError,
    );
  });

  it("maps a 400 InvalidRecipient to RecipientRejectedError", async () => {
    const backend = AzureACSEmailBackend.fromConnectionString({
      connectionString: "endpoint=https://x;accesskey=K",
      defaultFrom: "a@b.com",
    });
    acsHarness.nextError = Object.assign(new Error("InvalidRecipient address"), {
      statusCode: 400,
    });
    await expect(backend.send("to@x.com", "s", { bodyText: "hi" })).rejects.toBeInstanceOf(
      RecipientRejectedError,
    );
  });

  it("maps a 400 InvalidAddress to RecipientRejectedError", async () => {
    const backend = AzureACSEmailBackend.fromConnectionString({
      connectionString: "endpoint=https://x;accesskey=K",
      defaultFrom: "a@b.com",
    });
    acsHarness.nextError = Object.assign(new Error("InvalidAddress format"), { statusCode: 400 });
    await expect(backend.send("to@x.com", "s", { bodyText: "hi" })).rejects.toBeInstanceOf(
      RecipientRejectedError,
    );
  });

  it("maps an unknown error to EmailSendError", async () => {
    const backend = AzureACSEmailBackend.fromConnectionString({
      connectionString: "endpoint=https://x;accesskey=K",
      defaultFrom: "a@b.com",
    });
    acsHarness.nextError = new Error("kaboom");
    await expect(backend.send("to@x.com", "s", { bodyText: "hi" })).rejects.toBeInstanceOf(
      EmailSendError,
    );
  });

  it("close is idempotent: it closes the token credential once and a second call is a no-op", async () => {
    // Ported from cloudrift-py/tests/test_email.py::test_acs_close_idempotent.
    const backend = AzureACSEmailBackend.fromManagedIdentity({
      endpoint: "https://x.communication.azure.com",
      defaultFrom: "a@b.com",
      clientId: "mi-client",
    });
    // Force lazy client + credential creation.
    await backend.send("to@x.com", "s", { bodyText: "hi" });
    const cred = acsHarness.credentials[0]!;
    expect(cred.closed).toBe(false);

    await backend.close();
    expect(cred.closed).toBe(true);
    // A second close must not raise (credential already released).
    await expect(backend.close()).resolves.toBeUndefined();
    // No duplicate credential was created/closed.
    expect(acsHarness.credentials).toHaveLength(1);
  });

  it("connection-string close is a no-op (no credential to release)", async () => {
    const backend = AzureACSEmailBackend.fromConnectionString({
      connectionString: "endpoint=https://x;accesskey=K",
      defaultFrom: "a@b.com",
    });
    await backend.send("to@x.com", "s", { bodyText: "hi" });
    // No credential was constructed for connection-string auth.
    expect(acsHarness.credentials).toHaveLength(0);
    await expect(backend.close()).resolves.toBeUndefined();
    await expect(backend.close()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// EmailBackend base defaults
// ---------------------------------------------------------------------------

describe("EmailBackend default methods", () => {
  class FakeBackend extends EmailBackend {
    sent: Array<{ to: string | string[]; subject: string; options: unknown }> = [];
    async send(to: string | string[], subject: string, options = {}): Promise<string> {
      this.sent.push({ to, subject, options });
      return `id-${this.sent.length}`;
    }
  }

  it("sendBatch loops send and collects ids, normalizing empty arrays to undefined", async () => {
    const backend = new FakeBackend();
    const messages: EmailMessage[] = [
      { to: ["a@x.com"], subject: "one", bodyText: "1", cc: [], replyTo: ["r@x.com"] },
      { to: ["b@x.com"], subject: "two", bodyHtml: "<p>2</p>" },
    ];
    const ids = await backend.sendBatch(messages);
    expect(ids).toEqual(["id-1", "id-2"]);
    expect((backend.sent[0]!.options as { cc?: unknown }).cc).toBeUndefined();
    expect((backend.sent[0]!.options as { replyTo?: unknown }).replyTo).toEqual(["r@x.com"]);
  });

  it("healthCheck default returns true and close is a no-op", async () => {
    const backend = new FakeBackend();
    expect(await backend.healthCheck()).toBe(true);
    await expect(backend.close()).resolves.toBeUndefined();
  });

  it("asyncDispose delegates to close", async () => {
    const backend = new FakeBackend();
    let closed = false;
    backend.close = async () => {
      closed = true;
    };
    await backend[Symbol.asyncDispose]();
    expect(closed).toBe(true);
  });
});
