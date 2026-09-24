import { base32 } from "@better-auth/utils/base32";
import { createOTP } from "@better-auth/utils/otp";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import db from "../../../src/db";
import {
  authAuditLog,
  invitation,
  member,
  passkey,
  user,
} from "../../../src/db/schema";
import { redis } from "../../../src/lib/redis";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";
import { mockModule } from "../../lib/mock-module";

/**
 * `lib/auth-account-security.ts` — "confirm it's you", the security settings'
 * passkey list, and the audit + email trail of passkey changes.
 *
 * Everything goes through `auth.api.*`, the dispatch the HTTP router uses, so
 * the hooks run exactly as they do in production: a wrong `ctx.path` in a
 * matcher, or a `before` hook whose return Better Auth reads as a response,
 * would fail here and nowhere else. Real sessions (in Redis, the secondary
 * storage), real rows; the only double is the email transport.
 */

const sent: { to: string; subject: string }[] = [];

await mockModule("../../src/lib/email", {
  sendEmail: (options: { to: { email: string }; subject: string }) => {
    sent.push({ to: options.to.email, subject: options.subject });
    return Promise.resolve();
  },
});

const { auth } = await import("../../../src/lib/auth");
const { SIGNUP_INVITATION_HEADER } =
  await import("../../../src/services/auth/signup-gate");

/**
 * The security notices sent so far. Sign-up also mails a verification code,
 * fire-and-forget, so it can land in the middle of any test: not our subject.
 */
const notices = () => sent.filter((mail) => mail.subject.includes("passkey"));

/** The notice is fire-and-forget and renders MJML first: poll for it. */
const settledNotices = async (expected: number) => {
  const deadline = Date.now() + 5_000;
  while (notices().length < expected && Date.now() < deadline) {
    await Bun.sleep(25);
  }
  return notices();
};

const PASSWORD = "integration-password-1";

interface Account {
  userId: string;
  email: string;
  headers: Headers;
}

/** The `name=value` pairs a response's `set-cookie` lines carry. */
const cookiesOf = (headers: Headers): Map<string, string> => {
  const jar = new Map<string, string>();
  for (const line of headers.getSetCookie()) {
    const pair = line.split(";")[0] ?? "";
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  return jar;
};

/** Apply a response's cookies to the `cookie` header the next call sends. */
const withCookies = (request: Headers, response: Headers): Headers => {
  const jar = new Map<string, string>();
  for (const pair of (request.get("cookie") ?? "").split("; ")) {
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  for (const [name, value] of cookiesOf(response)) {
    if (value === "") jar.delete(name);
    else jar.set(name, value);
  }
  return new Headers({
    cookie: [...jar].map(([name, value]) => `${name}=${value}`).join("; "),
  });
};

/**
 * An account with a password and an active organization. Sign-up is gated
 * (closed beta), so a pending invitation opens the gate and, presented by its
 * id as the invitation link does, auto-verifies the account; it is then
 * cancelled. The product's own mechanism, as in
 * `invitations/auth-endpoints.test.ts`.
 */
const createAccount = async (workspace: WorkspaceFixture): Promise<Account> => {
  const email = `it-sec-${randomUUID().slice(0, 8)}@example.test`;
  const [bootstrap] = await db
    .insert(invitation)
    .values({
      organizationId: workspace.organizationId,
      email,
      role: "member",
      status: "pending",
      expiresAt: new Date(Date.now() + 60_000),
      inviterId: workspace.userIds[0],
    })
    .returning({ id: invitation.id });
  if (!bootstrap) throw new Error("fixture: failed to seed the signup gate");

  const signUp = await auth.api.signUpEmail({
    body: { name: "Security user", email, password: PASSWORD },
    headers: new Headers({ [SIGNUP_INVITATION_HEADER]: bootstrap.id }),
  });
  await db
    .update(invitation)
    .set({ status: "canceled" })
    .where(eq(invitation.id, bootstrap.id));
  await db.insert(member).values({
    organizationId: workspace.organizationId,
    userId: signUp.user.id,
    role: "member",
    createdAt: new Date(),
  });

  const signIn = await auth.api.signInEmail({
    body: { email, password: PASSWORD },
    returnHeaders: true,
  });
  const headers = withCookies(new Headers(), signIn.headers);
  await auth.api.setActiveOrganization({
    body: { organizationId: workspace.organizationId },
    headers,
  });
  return { userId: signUp.user.id, email, headers };
};

/** The `code` an endpoint refused with, or null if it succeeded. */
const refusalOf = async (call: Promise<unknown>): Promise<string | null> =>
  call.then(
    () => null,
    (error: unknown) =>
      (error as { body?: { code?: string } }).body?.code ?? String(error),
  );

/** Age the session in Redis so `freshSessionMiddleware` rejects it. */
const ageSession = async (headers: Headers): Promise<void> => {
  const current = await auth.api.getSession({ headers });
  if (!current) throw new Error("no session to age");
  // `redisStorage` namespaces every key it writes.
  const key = `better-auth:${current.session.token}`;
  const raw = await redis.get(key);
  if (!raw) throw new Error("session not in secondary storage");
  const stored = JSON.parse(raw) as { session: { createdAt: string } };
  stored.session.createdAt = new Date(
    Date.now() - 2 * 60 * 60 * 1000,
  ).toISOString();
  const ttl = await redis.ttl(key);
  await redis.set(key, JSON.stringify(stored), "EX", Math.max(ttl, 60));
};

const insertPasskey = async (
  userId: string,
  values: Partial<typeof passkey.$inferInsert> = {},
) => {
  const [row] = await db
    .insert(passkey)
    .values({
      userId,
      publicKey: "cHVibGljLWtleQ",
      credentialID: `cred-${randomUUID()}`,
      counter: 0,
      deviceType: "multiDevice",
      backedUp: true,
      transports: "hybrid,internal",
      ...values,
    })
    .returning();
  if (!row) throw new Error("fixture: failed to insert passkey");
  return row;
};

const auditEvents = async (userId: string, event: string) =>
  db
    .select({ metadata: authAuditLog.metadata })
    .from(authAuditLog)
    .where(and(eq(authAuditLog.userId, userId), eq(authAuditLog.event, event)));

let fx: WorkspaceFixture;
const accountUserIds: string[] = [];

beforeAll(async () => {
  fx = await createWorkspaceFixture();
});

afterAll(async () => {
  for (const id of accountUserIds) {
    await db.delete(user).where(eq(user.id, id));
  }
  await fx.cleanup();
});

beforeEach(() => {
  sent.length = 0;
});

const newAccount = async (): Promise<Account> => {
  const account = await createAccount(fx);
  accountUserIds.push(account.userId);
  return account;
};

describe("POST /security/reauthenticate", () => {
  test("a wrong password is refused and the session is left alone", async () => {
    const account = await newAccount();
    const before = await auth.api.getSession({ headers: account.headers });

    expect(
      await refusalOf(
        auth.api.reauthenticate({
          body: { password: "not-the-password" },
          headers: account.headers,
        }),
      ),
    ).toBe("INVALID_PASSWORD");

    const after = await auth.api.getSession({ headers: account.headers });
    expect(after?.session.token).toBe(before?.session.token);
    expect(
      await auditEvents(account.userId, "auth.reauthenticate_failed"),
    ).toHaveLength(1);
  });

  test("rotates the session: fresh, same workspace, old token revoked", async () => {
    const account = await newAccount();
    await ageSession(account.headers);
    const stale = await auth.api.getSession({ headers: account.headers });
    expect(
      await refusalOf(
        auth.api.generatePasskeyRegistrationOptions({
          headers: account.headers,
        }),
      ),
    ).toBe("SESSION_NOT_FRESH");

    const res = await auth.api.reauthenticate({
      body: { password: PASSWORD },
      headers: account.headers,
      returnHeaders: true,
    });
    expect(res.response).toEqual({ status: true });
    const headers = withCookies(account.headers, res.headers);

    const rotated = await auth.api.getSession({ headers });
    expect(rotated?.session.token).not.toBe(stale?.session.token);
    expect(rotated?.session.activeOrganizationId).toBe(fx.organizationId);
    expect(new Date(rotated?.session.createdAt ?? 0).getTime()).toBeGreaterThan(
      Date.now() - 60_000,
    );

    // The previous cookie no longer opens anything.
    expect(await auth.api.getSession({ headers: account.headers })).toBeNull();

    // And the rotated session is fresh enough for a passkey ceremony.
    const options = await auth.api.generatePasskeyRegistrationOptions({
      headers,
    });
    expect(options.authenticatorSelection?.residentKey).toBe("required");
    expect(options.authenticatorSelection?.userVerification).toBe("required");
    expect(options.rp.name).toBe("Fretik");
  });

  test("with two-factor on, the TOTP code is required and checked", async () => {
    const account = await newAccount();
    const enable = await auth.api.enableTwoFactor({
      body: { password: PASSWORD, method: "totp" },
      headers: account.headers,
    });
    if (enable.method !== "totp") throw new Error("expected a TOTP enrolment");
    // The URI carries the secret base32-encoded; `createOTP` takes it raw.
    const secret = new TextDecoder().decode(
      base32.decode(new URL(enable.totpURI).searchParams.get("secret") ?? ""),
    );
    const otp = createOTP(secret, { period: 30, digits: 6 });
    const verified = await auth.api.verifyTOTP({
      body: { code: await otp.totp() },
      headers: account.headers,
      returnHeaders: true,
    });
    const headers = withCookies(account.headers, verified.headers);

    expect(
      await refusalOf(
        auth.api.reauthenticate({ body: { password: PASSWORD }, headers }),
      ),
    ).toBe("TWO_FACTOR_CODE_REQUIRED");

    const code = await otp.totp();
    const wrong = code === "000000" ? "111111" : "000000";
    expect(
      await refusalOf(
        auth.api.reauthenticate({
          body: { password: PASSWORD, code: wrong },
          headers,
        }),
      ),
    ).toBe("INVALID_TWO_FACTOR_CODE");

    const ok = await auth.api.reauthenticate({
      body: { password: PASSWORD, code },
      headers,
    });
    expect(ok).toEqual({ status: true });
  });
});

describe("GET /security/passkeys", () => {
  test("lists only the caller's passkeys, with provider and last use", async () => {
    const owner = await newAccount();
    const other = await newAccount();
    const lastUsedAt = new Date(Date.now() - 3_600_000);
    const mine = await insertPasskey(owner.userId, {
      name: null,
      aaguid: "ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4",
      lastUsedAt,
    });
    await insertPasskey(other.userId, { name: "Someone else's" });

    const list = await auth.api.listSecurityPasskeys({
      headers: owner.headers,
    });

    expect(list).toHaveLength(1);
    const [item] = list;
    expect(item?.id).toBe(mine.id);
    expect(item?.provider).toBe("Google Password Manager");
    expect(item?.credentialId).toBe(mine.credentialID);
    expect(item?.transports).toEqual(["hybrid", "internal"]);
    expect(new Date(item?.lastUsedAt ?? 0).getTime()).toBe(
      lastUsedAt.getTime(),
    );
    expect(item).not.toHaveProperty("publicKey");
  });
});

describe("passkey change side effects", () => {
  test("deleting a passkey is audited with its name and emailed", async () => {
    const account = await newAccount();
    const row = await insertPasskey(account.userId, { name: "Work laptop" });

    await auth.api.deletePasskey({
      body: { id: row.id },
      headers: account.headers,
    });

    const events = await auditEvents(account.userId, "auth.passkey_removed");
    expect(events).toHaveLength(1);
    expect(events[0]?.metadata).toEqual({
      passkeyId: row.id,
      name: "Work laptop",
    });
    expect(await settledNotices(1)).toEqual([
      {
        to: account.email,
        subject: "A passkey was removed from your Fretik account",
      },
    ]);
  });

  test("a refused deletion (someone else's passkey) leaves no trail", async () => {
    const owner = await newAccount();
    const intruder = await newAccount();
    const row = await insertPasskey(owner.userId, { name: "Owner's key" });

    expect(
      await refusalOf(
        auth.api.deletePasskey({
          body: { id: row.id },
          headers: intruder.headers,
        }),
      ),
    ).not.toBeNull();

    expect(
      await db.query.passkey.findFirst({ where: { id: row.id } }),
    ).toBeDefined();
    expect(
      await auditEvents(intruder.userId, "auth.passkey_removed"),
    ).toHaveLength(0);
    expect(
      await auditEvents(owner.userId, "auth.passkey_removed"),
    ).toHaveLength(0);
    // The hook records the audit row and starts the send in one go, so the
    // missing audit rows above already rule the email out; this waits long
    // enough for a stray send to have landed anyway.
    await Bun.sleep(500);
    expect(notices()).toEqual([]);
  });

  test("renaming a passkey is audited", async () => {
    const account = await newAccount();
    const row = await insertPasskey(account.userId, { name: "Old name" });

    await auth.api.updatePasskey({
      body: { id: row.id, name: "New name" },
      headers: account.headers,
    });

    expect(
      await auditEvents(account.userId, "auth.passkey_renamed"),
    ).toHaveLength(1);
    const renamed = await db.query.passkey.findFirst({
      columns: { name: true },
      where: { id: row.id },
    });
    expect(renamed?.name).toBe("New name");
  });
});
