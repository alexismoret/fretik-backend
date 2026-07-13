CREATE TABLE "mapbox_geocode_cache" (
	"query_key" varchar(512) PRIMARY KEY,
	"mapbox_id" varchar(255),
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
