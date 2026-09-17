import { SignJWT, jwtVerify } from "jose";
import { randomUUID } from "node:crypto";

/**
 * The credential the sandbox's code-mode SDK presents on
 * `POST /sandbox/exec`, minted fresh for each turn that runs code.
 *
 * It is the tenancy boundary: the route trusts these claims and nothing else,
 * so what the token says about org, team and user IS what the caller gets to
 * read and write. That makes two properties load-bearing.
 *
 * **It is bound to one sandbox.** `sandboxId` is checked against the live
 * registry entry for the conversation, so a token copied out of a workspace
 * stops working the moment that sandbox is killed or expires — instead of
 * staying valid for the rest of its hour, from anywhere.
 *
 * **It carries a `jti`.** Every dispatch is logged with it, so a suspicious
 * call can be traced back to the turn that minted the credential rather than
 * to an anonymous 401 count.
 *
 * ## Where it lives
 *
 * Nowhere in the guest, whenever that is possible. The token is handed to
 * E2B's egress proxy as a per-host header rule, so it is added to requests on
 * the way OUT and never exists inside the VM — which matters because the
 * sandbox runs agent-authored code as root, so anything written into the
 * workspace is readable by a prompt-injected turn.
 *
 * Two situations make brokering impossible, and both degrade to writing the
 * token into `/workspace/.fretik/auth.json` for that turn rather than failing
 * it: a backend URL that is not HTTPS (see `canBrokerSandboxJwt`), and an
 * `updateNetwork` call that did not land. Neither is a mode anyone selects.
 * The floor they fall to is the posture this code shipped with before, minus
 * its worst property — a token written today is still bound to one sandbox
 * and dies with it.
 *
 * Expiration semantics — the TTL covers *within* a turn. Across turns a fresh
 * token is always minted before code runs, so an old one is simply never read.
 */

export interface SandboxJwtClaims {
  conversationId: string;
  teamId: string;
  userId: string;
  organizationId: string;
  turnId: string;
  /** E2B sandbox this token was minted for; checked against the registry. */
  sandboxId: string;
  /** Unique id of this credential, for the audit trail. */
  jti: string;
}

/** Claims the caller supplies; `jti` is minted here. */
export type SandboxJwtInput = Omit<SandboxJwtClaims, "jti">;

const TTL_SECONDS = 60 * 60; // 1 hour — covers a single agent turn.

/**
 * Pinned so a token minted for the sandbox seam cannot be replayed at any
 * other verifier that happens to share the secret, and vice versa.
 */
const ISSUER = "fretik-ai";
const AUDIENCE = "fretik:sandbox-exec";

const getSecret = (): Uint8Array => {
  const raw = Bun.env.SANDBOX_JWT_SECRET;
  if (raw === undefined || raw === "") {
    throw new Error("SANDBOX_JWT_SECRET env var must be set");
  }
  return new TextEncoder().encode(raw);
};

const requireString = (value: unknown, key: string): string => {
  if (typeof value !== "string" || value === "") {
    throw new Error(`Sandbox JWT: missing or invalid claim "${key}"`);
  }
  return value;
};

/**
 * Whether the egress proxy can carry this turn's credential.
 *
 * It is not a preference and there is no switch: brokering is what we always
 * want, and the one thing that can make it impossible is mechanical. E2B
 * terminates TLS to inject a header, so over plain HTTP there is nothing to
 * terminate and the header is never added — which would surface as an auth
 * bug rather than the configuration problem it is. A caller that gets `false`
 * degrades to writing the token into the workspace for that turn.
 */
export const canBrokerSandboxJwt = (): boolean =>
  (Bun.env.FRETIK_BACKEND_INTERNAL_URL ?? "").startsWith("https://");

export interface SignedSandboxJwt {
  token: string;
  jti: string;
}

export const signSandboxJwt = async (
  claims: SandboxJwtInput,
): Promise<SignedSandboxJwt> => {
  const jti = randomUUID();
  const token = await new SignJWT({
    conversationId: claims.conversationId,
    teamId: claims.teamId,
    userId: claims.userId,
    organizationId: claims.organizationId,
    turnId: claims.turnId,
    sandboxId: claims.sandboxId,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setJti(jti)
    .setSubject(claims.userId)
    .setExpirationTime(`${TTL_SECONDS.toString()}s`)
    .sign(getSecret());
  return { token, jti };
};

export const verifySandboxJwt = async (
  token: string,
): Promise<SandboxJwtClaims> => {
  const { payload } = await jwtVerify(token, getSecret(), {
    algorithms: ["HS256"],
    issuer: ISSUER,
    audience: AUDIENCE,
  });
  return {
    conversationId: requireString(payload.conversationId, "conversationId"),
    teamId: requireString(payload.teamId, "teamId"),
    userId: requireString(payload.userId, "userId"),
    organizationId: requireString(payload.organizationId, "organizationId"),
    turnId: requireString(payload.turnId, "turnId"),
    sandboxId: requireString(payload.sandboxId, "sandboxId"),
    jti: requireString(payload.jti, "jti"),
  };
};
