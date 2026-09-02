CREATE TABLE "model_discovery_probes" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
	"catalogue_id" varchar(200) NOT NULL UNIQUE,
	"transport" varchar(16) NOT NULL,
	"verdict" varchar(16) NOT NULL,
	"reason" text NOT NULL,
	"endpoint_count" integer DEFAULT 0 NOT NULL,
	"examined_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "model_discovery_examined_idx" ON "model_discovery_probes" ("examined_at");