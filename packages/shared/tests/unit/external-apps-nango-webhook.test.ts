import {
  NANGO_HMAC_HEADER,
  verifyNangoWebhookSignature,
} from "@fretik/shared/lib/external-apps/nango-webhook-signature";
import { decideNangoWebhook } from "@fretik/shared/services/external-apps/webhooks/decide-nango-webhook";
import { describe, expect, test } from "bun:test";

/**
 * `/webhooks/nango` is unauthenticated by necessity — Nango carries no cookie
 * and no key of ours — so the signature IS the authentication, and it guards
 * a write keyed entirely on values the body supplies. Anyone who can reach
 * the URL can otherwise mark any connection dead.
 *
 * The digests below were produced with `crypto.createHmac`, which `Bun.
 * CryptoHasher` was checked against byte for byte before this was written.
 */

const SECRET = "nango-signing-key";

/** What Nango sends: HMAC-SHA256 of the exact body, hex, under the key. */
const sign = (body: string, secret = SECRET): string =>
  new Bun.CryptoHasher("sha256", secret).update(body).digest("hex");

const deletionBody = JSON.stringify({
  from: "nango",
  type: "auth",
  connectionId: "conn_9f2a",
  providerConfigKey: "ftp-sftp",
  provider: "private-api-bearer",
  environment: "prod",
  operation: "deletion",
  success: true,
});

describe("only a genuine Nango delivery is accepted", () => {
  test("the header name is the HMAC one, never the length-extendable hash", () => {
    // Nango sends both. `X-Nango-Signature` is sha256(secret + payload) and
    // its own source calls it vulnerable; accepting it would let anyone
    // holding one valid pair forge a longer body without the secret.
    expect(NANGO_HMAC_HEADER).toBe("x-nango-hmac-sha256");
  });

  test("a body signed with our key verifies", () => {
    expect(
      verifyNangoWebhookSignature({
        rawBody: deletionBody,
        signature: sign(deletionBody),
        secret: SECRET,
      }),
    ).toBe(true);
  });

  test("a body signed with another key does not", () => {
    expect(
      verifyNangoWebhookSignature({
        rawBody: deletionBody,
        signature: sign(deletionBody, "someone-elses-key"),
        secret: SECRET,
      }),
    ).toBe(false);
  });

  test("a tampered body does not, even one character in", () => {
    const signature = sign(deletionBody);
    const tampered = deletionBody.replace("conn_9f2a", "conn_9f2b");
    expect(
      verifyNangoWebhookSignature({
        rawBody: tampered,
        signature,
        secret: SECRET,
      }),
    ).toBe(false);
  });

  test("no signature at all is a refusal, not a pass", () => {
    for (const signature of [undefined, ""]) {
      expect(
        verifyNangoWebhookSignature({
          rawBody: deletionBody,
          signature,
          secret: SECRET,
        }),
      ).toBe(false);
    }
  });

  test("a malformed signature is refused rather than thrown", () => {
    // `timingSafeEqual` throws on a length mismatch, so a short or non-hex
    // header would surface as a 500 — and a 500 is what Nango retries.
    for (const signature of ["abc", "z".repeat(64), "!".repeat(200)]) {
      expect(() =>
        verifyNangoWebhookSignature({
          rawBody: deletionBody,
          signature,
          secret: SECRET,
        }),
      ).not.toThrow();
      expect(
        verifyNangoWebhookSignature({
          rawBody: deletionBody,
          signature,
          secret: SECRET,
        }),
      ).toBe(false);
    }
  });

  test("the bytes signed are the bytes received", () => {
    // Nango signs its own stable stringification. Re-serialising a parsed
    // body reorders keys and drops whitespace, so the same DATA no longer
    // verifies — which is why the route reads `c.req.text()` and parses only
    // afterwards. If this ever passes, the route is free to parse first and
    // the signature stops meaning anything.
    const signature = sign(deletionBody);
    const reserialised = JSON.stringify(
      Object.fromEntries(
        Object.entries(JSON.parse(deletionBody) as Record<string, unknown>)
          .slice()
          .reverse(),
      ),
    );
    expect(reserialised).not.toBe(deletionBody);
    expect(
      verifyNangoWebhookSignature({
        rawBody: reserialised,
        signature,
        secret: SECRET,
      }),
    ).toBe(false);
  });
});

describe("what a verified delivery is taken to mean", () => {
  test("an auth deletion names the connection to mark", () => {
    const decision = decideNangoWebhook(JSON.parse(deletionBody));
    expect(decision).toMatchObject({
      action: "connection-deleted-upstream",
      nangoConnectionId: "conn_9f2a",
      nangoProviderConfigKey: "ftp-sftp",
    });
  });

  test("the reason is written for the person reading the settings page", () => {
    const decision = decideNangoWebhook(JSON.parse(deletionBody));
    if (decision.action !== "connection-deleted-upstream") {
      throw new Error("expected a deletion decision");
    }
    // It lands in `lastErrorMessage`, under a Reconnect button. Naming the
    // webhook there would tell the user nothing they can act on.
    expect(decision.reason).toContain("Reconnect");
    expect(decision.reason.toLowerCase()).not.toContain("webhook");
    expect(decision.reason.length).toBeLessThanOrEqual(500);
  });

  test("every other auth operation is ignored, not acted on", () => {
    // `creation` and `override` race our own row insert from the Connect UI
    // callback; `refresh` is already covered by the lazy path, and marking it
    // twice would overwrite one message with another.
    for (const operation of ["creation", "override", "refresh", "unknown"]) {
      const decision = decideNangoWebhook({
        from: "nango",
        type: "auth",
        connectionId: "conn_9f2a",
        providerConfigKey: "ftp-sftp",
        operation,
      });
      expect(decision.action).toBe("ignored");
    }
  });

  test("the other webhook types are ignored", () => {
    for (const body of [
      {
        from: "nango",
        type: "sync",
        connectionId: "c",
        providerConfigKey: "p",
      },
      { from: "nango", type: "forward", providerConfigKey: "p" },
      { from: "nango", type: "async_action", connectionId: "c" },
    ]) {
      expect(decideNangoWebhook(body).action).toBe("ignored");
    }
  });

  test("junk is ignored rather than rejected", () => {
    // Nango retries a non-2xx. An event that will never parse would retry
    // forever, so it has to be acknowledged.
    for (const body of [null, undefined, "", 42, [], {}, { type: "auth" }]) {
      expect(decideNangoWebhook(body).action).toBe("ignored");
    }
  });

  test("an unknown field does not stop a deletion being seen", () => {
    // Nango adds fields between versions — `tags` and `endUser` both arrived
    // that way. A connection going unnoticed because of one is a bad trade.
    const decision = decideNangoWebhook({
      ...(JSON.parse(deletionBody) as Record<string, unknown>),
      somethingNangoAddedLater: { nested: true },
    });
    expect(decision.action).toBe("connection-deleted-upstream");
  });
});
