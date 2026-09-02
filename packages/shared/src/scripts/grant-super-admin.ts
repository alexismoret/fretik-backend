import { assertOperatorTarget } from "../lib/operator-guard";
import { grantSuperAdmin } from "../services/auth/super-admins";

/**
 * One-off bootstrap: grant super-admin to the first platform operator, since
 * the admin UI that manages super-admins is itself gated behind the flag
 * (chicken-and-egg). The target must already have an account.
 *
 *   cd backend/packages/shared && bun run grant:super-admin <email>
 *
 * Idempotent; safe to re-run. Subsequent operators are managed from the UI.
 */
const email = process.argv[2];
if (!email) {
  console.error("Usage: bun run grant:super-admin <email>");
  process.exit(1);
}

// Granting platform-operator rights is the one script here whose whole purpose
// is production, so it says which production before it does anything.
await assertOperatorTarget(Bun.argv);

const granted = await grantSuperAdmin(email);
if (!granted) {
  console.error(
    `No account found for "${email}". Ask them to sign up first, then re-run.`,
  );
  process.exit(1);
}

console.log(`✓ ${granted.email} is now a super-admin.`);
process.exit(0);
