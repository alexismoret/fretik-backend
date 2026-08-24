---
name: doc-coauthoring
description: Co-author a substantial document with the user — proposal, spec, decision doc, report, internal note — through context gathering, section-by-section drafting, and a blind reader test before anyone else sees it. Use when the user asks to write, draft or write up something other people will read.
---

# Co-authoring a document

A long document fails for one reason: the author knows things the reader does not, and cannot see which ones. This workflow closes that gap in three stages — **gather the context**, **build section by section**, **test it on a reader who has none of it**.

Use it when the document is substantial and other people will read it. A short answer, a note for the user alone, a recap of what is already in this conversation: just write it. Offer the workflow, name the three stages in a sentence each, and say they can work freeform instead. If they decline, work freeform.

## Where the document lives

The deliverable is a **Drive document**, not a scratch file — the team can find it, search it, and reopen it in any conversation.

| Step                  | How                                                                                           |
| --------------------- | --------------------------------------------------------------------------------------------- |
| Create the scaffold   | `manageDocument { action: "create", title, content }`                                         |
| Every edit after that | `get` for the live text and its `revision`, then `update` with `edits` and that same revision |
| Show progress         | Nothing to paste — the document card is already in the conversation                           |

- **Never reprint the document after an edit.** Say what changed, in one line.
- **Every save is a version.** Revise the document; never draft `spec-v2.md`. `history` says what changed and `restore` puts a version back, so nothing is lost by editing in place.
- **A Word file, a PDF or a deck is a final format, not a drafting one.** Do everything below in the Drive document, and only at the end build the file with the `docx` / `pdf` / `pptx` skills under `outputs/` and save it with `uploadToDrive`.

## Stage 1 — Context

**Goal:** close the gap between what the user knows and what you know, so you can guide instead of transcribe.

### Look before you ask

Asking the user for something the workspace already holds wastes the one resource this stage runs on: their patience. Exhaust these first, and tell them what you found rather than what you looked for.

| Source                                                   | How                                                        |
| -------------------------------------------------------- | ---------------------------------------------------------- |
| Documents the team already wrote on the subject          | `searchKnowledge`, then `listDocuments` for the neighbours |
| Data the document will have to state — figures, entities | `<team_objects>`, `listObjects`, `getObject`, `querySql`   |
| Conventions and preferences already learned              | `<active_memory>` and `<chatbot_context>`                  |
| A system outside Fretik (mailbox, CRM, project tool)     | The team's external app connections                        |

### Then ask the user

Five questions, and say they can answer in shorthand or dump it however suits them:

1. What type of document is this?
2. Who reads it?
3. What should happen once they have read it?
4. Is there a template or a format to follow?
5. Anything else you should know — constraints, history, politics?

**If they name a template**: it is usually already a Drive document — find it and read it rather than asking them to describe it. Otherwise ask them to attach it.

**If they are revising an existing document**: `get` it and work from the live text; the version history means you can edit it directly without fear.

**If it contains images with no alt text**: say that a figure without alt text is invisible to search and to anyone reading the document through you, and offer to write the alt text.

### Info dump

Once the five are answered, ask them to dump everything they have — background, why the alternatives were dropped, team dynamics, timelines, dependencies, stakeholder concerns. Tell them not to organise it. Offer the shapes that suit them: stream of consciousness, a document to read, records to look at, a connected app to search. Ask before searching anything on their behalf.

Then ask 5-10 numbered clarifying questions built from the gaps you actually have. Tell them shorthand answers are fine ("1: yes, 2: see the March contract, 3: no, backwards compat").

**Exit condition:** you can ask about edge cases and trade-offs without needing the basics explained. Ask whether they have more to add, or if it is time to draft.

## Stage 2 — Build

**Goal:** one section at a time, each one brainstormed and curated before it is written.

**Order the sections by unknowns, not by their order in the document.** The core proposal or the technical approach first; summaries and introductions last, when there is something to summarise. If the structure is unclear, propose 3-5 sections for this type of document and let them adjust.

Then `create` the document with every heading in place and an explicit placeholder under each — `[to be written]`. That scaffold is what you both work against.

For each section:

1. **Clarify.** 5-10 questions specific to this section.
2. **Brainstorm.** 5-20 numbered candidates for what it could contain — including things they mentioned in passing and angles nobody has raised. Offer more if they want.
3. **Curate.** Ask what to keep, cut or merge, with brief reasons ("keep 1, 4, 9 · cut 3, duplicates 1 · merge 11 and 12"). The reasons are what teach you their priorities for the next sections. If they answer freeform instead, extract the intent and move on.
4. **Gap check.** Ask what is missing from what they picked.
5. **Draft.** Replace that section's placeholder with `update` + `edits`.
6. **Refine.** Iterate on their feedback, one `edits` call per round.

**Say this once, when you draft the first section:** ask them to tell you what to change rather than editing the document themselves — you learn their style for the sections still to come. If they edit it anyway, `get` it, note what they changed, and apply that taste from then on.

**After three rounds with no substantial change**, ask what could be cut without losing anything. That question ends more sections than any other.

**At around 80% drafted**, read the whole document and report on flow between sections, contradictions, repetition, generic filler, and whether every sentence is carrying weight.

## Stage 3 — Reader test

**Goal:** find what only makes sense to the two of you.

You can run this yourself — never send the user to another conversation for it.

1. **Predict what readers will ask.** 5-10 questions someone would genuinely bring to this document.
2. **Send each to a fresh reader.** `dispatchAgent`, one per question, each told: read this document with `manageDocument { action: "get", documentId }`; you have no context from any conversation; answer the question from the document alone, then say what was ambiguous and what knowledge it assumed you already had.
3. **Run one adversarial pass**: internal contradictions, unsupported claims, terms used before they are defined, figures with no source.
4. **Report and fix.** Say what the readers got wrong, fix those sections, and re-test the ones you changed.

**Before any of this, check your own scaffold for surviving placeholders.** A `[to be written]` reaching a reader is the most common way this workflow fails.

**Exit condition:** readers answer correctly and surface nothing new.

## Handing it over

- Tell them to do a final read themselves, and to verify facts, links and figures. They own this document.
- File it where the team will look for it (`manageDrive`) — the Drive root is where documents go to be lost.
- Then, at most one suggestion, once: a format they will rebuild every month is a team skill (`createSkill`); a durable convention this document taught you is a memory; a document that mostly restates numbers that keep moving wants to be a page (`managePage`) instead.

## Traps

- **Do not run this workflow on a request that did not need it.** The offer is part of the workflow; the ceremony is not free.
- **Brainstorm lists stay in the conversation.** Nothing goes in the document until it has been curated.
- **Never draft a section whose questions are still open** — that is how a document fills up with plausible filler nobody asked for.
- **`oldString` must appear exactly once, verbatim.** Widen the anchor rather than guessing which occurrence you meant.
- **A refused `revision` means someone changed the document under you.** `get` it again and rebuild the edits from what it now says; retrying the same ones fails the same way.
