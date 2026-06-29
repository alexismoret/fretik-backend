---
name: designing-object-types
description: Design or modify the team's object types, fields, and select options (field types, config, icons) — AND bulk-import or migrate MANY records via the Python objects SDK. Use when the user asks to create/rename/restructure a type, add/change/remove fields, set up options, or import/restructure many records at once (e.g. paste a CSV of rows to add). A single record is manageRecord; reading is querySql.
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
- `number` — quantities, scores. Config: `min`/`max`; `numberFormat:'percent'`; `display:'bar'` or `'ring'` + `divideBy` for a progress bar/ring.
- `rating` — a 1–N star/icon score. Config: `ratingMax` (default 5), `ratingIcon` (a bare Lucide name, e.g. `star`, `heart`).
- `money` — an amount in a currency. Config: `defaultCurrencyCode` (e.g. 'EUR').
- `date` / `datetime` — a day / an instant. No config.
- `boolean` — yes-no. No config.
- `select` — exactly one of a closed list. Config: `options:[{value,label,icon?,group?}]`.
- `multi_select` — any number of that list. Same `options`.
- `member` — a team member (Better Auth user). Config: `multiple:true` for several.
- `relation` — a link to records of another type. Config: `targetTypeKey`, `cardinality:'one'` or `'many'`.
- `rollup` — a read-only aggregate over a relation. Config: `relationFieldKey`, `fn`, `targetFieldKey`.

Notes that bite:

- **percent + progress:** a completion field → `number` with `numberFormat:'percent'`, `display:'ring'` (or `'bar'`), `divideBy:100` if the source is 0–100.
- **`select` vs `multi_select`:** one value (status, priority) → `select`; many (tags, regions) → `multi_select`.
- **option `group`** (`'todo'|'in_progress'|'done'`) turns a `select` into kanban lanes — set it for status fields.
- **`relation` vs `member`:** `member` is an internal teammate; `relation` links to another object type's records. A relation is added with `manageField` `type:'relation'`; changing a field to/from relation isn't supported — recreate it. To create a record already linked, pass `manageRecord create` `relations: [{relationKey, toRecordId|toDocumentId}]` (one record) or a bulk row's `relations` (many) — no separate manageLink call.
- **`rollup`** needs an existing `relation` field on the type (`relationFieldKey`) and the aggregated field on the far side (`targetFieldKey`); `fn` is one of sum/count/avg/min/max/count_not_empty/percent_not_empty.
- The **first field** of a type is its title automatically; pass `isTitle:true` to promote another. Keys are snake_case and auto-derived from the label when omitted.
- **Field cap:** at most 30 fields per type.

## Icons — set a good one wherever one fits

A fitting icon sharpens the UI — **give the type an icon, and give every `select`/`multi_select` option an icon**. Pick the most evocative match, not the first.

- Names are curated Lucide names; the write tools reject anything else. When unsure of the exact name, call `searchIcons` — pass **all** the concepts you need in one batch (`['vendor','invoice','paid','overdue']`), then read the ranked names and choose.
- You often know the name outright (`building-2`, `truck`, `receipt`) — use it directly; only fall back to `searchIcons` when unsure or after a rejection.

## Colors — set meaningful ones

Give `select`/`multi_select` options a color that carries meaning whenever the values imply one — a status: green=done, amber=in_progress, red=blocked/overdue; a priority: red→orange→amber→green for high→low; categories: a distinct hue each. Pick from the palette: red, orange, amber, yellow, lime, green, emerald, teal, cyan, sky, blue, indigo, violet, purple, fuchsia, pink, rose, zinc. Omit `color` when no meaning applies (and on the type itself unless the user names one) — the system auto-assigns a distinct color. An invalid token is ignored and auto-assigned.

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
- `objects.schema.create_type(key, label, description, fields=[…])` / `update_type(type_key, add_fields=[…])` / `add_field` / `change_field(action="update"|"changeType"|"delete")` / `delete_type`. Type and each field need a one-line `description`.

A migration is ONE script: `create_type` the target → `query` the source → `bulk_create` into the target → `bulk_delete` the source. Keep results in variables; print only counts.

Build `rows` in code — never by hand-retyping the source's values. Whatever the input (pasted CSV/JSON, or an uploaded file: Excel, JSON, Markdown, PDF…), parse it in-script with the right library (`csv`, `json`, `openpyxl`/`pandas`, `pdfplumber`, …) and map its columns to field keys programmatically. Hand-transcribing rows silently drops or corrupts cells; parsing keeps every value exactly as given.
