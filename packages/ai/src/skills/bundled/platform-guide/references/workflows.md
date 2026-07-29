# Workflows

A workflow is this assistant running unattended: a trigger fires, the playbook's tasks execute one by one, writes pause for approval when the mode says so, and the user reads the run's summary. Built and managed entirely through `manageWorkflow` (domain tool — activate via `searchTools`).

## Build order

1. `get_trigger_catalog` — the authoritative list of triggers, their `triggerConfig` shapes, and per-event filter keys. Never guess a config shape.
2. `create_draft` — name, description, trigger, playbook, autonomy, scope. The tool's own description carries the playbook-authoring rules (goal-oriented instructions, never tool names).
3. `run_test` — a workflow CANNOT be activated until one test run has succeeded. Hand test files over via `files` (chat attachments never reach the run by themselves), then end the turn: the run executes in the background and this conversation is resumed with the outcome. `get_run` returns the per-task detail AND the run's deliverables at `runs/<runId>/<file>`: OPEN them, and when the user gave an example of the output, **diff the two in `python`** — print, per column or field, the first place they differ. Reading them side by side does not work: a missing decimal, a prefix left on a label, a column empty in one and filled in the other all survive a careful read, twice over in prod. Every difference is a playbook defect to fix with `update` before activating. A test run costs the user minutes and money — five per conversation is the hard ceiling, and two rounds without convergence means showing them the difference instead of firing a third.
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
- **Open input** — layout, length, even document type can differ run to run (a public form, a mailbox). Tasks state the goal and the data contract; the executor adapts per run (`extract` naming the fields, rather than any layout-specific parsing).

Two rules make an extraction playbook hold up, both learned from runs that failed without them:

- **The extraction task carries its field list** — names, types, and where each value sits. That is a data contract, not a tool argument (`instructions` still name no tool), and without it the executor invents a different shape every run.
- **The task that extracts is the task that opens the document.** A task whose only job is to sort, count or classify the inputs is not a task: fold it into the extraction task, which has to open the files anyway. Standing alone it reads every file whole, and that text then rides in the run's context for every later step — a 2026-07 run went from 38k to 101k input tokens per step that way, and the extraction task parsed the transcript instead of the file. If an inventory step is genuinely needed, give it the minimum: `bash: ls attachments`, the `<attached_file>` snapshot, at most one targeted read. When a run can receive several kinds of document, say that the task identifies each file and THEN extracts it with the fields that kind needs — otherwise the executor either tries every field set on every file, or builds one schema wide enough to cover them all and fills most of it with nulls.

Example files in the conversation are ONE point in the input space, not its definition — unless the user says they are the fixed template. When the request leaves the variability ambiguous ("here are some invoices" — always this supplier? always this layout?), `askUserQuestion` before building: one question up front beats a workflow that breaks on its second run.

The same discipline covers the deliverable. When the output leaves a real choice open — which identifier fills a column, which of several formats, which rule when the data offers more than one candidate — settle it against the example the user gave, or `askUserQuestion` before building. A choice discovered only after the first test run has already cost the user the whole run.

**A run always produces its deliverable.** A value it cannot establish — no counterpart in the other source, a field absent from the document — leaves that cell empty and names the affected rows in the summary. Write that into the tasks. A playbook that withholds the whole file until every value is confirmed spends the run and hands back nothing to read and nothing to correct. Only refuse to produce when the user asked for exactly that.

**A run never sees the chat where the workflow was built.** So when the conversation shows what the output must look like — an example file, an exact column list, a required format — that contract must live in `playbook.deliverable` ({ format, description }: columns in order, separator, decimal format, file naming, a couple of example rows), NOT only in a chat attachment the run can't reach. Two rules for writing it, both learned from example files that were read and still mistranscribed:

- **Copy, don't describe** — the structure line AND two data rows, as read. A described structure grows columns the file never had (a trailing separator becomes a named empty column). And the structure line alone only pins the columns: how each value is WRITTEN — decimal places, zero-padding, whether an unknown lands as an empty cell or a dash — is visible nowhere but in a real row. Two rows cost nothing and settle all of it.
- **An example OUTPUT the user produced from the example inputs is a worked answer.** Read it for its values, not only its shape: it is where the rules their instructions left unsaid are actually visible — and it is what the test run's output gets diffed against (build order, step 3).

## Autonomy modes

- `read_only` — analysis and deliverables only; every write is refused. Right for reports and digests.
- `approval_required` (safe default for writes) — record writes and external-app writes pause the run for a human decision; the run resumes alone afterwards, even days later.
- `autonomous` — writes execute directly, nobody reviews. Reserve for well-tested, low-blast-radius workflows.

## Options worth proposing

- **Notifications** — the run can email chosen members (plus whoever launched it) on success (with produced files attached), on failure, and when an approval is waiting. Most users want at least the failure email.
- **Scope** — `team` (default; sees team connections) or `private` (also sees the creator's personal connections — required when the playbook uses a personal mailbox).
- **toolHints** — per task, name the tools it should reach for, above all the one that carries its core operation (structured extraction → `extract`, document-scale rewrite → `transform`). Domain tools listed here pre-load, skipping a discovery step; a core tool serves as a per-task usage cue the executor sees each turn. Leave a task that turns on judgement — deciding which records go together, which category something falls in — with no hint at all: hinting `python` there makes the executor spend the run authoring a scorer instead of deciding.

## Traps

- The executor cannot create or modify object types, fields, skills, or workflows mid-run. Build schema and skills in the conversation FIRST; the workflow only fills them.
- A playbook that needs data from an object type should name the type by its human label and let the run resolve it — hardcoding table names breaks on schema evolution.
- Bulk record writes inside a run go through the Python objects SDK in ONE script (one approval covers all rows).
- When a proposal replaces something the team does by hand, run the first execution as a test on real recent data and show the user the run before activating — trust comes from the visible run, not the description.
