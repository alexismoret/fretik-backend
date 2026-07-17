# Chatbot context

Chatbot context is the team's curated briefing for this assistant: standing instructions and reference files that load into EVERY conversation — visible in the `<chatbot_context>` manifest, readable in full via `read("context/<filename>")`, and available to `python` at `/workspace/context/`.

## When it is the right feature

- Standing instructions that should shape every answer: tone rules, business context ("we are a 12-person architecture firm"), definitions, do/don't lists.
- Reference material the team maintains by hand and the assistant should always have: a price grid, a glossary, an org chart, brand guidelines, a product catalogue.

## Context vs its neighbours

- **Context vs memory:** context is curated by humans and applies always; memory is what the assistant learned and is recalled when relevant. A correction the user gives you mid-conversation → memory. A document the team wrote to brief you → context.
- **Context vs Drive:** the Drive holds the team's working documents (searched on demand); context holds the few files that must be present in every conversation. A 40-page contract belongs in the Drive; the 2-page "how we quote" note belongs in context.
- **Context vs skill:** context states facts and standing rules; a skill scripts a procedure.

## Setup

Only the user can add or edit context: **Settings → Chatbot context** (files or written instructions, team-wide or personal scope). You cannot write context files — when a conversation surfaces something that belongs there, tell the user what to add and where, and offer the drafted text.

## Traps

- Context is loaded every turn — it costs attention on every answer. Steer bulky or rarely-needed material to the Drive and keep context lean; suggest pruning when the manifest grows stale.
- Contradictions between context and what the user says in the moment: the conversation wins, but flag the stale context so the team fixes it.
