# Workflows

A workflow is this assistant running unattended: a trigger fires, the playbook's tasks execute one by one, writes pause for approval when the mode says so, and the user reads the run's summary. Built and managed entirely through `manageWorkflow` (domain tool — activate via `searchTools`).

## Build order

1. `get_trigger_catalog` — the authoritative list of triggers, their `triggerConfig` shapes, and per-event filter keys. Never guess a config shape.
2. `create_draft` — name, description, trigger, playbook, autonomy, scope. The tool's own description carries the playbook-authoring rules (goal-oriented instructions, never tool names).
3. `run_test` — a workflow CANNOT be activated until one test run has succeeded. Hand test files over via `files` (chat attachments never reach the run by themselves), then end the turn: the run executes in the background and this conversation is resumed with the outcome. Inspect with `get_run` — and when the conversation holds an example of the expected result, compare the test's deliverable against it field by field; every mismatch is a playbook defect to fix with `update` before activating. Iterate with `update`.
4. `activate` — the trigger goes live. `pause` stops it without deleting anything.

## Triggers

- **manual** — the user clicks Run. Right for "on demand but too long/repeatable for chat".
- **cron** — 5-field pattern + optional IANA timezone ("every Monday 9am" → `0 9 * * 1`).
- **event** — fires on a workspace event: `document.uploaded` (filterable by folder), `record.created` (filterable by object type), or a connector event (`connector.<app>.<kind>`). The backbone of ingest pipelines.
- **form** — Fretik hosts a shareable public form; each submission (answers + attached files) starts a run. Right for collecting structured input from people outside the conversation — clients, field staff, other departments.

## Design for the input space

A playbook is a program: each run executes against whatever the trigger delivers THAT run — not against the files shown while building. Before writing tasks, decide from the user's request how variable the input is:

- **Fixed template** — the user says every run carries the same document, same layout (a system export, their own generated form). Tailoring tasks to that exact structure is correct.
- **Stable format, varying content** — same document type each run, but the values, rows, and page counts differ. Tasks describe WHICH data to obtain (fields, records, bounds) — never positions, counts, or wording observed in one example.
- **Open input** — layout, length, even document type can differ run to run (a public form, a mailbox). Tasks state the goal and the data contract; the executor adapts per run (`extract` with a schema rather than any layout-specific parsing).

Example files in the conversation are ONE point in the input space, not its definition — unless the user says they are the fixed template. When the request leaves the variability ambiguous ("here are some invoices" — always this supplier? always this layout?), `askUserQuestion` before building: one question up front beats a workflow that breaks on its second run.

The same discipline covers the deliverable. When the output leaves a real choice open — which identifier fills a column, which of several formats, which rule when the data offers more than one candidate — settle it against the example the user gave, or `askUserQuestion` before building. A choice discovered only after the first test run has already cost the user the whole run.

## Autonomy modes

- `read_only` — analysis and deliverables only; every write is refused. Right for reports and digests.
- `approval_required` (safe default for writes) — record writes and external-app writes pause the run for a human decision; the run resumes alone afterwards, even days later.
- `autonomous` — writes execute directly, nobody reviews. Reserve for well-tested, low-blast-radius workflows.

## Options worth proposing

- **Notifications** — the run can email chosen members (plus whoever launched it) on success (with produced files attached), on failure, and when an approval is waiting. Most users want at least the failure email.
- **Scope** — `team` (default; sees team connections) or `private` (also sees the creator's personal connections — required when the playbook uses a personal mailbox).
- **toolHints** — per task, name the tools it should reach for, above all the one that carries its core operation (structured extraction → `extract`, document-scale rewrite → `transform`). Domain tools listed here pre-load, skipping a discovery step; a core tool serves as a per-task usage cue the executor sees each turn.

## Traps

- The executor cannot create or modify object types, fields, skills, or workflows mid-run. Build schema and skills in the conversation FIRST; the workflow only fills them.
- A playbook that needs data from an object type should name the type by its human label and let the run resolve it — hardcoding table names breaks on schema evolution.
- Bulk record writes inside a run go through the Python objects SDK in ONE script (one approval covers all rows).
- When a proposal replaces something the team does by hand, run the first execution as a test on real recent data and show the user the run before activating — trust comes from the visible run, not the description.
