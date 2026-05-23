import { SignJWT, jwtVerify } from "jose";

/**
 * Short-lived JWT issued by the chatbot handler before each turn that may
 * touch external apps. Written into `/workspace/.fretik/auth.json` of the
 * E2B sandbox, where `fretik_apps._runtime.py` reads it fresh on every
 * `call()` and includes it as the `Authorization` header on
 * `POST /sandbox/exec`.
 *
 * Why a per-turn file (not env) — the Jupyter kernel persists across
 * turns, so `os.environ` is frozen at kernel start; a per-turn file lets
 * the JWT rotate without restarting the kernel.
 *
 * Expiration semantics — the 1h TTL is for *within* a turn. Across turns,
 * the chatbot handler always mints a fresh JWT before executing python,
 * so an expired JWT from days ago is simply overwritten and never read.
 * A user can ignore a `pending` approval for days, come back, click
 * Approve → that triggers a NEW turn → fresh JWT → re-execution → grant
 * matched in DB. The sandbox itself may have been recycled by E2B in the
 * interim; durable state lives in the DB (the approval row + the
 * conversation), so the new sandbox bootstraps from scratch and works.
 */

export interface SandboxJwtClaims {
  conversationId: string;
  teamId: string;
  userId: string;
  organizationId: string;
  turnId: string;
}

const TTL_SECONDS = 60 * 60; // 1 hour — covers a single agent turn.

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

export const signSandboxJwt = async (
  claims: SandboxJwtClaims,
): Promise<string> =>
  new SignJWT({
    conversationId: claims.conversationId,
    teamId: claims.teamId,
    userId: claims.userId,
    organizationId: claims.organizationId,
    turnId: claims.turnId,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${TTL_SECONDS.toString()}s`)
    .sign(getSecret());

export const verifySandboxJwt = async (
  token: string,
): Promise<SandboxJwtClaims> => {
  const { payload } = await jwtVerify(token, getSecret(), {
    algorithms: ["HS256"],
  });
  return {
    conversationId: requireString(payload.conversationId, "conversationId"),
    teamId: requireString(payload.teamId, "teamId"),
    userId: requireString(payload.userId, "userId"),
    organizationId: requireString(payload.organizationId, "organizationId"),
    turnId: requireString(payload.turnId, "turnId"),
  };
};
