import { beforeAll, describe, expect, test } from "bun:test";
import { SignJWT } from "jose";
import { rejection } from "../lib/expect-rejection";

/**
 * The sandbox credential — what a token has to say before `/sandbox/exec`
 * treats it as a tenant.
 *
 * The claims are not decoration: the route reads org, team and user straight
 * off them, so a token missing one, or minted for a different audience, must
 * be refused rather than defaulted. `sandboxId` is the claim that bounds a
 * leak, which is why an old-shape token without it is not accepted.
 */

const SECRET = "test-sandbox-jwt-secret-not-a-real-one";

beforeAll(() => {
  Bun.env.SANDBOX_JWT_SECRET = SECRET;
});

const { canBrokerSandboxJwt, signSandboxJwt, verifySandboxJwt } =
  await import("../../src/lib/external-apps/sandbox-jwt");

const CLAIMS = {
  conversationId: "conv-1",
  teamId: "team-1",
  userId: "user-1",
  organizationId: "org-1",
  turnId: "turn-1",
  sandboxId: "sbx-1",
};

describe("signSandboxJwt / verifySandboxJwt", () => {
  test("every claim the route depends on survives the round trip", async () => {
    const { token, jti } = await signSandboxJwt(CLAIMS);
    const verified = await verifySandboxJwt(token);
    expect(verified).toEqual({ ...CLAIMS, jti });
  });

  test("each token carries a distinct id, so the audit trail can tell them apart", async () => {
    const first = await signSandboxJwt(CLAIMS);
    const second = await signSandboxJwt(CLAIMS);
    expect(first.jti).not.toBe(second.jti);
  });

  test("a token signed with another secret is refused", async () => {
    const foreign = await new SignJWT({ ...CLAIMS })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setIssuer("fretik-ai")
      .setAudience("fretik:sandbox-exec")
      .setJti("jti-1")
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode("a-different-secret"));
    await rejection(verifySandboxJwt(foreign));
  });

  test("an expired token is refused", async () => {
    const stale = await new SignJWT({ ...CLAIMS })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setIssuer("fretik-ai")
      .setAudience("fretik:sandbox-exec")
      .setJti("jti-1")
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(new TextEncoder().encode(SECRET));
    await rejection(verifySandboxJwt(stale));
  });

  test("a token minted for another audience is refused", async () => {
    // Anything else sharing this secret must not be able to mint a credential
    // this route accepts, and vice versa.
    const wrongAudience = await new SignJWT({ ...CLAIMS })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setIssuer("fretik-ai")
      .setAudience("some-other-service")
      .setJti("jti-1")
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(SECRET));
    await rejection(verifySandboxJwt(wrongAudience));
  });

  test("a token from the shape that predates sandbox binding is refused", async () => {
    // It would otherwise verify and dispatch with an undefined sandbox, which
    // is exactly the unbounded credential this claim exists to end.
    const oldShape = await new SignJWT({
      conversationId: "conv-1",
      teamId: "team-1",
      userId: "user-1",
      organizationId: "org-1",
      turnId: "turn-1",
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setIssuer("fretik-ai")
      .setAudience("fretik:sandbox-exec")
      .setJti("jti-1")
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(SECRET));
    const error = await rejection(verifySandboxJwt(oldShape));
    expect(error.message).toContain("sandboxId");
  });

  test("a token with no id is refused", async () => {
    const noJti = await new SignJWT({ ...CLAIMS })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setIssuer("fretik-ai")
      .setAudience("fretik:sandbox-exec")
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(SECRET));
    const error = await rejection(verifySandboxJwt(noJti));
    expect(error.message).toContain("jti");
  });

  test("the payload does not leak the secret", async () => {
    const { token } = await signSandboxJwt(CLAIMS);
    expect(token).not.toContain(SECRET);
  });
});

describe("canBrokerSandboxJwt", () => {
  const withBackendUrl = <T>(value: string | undefined, fn: () => T): T => {
    const previous = Bun.env.FRETIK_BACKEND_INTERNAL_URL;
    if (value === undefined) delete Bun.env.FRETIK_BACKEND_INTERNAL_URL;
    else Bun.env.FRETIK_BACKEND_INTERNAL_URL = value;
    try {
      return fn();
    } finally {
      if (previous === undefined) delete Bun.env.FRETIK_BACKEND_INTERNAL_URL;
      else Bun.env.FRETIK_BACKEND_INTERNAL_URL = previous;
    }
  };

  test("https is the only shape the egress proxy can inject into", () => {
    // Not a preference: over plain HTTP there is no TLS to terminate, so the
    // header is never added and the failure would read as an auth bug.
    expect(withBackendUrl("https://api.example.com", canBrokerSandboxJwt)).toBe(
      true,
    );
    expect(withBackendUrl("http://api.example.com", canBrokerSandboxJwt)).toBe(
      false,
    );
    expect(withBackendUrl("", canBrokerSandboxJwt)).toBe(false);
    expect(withBackendUrl(undefined, canBrokerSandboxJwt)).toBe(false);
  });
});
