-- Better Auth 1.7 schema.
--
-- Hand-ordered, NOT as drizzle-kit generated it: it emitted
-- `ALTER TABLE "account" ADD COLUMN "issuer" text NOT NULL` in one statement,
-- which cannot succeed on a populated table. The sequence below is the one the
-- 1.7 upgrade guide requires — nullable column, backfill, then NOT NULL, then
-- the unique index — so an existing row never has to satisfy a constraint
-- before it has been given a value.

--> account.issuer -----------------------------------------------------------
ALTER TABLE "account" ADD COLUMN "issuer" text;--> statement-breakpoint

-- Local credentials. Better Auth's createLocalAccountIssuer("credential")
-- produces exactly this literal, and its own lookup matches on
-- (providerId = 'credential', issuer, accountId = user.id).
UPDATE "account" SET "issuer" = 'local:credential' WHERE "provider_id" = 'credential';--> statement-breakpoint

-- Defensive: no social/OIDC provider is configured today, so this matches zero
-- rows. It exists so that a row from some future provider cannot make the
-- SET NOT NULL below fail during a deploy. Mirrors
-- createOAuthAccountIssuer(providerId) = `local:oauth:<providerId>`.
UPDATE "account" SET "issuer" = 'local:oauth:' || "provider_id" WHERE "issuer" IS NULL;--> statement-breakpoint

ALTER TABLE "account" ALTER COLUMN "issuer" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "account_issuer_accountId_uidx" ON "account" ("issuer","account_id");--> statement-breakpoint

--> team.member_count --------------------------------------------------------
-- Cached seat count. The DEFAULT 0 makes the ADD COLUMN safe, but leaving it
-- at 0 would tell Better Auth every existing team is empty and let it overrun
-- `teams.maximumMembersPerTeam`, so it is backfilled from the real rows.
ALTER TABLE "team" ADD COLUMN "member_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "team" SET "member_count" = (
  SELECT count(*) FROM "team_member" WHERE "team_member"."team_id" = "team"."id"
);--> statement-breakpoint

--> team_member.membership_key ----------------------------------------------
-- base64url(sha256(JSON.stringify([teamId, userId]))) with no padding, which
-- is what Better Auth's computeTeamMembershipKey emits. Verified byte-for-byte
-- against the JS implementation on every existing row before shipping this.
--
-- The column is nullable and the lookup falls back to the (team_id, user_id)
-- pair, so legacy NULLs would still work — but backfilling makes the
-- single-column uniqueness boundary real for rows that predate 1.7.
ALTER TABLE "team_member" ADD COLUMN "membership_key" text;--> statement-breakpoint
UPDATE "team_member" SET "membership_key" = translate(
  rtrim(encode(sha256(('["' || "team_id" || '","' || "user_id" || '"]')::bytea), 'base64'), '='),
  '+/', '-_'
);--> statement-breakpoint
ALTER TABLE "team_member" ADD CONSTRAINT "team_member_membership_key_key" UNIQUE("membership_key");
