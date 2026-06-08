import { count, desc, eq } from "drizzle-orm";

import db from "../../db";
import { user } from "../../db/schema";

/**
 * Super-admin management. Super-admins are platform operators (cross-org) who
 * can access the admin pages. The flag lives on `user.is_super_admin` — a
 * column decoupled from the email, so changing/never-verifying an email can
 * never grant it. This service lists, grants, and revokes it; Better Auth
 * declares the field `input: false`, so no sign-up/update payload can set it.
 * The very first super-admin is seeded out-of-band by the `grant:super-admin`
 * bootstrap script. Granting/revoking is itself restricted to super-admins
 * (enforced in the API handler).
 */

export interface SuperAdmin {
  id: string;
  name: string;
  email: string;
  image: string | null;
  createdAt: Date;
}

const superAdminColumns = {
  id: user.id,
  name: user.name,
  email: user.email,
  image: user.image,
  createdAt: user.createdAt,
};

export const listSuperAdmins = async (): Promise<SuperAdmin[]> =>
  db
    .select(superAdminColumns)
    .from(user)
    .where(eq(user.isSuperAdmin, true))
    .orderBy(desc(user.createdAt));

/**
 * Grant super-admin to an existing user by email. Returns the promoted user,
 * or `null` if no account exists for that email (the person must sign up
 * first). Idempotent.
 */
export const grantSuperAdmin = async (
  email: string,
): Promise<SuperAdmin | null> => {
  const rows = await db
    .update(user)
    .set({ isSuperAdmin: true })
    .where(eq(user.email, email.trim().toLowerCase()))
    .returning(superAdminColumns);
  return rows[0] ?? null;
};

/** Revoke super-admin from a user by id. Idempotent. */
export const revokeSuperAdmin = async (userId: string): Promise<void> => {
  await db.update(user).set({ isSuperAdmin: false }).where(eq(user.id, userId));
};

/** Count of current super-admins — used to block revoking the last one. */
export const countSuperAdmins = async (): Promise<number> => {
  const [row] = await db
    .select({ value: count() })
    .from(user)
    .where(eq(user.isSuperAdmin, true));
  return row?.value ?? 0;
};
