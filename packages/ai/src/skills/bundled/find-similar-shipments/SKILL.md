---
name: find-similar-shipments
description: Find shipments in the team's history that match a reference shipment by combining semantic search across shipping documents with structured SQL filters on extracted attributes (origin, destination, carrier, mode, dates, weight, containers, incoterm). Use when the user wants to compare, benchmark, or replicate a past shipment.
---

# find-similar-shipments skill

Help the user identify past shipments that resemble a reference shipment so they can benchmark rates, spot patterns, or replicate a successful booking. Combines **semantic recall** (text content of bills of lading, contracts, quotes) with **structural filtering** (extracted fields like POL/POD, container count, gross weight, transport mode) to surface high-confidence matches the user can drill into.

## When to use this skill

Trigger on intents like:

- "Find shipments similar to this one"
- "What did we ship to Hamburg in Q1?"
- "Have we used this carrier on this route before?"
- "Is this freight rate consistent with our recent contracts?"
- "Show me past shipments with the same incoterm / container size / commodity"

Do NOT use for:

- A single explicit lookup by ID — use `searchKnowledge` or `getExtractionData` directly.
- Listing every shipment unfiltered — use `querySql` with `SELECT * FROM extractions` directly.
- Comparing rates to a public market index — use `searchWeb` for external benchmarks.

## Workflow

### Step 1 — Pin the reference shipment's attributes

The user's question always implicitly anchors on something — either an attached document, an extraction id from a previous turn, or a free-text description of a shipment. Extract the **comparison key** as a small set of (attribute, value) pairs before doing anything else.

Common comparison keys for shipping:

- **Lane** — `origin (POL / city / country)`, `destination (POD / city / country)`
- **Mode** — sea / air / road / rail / multimodal
- **Equipment** — container size & type (`20GP`, `40HC`, `45HQ`, reefer), or vehicle type
- **Carrier / forwarder**
- **Incoterm** — FOB, CIF, DAP, EXW, …
- **Commodity / HS code**
- **Weight / volume / TEU count**
- **Time window** — last quarter, last 12 months, calendar Y-1, …
- **Rate range** — when benchmarking pricing

If the user provided a document or referenced an extraction, extract these values from it via `read` (OCR sidecar) or `getExtractionData` first. If the input is free-text, ask one short clarifying question only when the lane is missing — that's the single attribute without which the search is too noisy. For everything else, run with what you have and surface the assumed scope in the answer.

### Step 2 — Semantic recall via RAG

Build a focused RAG query that names the lane and any other strong constraints. Examples:

- `"Antwerp Hamburg LCL container shipments 2025"`
- `"Shanghai Long Beach 40HC reefer rate"`
- `"FCA Rotterdam wood pellet road haul"`

Call `searchKnowledge` with that query. Pass `sourceTypes: ['documents', 'extractions']` to cover both. If the user pre-filtered by document type or folder in earlier turns, narrow with `sourceIds` collected from `listDocuments` / `listExtractions` first — RAG can't filter by metadata directly.

Read the top 5–10 chunks and note which documents / extractions look promising.

### Step 3 — Structural filter via SQL

RAG ranks by content; the user usually also cares about hard filters (date range, container size, extracted rate value). Run a `querySql` query against the relevant table:

- For shipments captured as documents: `documents` joined with `document_properties` for `transport_mode`, `document_date`, `document_summary`.
- For shipments captured as structured extractions: `extractions` joined with the relevant `extraction_configs` to project the right JSON fields.

Always `WHERE table.team_id = '__TEAM_ID__'`. Never select large text columns (`extracted_data`, `markdown`) unless you actively need them — project specific JSONB paths via `->> 'field'`.

Example (adapt the path to the live schema per the system prompt's `<extraction_workflow>` and `<database_schema>` sections):

    SELECT ex.id, ex.name, ex.created_at,
           elem->>'pol' AS pol,
           elem->>'pod' AS pod,
           elem->>'container_type' AS container_type,
           (elem->>'rate_usd')::numeric AS rate_usd
    FROM extractions ex
    LEFT JOIN extraction_configs ec ON ec.id = ex.extraction_config_id,
         jsonb_array_elements(ex.extracted_data::jsonb -> 'shipments') AS elem
    WHERE ex.team_id = '__TEAM_ID__'
      AND ec.name ILIKE '%shipment%'
      AND elem->>'pol' ILIKE '%antwerp%'
      AND elem->>'pod' ILIKE '%hamburg%'
      AND ex.created_at > NOW() - INTERVAL '12 months'
    ORDER BY ex.created_at DESC
    LIMIT 30

### Step 4 — Merge, rank, deduplicate

Cross-reference the SQL hits with the RAG chunks: documents/extractions that show up in BOTH lists are high-confidence matches; SQL-only or RAG-only hits are weaker but still worth surfacing.

Pick the top 5 most relevant. Always prefer recency on ties — the user is typically benchmarking against fresh data, not a 3-year-old quote.

### Step 5 — Present

Reply with a short prose lead-in (one sentence stating which interpretation you used — origin, destination, time window) followed by a markdown table with one row per match:

| Date       | Document / Extraction                     | Lane              | Mode / Equipment | Notable detail |
| ---------- | ----------------------------------------- | ----------------- | ---------------- | -------------- |
| 2026-02-14 | [Booking BL-2026-AKP](/extraction/EXT_ID) | Antwerp → Hamburg | Sea, 1× 40HC     | Rate USD 1,450 |
| …          | …                                         | …                 | …                | …              |

Citations are mandatory per the system prompt's `<citations>` section — every row links to the document or extraction id you actually surfaced.

If the user asked for a visual comparison (rate distribution, lane share, monthly volume), close with a Mermaid `pie` or `flowchart`, OR call the `data-viz` skill for richer charts.

If you want the user to start a new extraction over the matches (e.g. to run a structured comparison config), end with a `[Compare these shipments](/extraction/new?documentIds=ID1,ID2,ID3&extractionConfigTemplateId=TPL_ID)` link.

## Failure modes

- **No matches.** Tell the user plainly, name the filters that produced zero, and suggest one relaxation (broaden the time window, drop the equipment filter, …). Do NOT pad with unrelated shipments.
- **Too many matches.** If SQL returns >30 rows, narrow ONE filter (typically the time window) and rerun. Don't paginate through every row — five well-chosen matches beat a dump of 50.
- **Comparison key missing the lane.** Single clarifying question: "Which origin / destination should I anchor the search on?" Once answered, pick up at Step 2.
