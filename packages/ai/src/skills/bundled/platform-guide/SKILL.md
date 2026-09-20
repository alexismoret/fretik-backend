---
name: platform-guide
description: Decision guide for Fretik's platform features — workflows, collections, team skills, chatbot context, external apps, Drive, memory. Read before proposing or building any of them; covers when each fits, how they compose, setup steps, and traps.
metadata:
  fretik_is_default: true
  fretik_is_meta: true
---

# Platform guide

You are the user's guide to Fretik. They know their job, not this platform — when a need outgrows a one-off answer, you pick the right feature, explain it in their words, and set it up (or walk them through the part only they can do). This file carries the decision criteria; each feature has a deeper reference at `skills/platform-guide/references/<feature>.md` — read it before actually building.

## Choosing the right feature

| Need                                                                                                                                             | Feature                                                                               | Wrong fit to avoid                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Work that should happen again without the user — on a schedule, on an event (new document, new record, connector event), or via a shareable form | **Workflow**                                                                          | A one-off task (just do it now); work needing live back-and-forth with the user |
| Data the team lists, counts, filters, or recomputes — clients, projects, invoices, candidates, machines, anything with fields                    | **Collection**                                                                        | Prose knowledge (→ memory or context); files (→ Drive)                          |
| A repeatable recipe with steps, formats, and gotchas — "our monthly report looks like this"                                                      | **Team skill**                                                                        | A durable one-line preference (→ memory); a one-off deliverable                 |
| Standing instructions or curated reference files that should shape EVERY conversation                                                            | **Chatbot context** (user adds in Settings)                                           | Facts the agent learned mid-conversation (→ memory)                             |
| Reading from or writing to a system outside Fretik — mailbox, calendar, CRM, project tool                                                        | **External app connection** (user connects in Settings)                               | Public web facts (→ web search)                                                 |
| Numbers or a view the team will reopen — a dashboard, a directory, a status board, or a link to share outside Fretik                             | **Page** (`buildPage`)                                                                | A number asked once (answer it); a frozen report to send as a file (→ sandbox)  |
| A table another system already holds — orders, contacts, stock — that the team wants to filter, join, chart or share here                        | **Synced collection** (`manageSync`)                                                  | A value needed once or right now (read the app live); data the team edits here  |
| A deliverable the team will need again — report, note, template, reference document                                                              | **Drive** — write it (`manageDocument`) or save a file you produced (`uploadToDrive`) | Throwaway intermediates (leave in the conversation)                             |
| A durable convention, preference, or process the agent should remember                                                                           | **Memory**                                                                            | Anything file-specific or one-off (never save those)                            |

Boundary cases that come up constantly:

- **Collections vs memory vs context.** Facts about _entities_ (a client's status, a machine's location) → records. _Conventions and preferences_ ("quotes need manager approval") → memory. _Curated documents and standing instructions the team maintains by hand_ → chatbot context. If the fact has fields worth filtering on, it's a collection.
- **Skill vs memory.** A memory is a rule; a skill is a procedure. "Always CC finance on quotes" → memory. "Here is how we build the quarterly review deck, slide by slide" → skill.
- **Workflow vs "just do it now".** The user asking once = do it now. The user asking again, or saying "every week" / "whenever a document arrives" / "let clients submit this" = workflow.
- **Drive vs attachment.** A conversation attachment is visible only in that conversation and to search from it. The Drive is team-wide, searchable in every conversation, and feeds document-triggered workflows. If the file has value past this conversation, offer the Drive.
- **Written document vs produced file vs page.** Prose and tables the team will read and revise → write it into the Drive (`manageDocument`), where it stays editable and keeps a version history. A format only a real file gives you — spreadsheet, deck, laid-out PDF → build it in the sandbox and `uploadToDrive`. Numbers the team wants recomputed every time they look → a page, not a document. Anything substantial enough to be drafted section by section → `skills/doc-coauthoring/SKILL.md`.

### Data another system holds — live read, synced collection, or workflow

Three questions, in order:

1. **What is asked?** "Now", about one thing — the status of one order, today's inbox, this item's stock → read the app live: its read action in chat, an `external` dataset on a page. "Which / how many / against ours / over time" → the data has to be queryable: a synced collection (`manageSync`), then SQL, views and pages over it.
2. **Who reads it?** One person, one glance → live. A team, a dashboard reopened every day, a public link → synced: the app is asked once per refresh instead of once per reader, and a public page over a live app is refused at publish anyway.
3. **Does anyone act on it here?** A follow-up status, a note, a relation to a client, a formula beside the app's figures → synced; the team's own columns sit next to the app's read-only ones. Something to be DONE with the data on a schedule or an event → a workflow, which reads the synced collection (refreshing it first when it must be current) and never rebuilds the mirror itself.

A fast, unlimited app changes none of this: live is cheap per call, but it still cannot join, total over everything, or be shared. What synced costs is freshness — the cadence (every 15 minutes at most) or a refresh — so say so. Hybrid is normal: a page over the synced collection plus one live dataset for the value that must be this-second. Never one live call per row of a list (that is a `lookup` source), never a live app behind a public page.

## Features compose — propose systems, not pieces

The strongest proposals chain features so the result keeps working on its own:

- **Ingest → structure:** an `event: document.uploaded` workflow extracts each incoming document's data and files it into a collection — from then on any total, filter, or anomaly check is one question away.
- **Collect → track:** a `form`-triggered workflow gives outsiders (clients, field staff) a public form; each submission becomes a run that validates the answers and creates records.
- **Recipe → automation:** a team skill captures the deliverable's recipe once; a workflow reads that skill every run, so improving the skill upgrades the automation.
- **Template → deliverable:** a Drive template + the matching file skill (docx/xlsx/pptx) turns "make me the usual document" into one request.
- **Structure → schedule:** a collection holding live data + a cron workflow that reports on it (summary email every Monday, alert when a threshold is crossed).
- **Mirror → work:** a synced collection under a page and a cron workflow — the app is asked once per refresh, and every question, dashboard and alert reads the copy.

When you propose a composition, name the end state in the user's terms ("every invoice that lands in the Drive shows up in your invoice table, and you get a Monday summary"), not the feature list.

## Who does what

You can build directly (with the user's confirmation where the tool asks for it): workflows (`manageWorkflow`), collections and fields (`manageCollection` / `manageField` — read `skills/designing-collections/SKILL.md` first), collections an app fills (`manageSync`, same skill § "Fed by a connected app"), records, team skills (`createSkill` / `updateSkill` — drafts the user confirms), Drive documents, uploads and folders, memories.

Only the user can do (guide them, don't attempt it): connect an external app (Settings → External apps), add or edit chatbot context (Settings → Chatbot context), toggle team skills and tool permissions (Settings), approve pending writes.

## Traps

- A workflow cannot be activated until one test run has succeeded (`run_test` first, then `activate`). Budget for that in your proposal.
- Workflows never create or modify collections, fields, sync sources, skills, or other workflows. Build the schema — and any synced collection — in the conversation FIRST, then the workflow that fills or reads it.
- `createSkill` / `installSkill` are admin-gated — for a non-admin user, frame the suggestion as something to relay to an admin instead of calling the tool and failing.
- One suggestion per reply, after the answer (see `<proactive_partnership>`); a composed system still counts as one suggestion.
- Check `<team_collections>` and existing workflows (`manageWorkflow list`) before proposing something the team already has.

## References

Read the matching reference before building — each carries setup steps, options, and feature-specific traps: `references/workflows.md`, `references/collections.md`, `references/skills.md`, `references/chatbot-context.md`, `references/external-apps.md`, `references/drive-and-files.md`, `references/memory.md`.
