-- Phase 3 — IMMUTABLE date parser for the typed views.
--
-- Date columns on the typed views are cast from JSONB text. Postgres' native
-- text→date paths (`::date`, `to_date`) are STABLE (DateStyle / locale
-- dependent), so they cannot back an expression index — and an unindexed date
-- column defeats range/sort queries (the killer query filters by year + sorts).
--
-- This helper parses a fixed ISO `YYYY-MM-DD` shape via `make_date` (immutable),
-- catching calendar-invalid input (e.g. `2025-02-31`, reachable through lenient
-- mirror writes) → NULL instead of erroring the whole view. Marked IMMUTABLE so
-- the typed views' date columns are index-safe; the SAME expression is used in
-- the view column AND the expression index, so the planner matches them.
--
-- The agent never references this function: it is sealed inside the view
-- definition and the model only ever queries the resulting `date` column.
CREATE OR REPLACE FUNCTION fretik_text_to_date(txt text)
RETURNS date
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
BEGIN
  RETURN make_date(
    substring(txt FROM 1 FOR 4)::int,
    substring(txt FROM 6 FOR 2)::int,
    substring(txt FROM 9 FOR 2)::int
  );
EXCEPTION
  WHEN others THEN
    RETURN NULL;
END;
$$;--> statement-breakpoint

-- The least-privilege SQL-tool role executes it transitively through the
-- security_invoker views (PUBLIC already has EXECUTE on new functions; this is
-- explicit + survives a future PUBLIC revoke).
GRANT EXECUTE ON FUNCTION fretik_text_to_date(text) TO fretik_sql_tool;
