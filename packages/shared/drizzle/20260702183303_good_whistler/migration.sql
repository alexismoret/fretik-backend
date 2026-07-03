-- PostGIS backs the geospatial `location` field. Requires the extension binaries
-- on the server (a `postgis/postgis` image, not stock `postgres:16`).
CREATE EXTENSION IF NOT EXISTS postgis;--> statement-breakpoint
CREATE TABLE "locations" (
	"id" bigserial PRIMARY KEY,
	"team_id" uuid NOT NULL,
	"query_key" varchar(512) NOT NULL,
	"raw_address" text NOT NULL,
	"resolved_address" text NOT NULL,
	"geom" geometry(point,4326),
	"mapbox_id" varchar(255),
	"feature_type" text,
	"bbox" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ux_locations_team_key" ON "locations" ("team_id","query_key");--> statement-breakpoint
CREATE INDEX "ix_locations_geom" ON "locations" USING gist ("geom");--> statement-breakpoint

-- Row-level security for the SQL read role: a team sees only its own locations
-- (mirrors the per-type table policy). A cross-team shared record's location
-- (owned by another team) is intentionally NOT visible to the SQL role; the
-- record-read/map APIs use the owner connection and render it fine.
ALTER TABLE "locations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY sql_tool_read ON "locations"
  FOR SELECT TO fretik_sql_tool
  USING (team_id = fretik_team());--> statement-breakpoint
GRANT SELECT ON "locations" TO fretik_sql_tool;