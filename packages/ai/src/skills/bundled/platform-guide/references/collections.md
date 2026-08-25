# Collections

A collection is a malleable table the team shapes on demand — part database, part CRM, part flexible tracker, fully readable and writable by you and by workflows. One type = one kind of thing (clients, projects, invoices, candidates, machines, sites, …) with typed fields, relations to other types, and views the team browses (table, Kanban board).

## What makes them worth proposing

- **Ask-anything data.** Once facts live in a type, any count, sum, filter, ranking, or cross-type join is one `querySql` away — at any scale. Recomputing figures from prose or spreadsheets every time is the signal the data belongs here.
- **A CRM without buying one.** Types + relations + activity journal cover companies, contacts, deals, and their history.
- **A planner.** A type with a select/status field gets a Kanban view — projects, hiring pipelines, maintenance queues.
- **A workflow's landing table.** Workflows file what they collect (extracted document data, form submissions, connector events) into records — the composition that turns automation into a living dataset.
- **A living index.** Documents each have a mirror record (`document_record`) linkable to any other record, so a type can organize the Drive by entity.

Users almost never ask for "a collection" — they say "we keep track of X in a spreadsheet" or "can you tell me which X are late". That's your cue.

## Building

- **Modeling authority:** `skills/designing-collections/SKILL.md` — field-type choices, select options, relations, bulk import via the Python objects SDK. Read it before `manageCollection` / `manageField`.
- Check `<team_collections>` first — extending an existing type with a field beats creating a near-duplicate type.
- Schema changes are proposed via `askUserQuestion`, never built silently (see `<collections>`); records themselves are journaled and reversible.
- Records extracted by AI arrive as `suggested` until a human confirms — tell the user where to review them.
- Records can be shared across teams (sharing options on `manageRecord` / the type) when several teams work the same data.

## Traps

- Don't model prose as fields — a `notes` text field hoards what memory or the Drive should hold. Fields earn their place by being filtered or computed on.
- Don't create a type for a one-off list the user needed once; propose it when the SAME shape of data recurs.
- Renaming/retyping fields and deleting types are structural — always propose first, and prefer additive evolution.
