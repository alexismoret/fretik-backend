ALTER TABLE "document_labels" DROP CONSTRAINT "document_labels_label_id_labels_id_fkey";--> statement-breakpoint
DROP TABLE "document_labels";--> statement-breakpoint
DROP TABLE "labels";--> statement-breakpoint
ALTER TABLE "field_definitions" DROP COLUMN "display_in_filters";