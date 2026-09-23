-- Passkeys (`@better-auth/passkey`) and the Better Auth 1.7.2 -> 1.7.5 bump
-- the plugin requires.
--
-- account.issuer: 1.7.3 stopped writing it (accounts are keyed by
-- (providerId, accountId) again, as in 1.6), so the NOT NULL added by
-- 20260830125622 would reject every sign-up. The upgrade guide's Postgres
-- path: drop the (issuer, accountId) index, relax the column. The column
-- itself stays so a 1.7.2 replica can keep writing it mid-deploy.
--
-- account_providerId_accountId_uidx: the key Better Auth now looks accounts up
-- by, made unique. Cannot fail on existing data: the only provider configured
-- is `credential`, whose accountId is the user id, one per user.

CREATE TABLE "passkey" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
	"name" text,
	"public_key" text NOT NULL,
	"user_id" uuid NOT NULL,
	"credential_id" text NOT NULL,
	"counter" integer NOT NULL,
	"device_type" text NOT NULL,
	"backed_up" boolean NOT NULL,
	"transports" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"aaguid" text,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
DROP INDEX "account_issuer_accountId_uidx";--> statement-breakpoint
ALTER TABLE "account" ALTER COLUMN "issuer" DROP NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "account_providerId_accountId_uidx" ON "account" ("provider_id","account_id");--> statement-breakpoint
CREATE INDEX "passkey_userId_idx" ON "passkey" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "passkey_credentialID_uidx" ON "passkey" ("credential_id");--> statement-breakpoint
ALTER TABLE "passkey" ADD CONSTRAINT "passkey_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;