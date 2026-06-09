CREATE TYPE "file_extraction_status" AS ENUM('extracting', 'ready', 'error');--> statement-breakpoint
CREATE TABLE "file_extractions" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
	"organization_id" uuid NOT NULL,
	"file_hash" varchar(64) NOT NULL,
	"mime_type" varchar(100) NOT NULL,
	"route" varchar(32) NOT NULL,
	"sidecar_s3_key" text,
	"page_count" integer,
	"char_count" integer,
	"status" "file_extraction_status" DEFAULT 'extracting'::"file_extraction_status" NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "file_extractions_org_hash_unique" UNIQUE("organization_id","file_hash")
);
--> statement-breakpoint
ALTER TABLE "ai_chat_files" ADD COLUMN "file_hash" varchar(64);--> statement-breakpoint
CREATE INDEX "file_extractions_error_idx" ON "file_extractions" ("status") WHERE "status" = 'error';--> statement-breakpoint
ALTER TABLE "file_extractions" ADD CONSTRAINT "file_extractions_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;