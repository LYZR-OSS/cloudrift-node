/**
 * AWS SES email live tests.
 *
 * Gated on CLOUDRIFT_LIVE_TESTS=1 plus a region and one auth method, with the
 * "ses" service allowlisted. The health-check block needs only region + auth
 * (no verified identities) so it is gated separately from the send blocks,
 * which additionally require verified FROM/TO addresses
 * (CLOUDRIFT_LIVE_AWS_SES_FROM / _SES_TO).
 *
 * Email send has no server-side resource to clean up, so there is no teardown
 * beyond closing the backend (which releases the SESv2 client sockets).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getEmail } from "../../src/index.js";
import { awsServiceEnabled, env, getSesConfig, liveLog, requireEnv, SES_PRESENT } from "./env.js";

/* ------------------------------------------------------------------ */
/* Shared AWS auth resolution (mirrors aws.live.test.ts)              */
/* ------------------------------------------------------------------ */

const REGION = env("CLOUDRIFT_LIVE_AWS_REGION");

/** Build the cloudrift email factory auth options from env (access key or profile). */
function awsAuthOptions(): Record<string, unknown> {
  const accessKeyId = env("CLOUDRIFT_LIVE_AWS_ACCESS_KEY_ID");
  const secretAccessKey = env("CLOUDRIFT_LIVE_AWS_SECRET_ACCESS_KEY");
  const sessionToken = env("CLOUDRIFT_LIVE_AWS_SESSION_TOKEN");
  const profileName = env("CLOUDRIFT_LIVE_AWS_PROFILE");
  if (accessKeyId !== undefined && secretAccessKey !== undefined) {
    return {
      region: REGION,
      awsAccessKeyId: accessKeyId,
      awsSecretAccessKey: secretAccessKey,
      ...(sessionToken ? { awsSessionToken: sessionToken } : {}),
    };
  }
  return { region: REGION, profileName };
}

/** Region + one auth method present (access key pair or profile). */
const AWS_AUTH_PRESENT =
  requireEnv([
    "CLOUDRIFT_LIVE_AWS_REGION",
    "CLOUDRIFT_LIVE_AWS_ACCESS_KEY_ID",
    "CLOUDRIFT_LIVE_AWS_SECRET_ACCESS_KEY",
  ]) || requireEnv(["CLOUDRIFT_LIVE_AWS_REGION", "CLOUDRIFT_LIVE_AWS_PROFILE"]);

/** Health check needs only region + auth + the "ses" allowlist token. */
const SES_HEALTH_PRESENT = AWS_AUTH_PRESENT && awsServiceEnabled("ses");

/* ================================================================== */
/* SES health check (no verified identities required)                 */
/* ================================================================== */

describe.skipIf(!SES_HEALTH_PRESENT)("AWS SES live health check", () => {
  const log = liveLog("ses:health");
  let backend: Awaited<ReturnType<typeof getEmail>> | undefined;

  beforeAll(async () => {
    log.step("initializing backend", { provider: "ses", region: REGION });
    backend = await getEmail("ses", awsAuthOptions());
  });

  afterAll(async () => {
    try {
      await backend?.close();
      log.step("closed backend", {});
    } catch (err) {
      log.warn("backend close failed", err, {});
    }
  });

  it("reports healthy against real SES", async () => {
    expect(backend).toBeDefined();
    const healthy = await backend!.healthCheck();
    expect(healthy).toBe(true);
    log.step("health check passed", { region: REGION });
  });
});

/* ================================================================== */
/* SES send (requires verified FROM / TO addresses)                   */
/* ================================================================== */

describe.skipIf(!SES_PRESENT)("AWS SES live send", () => {
  const log = liveLog("ses:send");
  const ses = getSesConfig();
  let backend: Awaited<ReturnType<typeof getEmail>> | undefined;

  beforeAll(async () => {
    log.step("initializing backend", { provider: "ses", region: REGION, from: ses.from });
    backend = await getEmail("ses", { ...awsAuthOptions(), defaultFrom: ses.from });
  });

  afterAll(async () => {
    try {
      await backend?.close();
      log.step("closed backend", {});
    } catch (err) {
      log.warn("backend close failed", err, {});
    }
  });

  it("sends a simple text + html email and returns a MessageId", async () => {
    expect(backend).toBeDefined();
    const subject = `cloudrift-live ${new Date().toISOString()}`;
    log.step("sending simple email", { from: ses.from, to: ses.to, subject });
    const messageId = await backend!.send(ses.to!, subject, {
      from: ses.from,
      bodyText: "cloudrift live SES test (text).",
      bodyHtml: "<p>cloudrift live SES test (<strong>html</strong>).</p>",
    });
    expect(typeof messageId).toBe("string");
    expect(messageId.length).toBeGreaterThan(0);
    log.step("sent simple email", { messageId });
  });

  it("sends an email with an attachment (raw MIME) and returns a MessageId", async () => {
    expect(backend).toBeDefined();
    const subject = `cloudrift-live attach ${new Date().toISOString()}`;
    const content = new TextEncoder().encode("cloudrift attachment payload");
    log.step("sending email with attachment", { from: ses.from, to: ses.to, subject });
    const messageId = await backend!.send(ses.to!, subject, {
      from: ses.from,
      bodyText: "cloudrift live SES test with attachment.",
      attachments: [{ filename: "hello.txt", content, contentType: "text/plain" }],
    });
    expect(typeof messageId).toBe("string");
    expect(messageId.length).toBeGreaterThan(0);
    log.step("sent email with attachment", { messageId });
  });
});
