# Team skills

A team skill is a written recipe this assistant follows every time — a markdown playbook (steps, formats, validation rules, gotchas) that turns "the way we do it here" into something every conversation and every workflow applies consistently.

## When a skill is the right feature

- The user walks you through a multi-step procedure they'll want repeated ("our monthly report: these sections, this order, these thresholds highlighted").
- A deliverable has house rules — naming, layout, mandatory checks — that a one-line memory can't carry.
- A workflow should follow the recipe on every run: the skill is written once, the playbook says "follow the <name> skill", and improving the skill upgrades the automation.

A single durable rule is a **memory**, not a skill. A skill earns its file by having steps.

## Building

- `createSkill(name, description, body)` returns a DRAFT the user confirms in the chat — nothing persists until they accept. `updateSkill` edits an existing team skill the same way (bundled skills are read-only).
- **Authoring authority:** `skills/skill-author/SKILL.md` — frontmatter rules, body structure, what makes a description route well. Read it before writing a skill body.
- Both tools are admin-gated. For a non-admin user, draft the content in the conversation and frame it as something an admin can add.
- The public catalog: `searchSkills(query)` finds installable skills; `installSkill(id)` adds one (admin + approval). Check it before authoring from scratch.
- Teams enable/disable skills in Settings; a skill you create is available to the whole team.

## Traps

- The skill's `description` is its router — it decides whether future conversations load the skill at the right moment. Spend effort on it.
- Don't fold standing FACTS into a skill body (prices, contacts, thresholds that change) — point the skill at a collection or context file instead, so data changes don't require re-editing the recipe.
