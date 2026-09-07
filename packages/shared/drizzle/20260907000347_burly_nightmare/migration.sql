ALTER TABLE "model_live_state" ADD COLUMN "max_input_price_per_mtok" real;--> statement-breakpoint
ALTER TABLE "model_live_state" ADD COLUMN "max_output_price_per_mtok" real;--> statement-breakpoint
ALTER TABLE "model_live_state" ADD COLUMN "require_cache" boolean DEFAULT false NOT NULL;