-- Retire the `transform` dataset kind (2026-08-21).
--
-- A transform ran JavaScript in a server-side QuickJS-WASM sandbox over the
-- results of OTHER datasets. Both things it was for have better homes on either
-- side of it: grouping and summing belong in an `aggregate` dataset, in SQL,
-- over every row — which the contract already forbade it from doing — and
-- joining, ratios and derived columns belong in the page's own `computed()`,
-- which runs in the browser the page is already rendering in. What was left was
-- a second execution environment to secure, a 9.2 MB dependency, and a
-- dependency-wave scheduler that existed for this one source.
--
-- The schema no longer accepts the kind, so a stored definition carrying one
-- would fail to parse and take its whole PAGE down with it. Each transform
-- dataset is therefore converted to an EMPTY `inline` dataset rather than
-- deleted: the id survives, so `data.<id>` still resolves and the page's code
-- still runs; the dataset comes back `{ status: 'ok', rows: [] }` and the page
-- shows the empty state it was always required to have. Its `code` and `inputs`
-- are dropped with the kind.
--
-- Rebuilding those widgets is an editorial job, not a migration's: the notice
-- below names every page that needs one, in the deploy log.
DO $$
DECLARE
  affected_pages INT;
  affected_datasets INT;
  page_names TEXT;
BEGIN
  SELECT
    count(*),
    coalesce(sum(t.n), 0),
    coalesce(string_agg(format('%s (%s)', p.name, p.id), ', '), '')
  INTO affected_pages, affected_datasets, page_names
  FROM "pages" p
  CROSS JOIN LATERAL (
    SELECT count(*) AS n
    FROM jsonb_array_elements(coalesce(p."definition" -> 'datasets', '[]'::jsonb)) d
    WHERE d ->> 'kind' = 'transform'
  ) t
  WHERE t.n > 0;

  IF affected_pages > 0 THEN
    RAISE NOTICE 'page transform retirement: % dataset(s) across % page(s) converted to empty inline. Rebuild them with an aggregate dataset or in the page code: %',
      affected_datasets, affected_pages, page_names;
  ELSE
    RAISE NOTICE 'page transform retirement: no stored page used a transform dataset.';
  END IF;
END $$;

UPDATE "pages" p
SET "definition" = jsonb_set(
  p."definition",
  '{datasets}',
  (
    SELECT coalesce(jsonb_agg(
      CASE
        WHEN d ->> 'kind' = 'transform'
          THEN (d - 'code' - 'inputs' - 'lang')
               || jsonb_build_object('kind', 'inline', 'rows', '[]'::jsonb)
        ELSE d
      END
      ORDER BY ord
    ), '[]'::jsonb)
    FROM jsonb_array_elements(p."definition" -> 'datasets') WITH ORDINALITY AS e(d, ord)
  )
)
WHERE p."definition" -> 'datasets' @> '[{"kind": "transform"}]'::jsonb;

-- Same treatment for the version history, so restoring an old version cannot
-- reintroduce a kind the schema no longer knows.
UPDATE "page_versions" v
SET "definition" = jsonb_set(
  v."definition",
  '{datasets}',
  (
    SELECT coalesce(jsonb_agg(
      CASE
        WHEN d ->> 'kind' = 'transform'
          THEN (d - 'code' - 'inputs' - 'lang')
               || jsonb_build_object('kind', 'inline', 'rows', '[]'::jsonb)
        ELSE d
      END
      ORDER BY ord
    ), '[]'::jsonb)
    FROM jsonb_array_elements(v."definition" -> 'datasets') WITH ORDINALITY AS e(d, ord)
  )
)
WHERE v."definition" -> 'datasets' @> '[{"kind": "transform"}]'::jsonb;
