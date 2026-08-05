DROP INDEX "link_types_org_key_uniq";--> statement-breakpoint
CREATE UNIQUE INDEX "link_types_org_key_uniq" ON "link_types" ("organization_id","normalized_key","from_object_type_id") WHERE team_id IS NULL;--> statement-breakpoint
DROP INDEX "link_types_team_key_uniq";--> statement-breakpoint
CREATE UNIQUE INDEX "link_types_team_key_uniq" ON "link_types" ("team_id","normalized_key","from_object_type_id") WHERE team_id IS NOT NULL;