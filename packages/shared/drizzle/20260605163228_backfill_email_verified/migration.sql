-- Custom SQL migration file, put your code below! --

-- Backfill: grandfather every account that already existed before email
-- verification was enforced. Until now no email was ever verified (no
-- verification flow was wired), so every existing unverified user is a
-- legitimate pre-beta account. Without this, enabling
-- `emailAndPassword.requireEmailVerification` would lock them out on their
-- next sign-in. Sign-ups created AFTER this migration go through the normal
-- OTP verification (self-serve) or invitation auto-verify flow.
UPDATE "user" SET "email_verified" = true WHERE "email_verified" = false;
