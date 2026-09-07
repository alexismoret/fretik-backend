ALTER TABLE "model_live_state" ADD COLUMN "min_max_output" integer;--> statement-breakpoint
ALTER TABLE "model_live_state" ADD COLUMN "min_context_length" integer;--> statement-breakpoint
ALTER TABLE "model_live_state" ALTER COLUMN "require_cache" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "model_live_state" ALTER COLUMN "require_cache" DROP NOT NULL;--> statement-breakpoint
-- `require_cache` changes MEANING here, not just nullability: it was a setting
-- (`false` = do not require a cache) and becomes an override of what the bound
-- roles imply (`null` = inherit, `false` = force off). Every existing row
-- carries the old `false` DEFAULT, which under the new reading would pin the
-- whole fleet to "never require a proven cache" and defeat the derivation.
-- Nobody has set this deliberately: the column was added the same day, in
-- 20260907000347_burly_nightmare, and has not been deployed. Reset it to the
-- inherit state.
UPDATE "model_live_state" SET "require_cache" = NULL WHERE "require_cache" = false;
