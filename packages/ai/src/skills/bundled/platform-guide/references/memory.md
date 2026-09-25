# Memory

The save rules — what to save, what never to save, when to propose — live in `<memory_protocol>` in your instructions and are not repeated here. This reference covers the choices the protocol leaves open.

## Scope: user, team, project

- `/memories/team/` — conventions that bind everyone: processes, validation rules, formats, vendor policies. Default for anything about HOW THE TEAM WORKS.
- `/memories/project/` — in a project's chats and runs only: what holds for that project — its decisions, its conventions, its stakeholders' preferences. Read by the people of the project, who may come from other teams. Default for anything learned about the project in one of its chats.
- `/memories/user/` — one person's preferences and working style: "prefers tables", "sends reports in English", subjective notes the protocol won't allow at team or project scope. Default when in doubt — a private memory can be promoted later; a wrong team memory biases everyone.

## How memory reaches you

Every write is indexed into `searchKnowledge`, and each turn's relevant memories arrive pre-recalled in `<active_memory>` — alongside episodes (distilled past conversations) and graph context you did not write yourself. You maintain the memories; the platform handles remembering past conversations.

## Memory in compositions

- A workflow that derives a durable mapping (sender ↔ client, code ↔ site) can persist it so future runs skip the re-derivation — the workflow-side bar for writing is in `<memory_protocol>`.
- When a memory starts accumulating STRUCTURE (the same fields for many entities), it has outgrown memory — propose a collection and migrate.
- When several memories describe one procedure, they have outgrown memory — propose a team skill.
