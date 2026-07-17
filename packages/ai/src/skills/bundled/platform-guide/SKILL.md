---
name: platform-guide
description: Decision guide for Fretik's platform features — workflows, object types, team skills, chatbot context, external apps, Drive, memory. Read before proposing or building any of them; covers when each fits, how they compose, setup steps, and traps.
metadata:
  fretik_is_default: true
  fretik_is_meta: true
---

# Platform guide

You are the user's guide to Fretik. They know their job, not this platform — when a need outgrows a one-off answer, you pick the right feature, explain it in their words, and set it up (or walk them through the part only they can do). This file carries the decision criteria; each feature has a deeper reference at `skills/platform-guide/references/<feature>.md` — read it before actually building.

## Choosing the right feature

| Need                                                                                                                                             | Feature                                                 | Wrong fit to avoid                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Work that should happen again without the user — on a schedule, on an event (new document, new record, connector event), or via a shareable form | **Workflow**                                            | A one-off task (just do it now); work needing live back-and-forth with the user |
| Data the team lists, counts, filters, or recomputes — clients, projects, invoices, candidates, machines, anything with fields                    | **Object type**                                         | Prose knowledge (→ memory or context); files (→ Drive)                          |
| A repeatable recipe with steps, formats, and gotchas — "our monthly report looks like this"                                                      | **Team skill**                                          | A durable one-line preference (→ memory); a one-off deliverable                 |
| Standing instructions or curated reference files that should shape EVERY conversation                                                            | **Chatbot context** (user adds in Settings)             | Facts the agent learned mid-conversation (→ memory)                             |
| Reading from or writing to a system outside Fretik — mailbox, calendar, CRM, project tool                                                        | **External app connection** (user connects in Settings) | Public web facts (→ web search)                                                 |
| A file the team will need again — deliverable, template, reference document                                                                      | **Drive** (`uploadToDrive`)                             | Throwaway intermediates (leave in the conversation)                             |
| A durable convention, preference, or process the agent should remember                                                                           | **Memory**                                              | Anything file-specific or one-off (never save those)                            |

Boundary cases that come up constantly:

- **Objects vs memory vs context.** Facts about _entities_ (a client's status, a machine's location) → object records. _Conventions and preferences_ ("quotes need manager approval") → memory. _Curated documents and standing instructions the team maintains by hand_ → chatbot context. If the fact has fields worth filtering on, it's an object.
- **Skill vs memory.** A memory is a rule; a skill is a procedure. "Always CC finance on quotes" → memory. "Here is how we build the quarterly review deck, slide by slide" → skill.
- **Workflow vs "just do it now".** The user asking once = do it now. The user asking again, or saying "every week" / "whenever a document arrives" / "let clients submit this" = workflow.
- **Drive vs attachment.** A conversation attachment is visible only in that conversation and to search from it. The Drive is team-wide, searchable in every conversation, and feeds document-triggered workflows. If the file has value past this conversation, offer the Drive.

## Features compose — propose systems, not pieces

The strongest proposals chain features so the result keeps working on its own:

- **Ingest → structure:** an `event: document.uploaded` workflow extracts each incoming document's data and files it into an object type — from then on any total, filter, or anomaly check is one question away.
- **Collect → track:** a `form`-triggered workflow gives outsiders (clients, field staff) a public form; each submission becomes a run that validates the answers and creates records.
- **Recipe → automation:** a team skill captures the deliverable's recipe once; a workflow reads that skill every run, so improving the skill upgrades the automation.
- **Template → deliverable:** a Drive template + the matching file skill (docx/xlsx/pptx) turns "make me the usual document" into one request.
- **Structure → schedule:** an object type holding live data + a cron workflow that reports on it (summary email every Monday, alert when a threshold is crossed).

When you propose a composition, name the end state in the user's terms ("every invoice that lands in the Drive shows up in your invoice table, and you get a Monday summary"), not the feature list.

## Who does what

You can build directly (with the user's confirmation where the tool asks for it): workflows (`manageWorkflow`), object types and fields (`manageObjectType` / `manageField` — read `skills/designing-object-types/SKILL.md` first), records, team skills (`createSkill` / `updateSkill` — drafts the user confirms), Drive uploads and folders, memories.

Only the user can do (guide them, don't attempt it): connect an external app (Settings → External apps), add or edit chatbot context (Settings → Chatbot context), toggle team skills and tool permissions (Settings), approve pending writes.

## Traps

- A workflow cannot be activated until one test run has succeeded (`run_test` first, then `activate`). Budget for that in your proposal.
- Workflows never create or modify object types, fields, skills, or other workflows. Build the schema in the conversation FIRST, then the workflow that fills it.
- `createSkill` / `installSkill` are admin-gated — for a non-admin user, frame the suggestion as something to relay to an admin instead of calling the tool and failing.
- One suggestion per reply, after the answer (see `<proactive_partnership>`); a composed system still counts as one suggestion.
- Check `<team_objects>` and existing workflows (`manageWorkflow list`) before proposing something the team already has.

## References

Read the matching reference before building — each carries setup steps, options, and feature-specific traps: `references/workflows.md`, `references/object-types.md`, `references/skills.md`, `references/chatbot-context.md`, `references/external-apps.md`, `references/drive-and-files.md`, `references/memory.md`.
