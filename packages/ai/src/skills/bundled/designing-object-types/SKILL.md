---
name: designing-object-types
description: Design or modify the team's object types, fields, and select options (field types, config, icons) — AND bulk-import or migrate MANY records via the Python objects SDK. Use when the user asks to create/rename/restructure a type, add/change/remove fields (including a computed/formula column), set up options, or import/restructure many records at once (e.g. paste a CSV of rows to add). A single record is manageRecord; reading is querySql.
---

# Designing object types

The team's structured data is a set of **object types** (Vendor, Invoice, Task…), each a typed table of **records**. A type has **fields** (typed columns); `select`/`multi_select` fields have **options**. You shape this schema through four tools — all validated and journaled:

- `manageObjectType` — create / update / delete a type.
- `manageField` — add / update / delete / changeType a field.
- `searchIcons` — find valid icon names (batch: pass every concept at once).
- `describeObjectType` — read a type's current fields, options, icon, color before editing.

Inspect before you edit: call `describeObjectType` so you change the real schema, not a guess.

Every type and every field needs a **one-line `description`** — what it is for. Required on create; you read it back as ground truth for the team's data. Write it in the **user's language**.

## Pick the right field type

Choose by the data's meaning, not its surface. Each type's config is set via `manageField`'s `config`.

- `text` — short freeform (name, ref, note). No config.
- `markdown` — long / formatted text. No config.
- `email` / `url` / `phone` — those literal values. No config.
- `location` — a geocoded place (address, city, POI…). No config. Write a plain address string; coordinates + place type are resolved server-side.
- `unique_id` — an auto-assigned sequential reference like "TASK-42". Config: `prefix`. Read-only — never write it.
- `created_time` / `last_edited_time` / `created_by` / `last_edited_by` — read-only system properties projected from the record's own metadata. No config. Add one only to SHOW/sort/filter it as a column; never write it.
- `number` — quantities, scores. Config: `min`/`max`; `numberFormat:'plain'|'commas'|'percent'`; `precision` (decimals); `suffix` (unit, e.g. "kg", "cm", "m3"); `display:'bar'` or `'ring'` for a progress bar/ring.
- `rating` — a 1–N star/icon score. Config: `ratingMax` (default 5), `ratingIcon` (a bare Lucide name, e.g. `star`, `heart`).
- `money` — an amount in a currency. Config: `defaultCurrencyCode` (e.g. 'EUR').
- `date` — a calendar day, or an instant with `config.hasTime:true` (off by default).
- `boolean` — yes-no. No config.
- `select` — exactly one of a closed list. Config: `options:[{value,label,icon?,group?}]`.
- `multi_select` — any number of that list. Same `options`.
- `member` — a team member (Better Auth user). Config: `multiple:true` for several.
- `relation` — a link to records of another type. Config: `targetTypeKey`, `cardinality:'one'` or `'many'`.
- `rollup` — a read-only aggregate over a relation. Config: `relationFieldKey`, `fn`, `targetFieldKey`.
- `formula` — a read-only value the DATABASE computes from the record's own fields. Config: `expression`; the result type is inferred. It is a real column, so `querySql` reads it like any other.

**Stored, computed, or neither** — four cases, decided once per field:

1. Someone types, imports or corrects the value → a **stored** field (`text`, `number`, `money`, …).
2. It derives from other fields ON THE SAME RECORD → **`formula`**. It never drifts from its inputs, and it costs one computation instead of one per reader.
3. It aggregates LINKED records → **`rollup`**.
4. It is presentation for one screen (a display label, a merge of two datasets, chart buckets) → keep it out of the schema; the page computes it in JS.

Case 2 vs 4 turns on ONE question: will anyone sort, filter, aggregate or query on it? Sorting a table by margin only works if the server knows margin.

**Formula language** — compiled to SQL, so raw SQL is refused. Field keys as bare identifiers · `+ - * / %` · `= <> < <= > >=` · `and or not` · numbers, `"text"`, `true`, `false`, `null` · `round abs ceil floor least greatest coalesce nullif length lower upper trim concat text if days_between`. A formula may read another formula: `revenue - cost`, then `round(margin / revenue * 100, 1)`. Also `if(status = "won", amount, 0)`, `days_between(delivered_at, ordered_at)`. `least`/`greatest` compare values on ONE row; averaging or summing ACROSS records is `rollup`.

It reads the STORED fields of its own row — `relation`, `rollup`, `multi_select`, `member`, `location` and the system properties are refused by name. Dividing by zero gives an empty cell, never an error. Deleting or renaming a field a formula reads is refused until that formula is updated.

Notes that bite:

- **progress:** a completion field → `number` with `display:'bar'` (or `'ring'`) and `min:0`/`max:100`; the bar fills by the value's position in that range.
- **`select` vs `multi_select`:** one value (status, priority) → `select`; many (tags, regions) → `multi_select`.
- **option `group`** (`'todo'|'in_progress'|'done'`) turns a `select` into kanban lanes — set it for status fields.
- **`relation` vs `member`:** `member` is an internal teammate; `relation` links to another object type's records. A relation is added with `manageField` `type:'relation'`; changing a field to/from relation isn't supported — recreate it. To create a record already linked, pass `manageRecord create` `relations: [{relationKey, toRecordId|toDocumentId}]` (one record) or a bulk row's `relations` (many) — no separate manageLink call.
- **`rollup`** needs an existing `relation` field on the type (`relationFieldKey`) and the aggregated field on the far side (`targetFieldKey`); `fn` is one of sum/count/avg/min/max/count_not_empty/percent_not_empty/percent_checked. `percent_checked` is task progress: % of linked records whose `boolean` target is true (subtasks + a "done" checkbox).
- The **first field** of a type is its title automatically; pass `isTitle:true` to promote another. Keys are snake_case and auto-derived from the label when omitted.
- **Creation / last-edit metadata is automatic:** every record already tracks these — read `created_at` / `updated_at` (and author) directly in `querySql`. Never add a `date` field for them; to SHOW/sort/filter one in a view, add the read-only `created_time` / `last_edited_time` / `created_by` / `last_edited_by` field. Add a `date` field only for a domain date the table doesn't track (due date, signed on, …).
- **Field cap:** at most 30 fields per type.

## Icons — set a good one wherever one fits

A fitting icon sharpens the UI — **give the type an icon, and give every `select`/`multi_select` option an icon**. Pick the most evocative match, not the first.

- Names are curated Lucide names; the write tools reject anything else. When unsure of the exact name, call `searchIcons` — pass **all** the concepts you need in one batch (`['vendor','invoice','paid','overdue']`), then read the ranked names and choose.
- You often know the name outright (`building-2`, `truck`, `receipt`) — use it directly; only fall back to `searchIcons` when unsure or after a rejection.

## Colors — set meaningful ones

Give `select`/`multi_select` options a color that carries meaning whenever the values imply one — a status: green=done, amber=in_progress, red=blocked/overdue; a priority: red→orange→amber→green for high→low; categories: a distinct hue each. Pick from the palette: red, orange, amber, yellow, lime, green, emerald, teal, cyan, sky, blue, indigo, violet, purple, fuchsia, pink, rose, zinc. Omit `color` when no meaning applies (and on the type itself unless the user names one) — the system auto-assigns a distinct color. An invalid token is ignored and auto-assigned.

## Sharing — decide who can access it

Types and records are **private to the team by default** — part of designing a type is deciding whether another team should see it. Set it with the `sharing` argument on the same tools (its exact shape is in each tool's description):

- `manageObjectType` takes an audience: private, specific teams, or the whole organization, each `read` or `write`.
- Records **inherit their type's audience live** — a record left alone follows the table; only override (`manageRecord`'s `sharing`) when it must differ, and only within the teams that already have the type (a record's audience is a subset of its type's).
- **Owner-only, and never silently:** only the owning team may share; **propose first** with `askUserQuestion` before widening beyond the team — especially `write` or whole-org.

## Workflow

```
1. describeObjectType (if editing an existing type)
2. searchIcons once — batch the type + every option concept you'll need
3. manageObjectType create → key + label + description + icon + the WHOLE fields[] in one call
   - every field carries a one-line description
   - select/multi_select fields: options with label + icon + a meaningful color (+ group for status)
   - number percent/progress, money, rating: set config per the table
4. manageField add … only for relation/rollup fields (excluded from the create batch)
5. Confirm back to the user in plain language (humanize keys)
```

Create the type and all its scalar fields in **one** `manageObjectType create` with `fields[]` — don't fire a `manageField` per field. Use `manageField` for relation/rollup additions and later incremental edits.

## Bulk & migrations — the Python `objects` SDK

For MANY records or restructuring a type (merge/move/split, data-preserving retype, big filtered update), write ONE python script with `from fretik_apps import objects`. It runs server-side — same validation, grants and journal as the tools — and the bulk rows never re-enter your context. The interactive tools above are for single edits; this is the batch path.

- `objects.records.bulk_create(type_key, rows)` — `rows` = list of field maps. To link a new record in the same write, give a row as `{"data": {…}, "relations": [{"relation_key": "client", "to_record_id": "…"}]}` (target by `to_record_id`, or an uploaded file's `to_document_id`). Returns `{ids, okCount, errors, relationErrors}`; `ids[i]` aligns with `rows[i]`.
- `objects.records.bulk_update(updates)` / `objects.records.bulk_delete(record_ids)` — `updates` = `[{"id","data"}]`; patches the given keys (pass `merge=False` to replace the whole record, clearing omitted keys).
- `objects.records.query(type_key, filters=…)` — read a batch to transform then write back.
- `objects.schema.create_type(key, label, description, fields=[…])` / `update_type(type_key, add_fields=[…])` / `add_field` / `change_field(action="update"|"changeType"|"delete")` / `delete_type`. Type and each field need a one-line `description`. `create_type` / `update_type` also take `sharing` to set the type's audience (see the Sharing section).

A migration is ONE script: `create_type` the target → `query` the source → `bulk_create` into the target → `bulk_delete` the source. Keep results in variables; print only counts.

Build `rows` in code — never by hand-retyping the source's values. Tabular and text sources (pasted CSV/JSON, Excel, JSON, Markdown) parse in-script with the right library (`csv`, `json`, `openpyxl`/`pandas`, …); a PDF or image goes through `extract` first, whose validated JSON you then map to field keys. Hand-transcribing rows silently drops or corrupts cells, and a parser tuned to one document's layout breaks on the next one.
