---
name: skill-author
description: 'Use when the user wants to save a recurring procedure as a reusable skill ("save this as a skill", "remember this for next time"), when they ask how Fretik skills work, or whenever you need to draft a SKILL.md. Read this before producing any skill so the result actually loads and triggers reliably. Covers frontmatter rules, body structure, anti-patterns to avoid, and which chatbot tools the body can reference.'
metadata:
  fretik_is_default: true
  fretik_is_meta: true
---

# Authoring Fretik Skills

A skill is a procedure the chatbot loads on demand when its description matches what the user is asking. It lives at `/workspace/skills/<slug>/SKILL.md` in the conversation sandbox. The catalogue (name + description of every enabled skill) is always in the system prompt; the body is loaded only when you read the file.

Your job here is to produce a skill that future-you, in a future conversation with no extra context, can pick up and execute correctly.

## When you use this skill

You're typically here in one of three situations:

1. **The user just finished a useful procedure with you** and said something like "save this so I don't have to explain it next time". The transcript already contains everything — your job is to distill it into a SKILL.md.
2. **The user wants a skill they haven't done yet** ("I'd like a skill that does X"). Ask the questions you need to understand the inputs, the steps, and the expected output before drafting.
3. **The user wants to improve an existing skill**. Read the current SKILL.md first, then propose a focused change rather than a rewrite.

In every case, hand the draft back to the user before anything is saved. The save itself is a user-confirmed action — never assume.

## The frontmatter (hard rules)

```yaml
---
name: my-skill-slug
description: One or two sentences. What it does. When to trigger.
---
```

**`name`**

- Lowercase letters, digits, single hyphens only.
- 1 to 64 characters.
- No leading or trailing hyphen, no double hyphens.
- Examples that work: `monthly-report`, `extract-invoices`, `crm-sync`, `client-followup`.
- Examples that don't: `My Skill` (uppercase + space), `monthly_report` (underscore), `-leading` (leading hyphen), `double--hyphen`.
- The server slugifies and deduplicates on save, so don't agonise — propose a clean one and the server handles uniqueness.

**`description`**

- At most 1024 characters, non-empty, no XML tags.
- **Third person**, never first or second. _"Generates…"_, _"Extracts…"_ — not _"I can…"_ or _"You can use…"_.
- Says both **what** the skill does and **when** to use it. Both halves matter: a vague description means the chatbot won't trigger the skill when it should.
- Include the trigger phrases your user actually says. If they always ask for the "monthly digest", put "monthly digest" in the description.

A useful pattern: lead with an action verb, then the output, then the contexts that should trigger the skill.

> Generates a monthly performance summary as a formatted PDF from the team's project data. Use when the user asks for a "monthly report", "performance recap", or "monthly digest", or when they want a shareable summary of recent activity.

## Description quality — make it trigger

The description is the _only_ thing the chatbot sees when deciding whether to load this skill. If it's weak, the skill won't fire.

A good description passes this test: another assistant, reading just the name and description (no body), can decide correctly whether to load it for a given user message.

**Sharp:** _"Reconciles a list of invoices against the team's accounts database, flags duplicates and missing entries. Use when the user uploads an invoice batch and asks to check it against records, or any variant phrasing."_

**Weak:**

- _"Helps with invoices"_ — no action, no trigger.
- _"You can use this to reconcile invoices"_ — second person.
- _"This is a skill for invoice reconciliation"_ — meta-talk.

A modest tendency the chatbot has is to _undertrigger_ skills — it'd rather answer directly than reach for a skill. If a skill is genuinely the right move in a given context, lean slightly assertive in the description (_"Use whenever the user mentions X, Y, or Z, even if they don't explicitly ask for a skill"_). Don't fake it — but don't be timid either.

## Body structure

Target under 500 lines. Most skills are well under 100. If you need much more, the skill is probably doing too many things — consider splitting it.

**Voice.** Imperative and direct ("Run X", "Check Y", "Return Z"). Terse. No throat-clearing, no apologies, no caveats that don't change behaviour.

**A reliable shape:**

```markdown
## When to use

One or two lines that expand on the description. Mostly for the future assistant reading the body — clarifies the intent.

## Inputs

What the user has to provide vs. what the assistant can pick up from context. If something is always needed, name it. If it's optional, say what the default is.

## Steps

1. Numbered steps in order.
2. Name the tool used at each step (`python`, `sql_query`, `read`, etc.) — don't make the future assistant guess.
3. When a step produces an artifact, name where it lands (`outputs/<filename>`).

## Output

What the user receives. A file? A chat reply? A table? If it's a file, end with `present_files` so the user actually sees it.

## Edge cases (optional)

Failures the original conversation handled. Two or three lines each. Skip if there weren't any.
```

Not every skill needs every section. A 30-line skill that does one thing well beats a 300-line skill that hedges through every imaginable variation.

## Chatbot tools your body can reference

Mention tools by their actual names — these match what the chatbot sees. Don't list every tool just to flex; only mention the ones the procedure actually uses.

| Tool                                                                                             | When to mention it                                                                                                       |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `python`                                                                                         | Data wrangling, file conversion, custom logic. The kernel is stateful across calls in the same conversation.             |
| `bash`                                                                                           | Shell commands, CLI tools, moving files around.                                                                          |
| `sql_query`                                                                                      | Read-only PostgreSQL on the team's database, auto-scoped to the current team.                                            |
| `rag_search`                                                                                     | Semantic search over the team's documents and memories.                                                                  |
| `web_search` / `web_fetch`                                                                       | External lookups.                                                                                                        |
| `read`                                                                                           | Read a sandbox file (attachment, persisted output, drive download).                                                      |
| `vision`                                                                                         | Visual analysis of an image or PDF page.                                                                                 |
| `list_documents`, `list_entities`, `list_labels`, `get_entity_details`, `list_field_definitions` | Browse the team's data. These are domain tools — they need to be activated via `search_tools` before they can be called. |
| `download_drive_document`                                                                        | Pull a file from the team's connected Drive into the sandbox.                                                            |
| `present_files`                                                                                  | Surface a generated file to the user. Always end a "produce a file" skill with this.                                     |
| `ask_user_question`                                                                              | Prompt the user when a required input is missing. One good question is better than three small ones.                     |
| `manage_tasks`                                                                                   | Track multi-step progress inside the conversation. Useful for long procedures the user wants to follow along with.       |

## Output: where files go

The chatbot sandbox has a fixed layout. The two directories your skill body cares about:

- `outputs/` — files the skill produces. Write here, then surface with `present_files`.
- `attachments/` — files the user uploaded in the current conversation. Read-only from the skill's perspective.

Other paths exist (`drive/`, `skills/`, `context/`, `memory/`) but a typical skill doesn't touch them directly.

## Writing style

Explain the _why_ when it isn't obvious. Today's chatbot reasons about what you ask it to do; if it understands the reason, it handles edge cases the skill didn't anticipate. If you find yourself stacking `ALWAYS` and `NEVER` in all-caps, that's a signal the instruction needs reframing — make the rule explicit, then say why it matters in one line.

Stay general where you can. A skill exists to be reused across many similar requests. Overfitting to the exact wording of the conversation that created it is a common trap. If the conversation said "use the green CSV", the skill should say "use the file the user provides", not "use the green CSV".

Pick one term and stick to it. _"The report"_ / _"the recap"_ / _"the document"_ across one body is a recipe for confusion.

## The principle of lack of surprise

A skill must do what its description claims. Don't write skills that exfiltrate data, run unrelated side-effects, or behave in ways the user wouldn't predict from reading the description. The chatbot trusts a triggered skill — that trust is the user's, on loan.

Concretely: no calls out to the internet that aren't justified by the procedure, no writes to places the procedure doesn't name, no rewriting team data without a clear instruction.

## Anti-patterns

- **Time-sensitive instructions.** _"If the date is past March 2026, use endpoint v2"_ — skills outlive any specific date. Phrase it in terms of the current state, not the calendar.
- **Windows paths.** Always forward slashes. `outputs/report.pdf`, never `outputs\report.pdf`.
- **Tools that don't exist.** Stick to the table above; don't reference `email_send` or `slack_post` unless they're really part of the chatbot.
- **Voodoo constants.** If you write a number (`MAX_RETRIES = 5`), say why or leave it out.
- **Listing every option when one is right.** _"Use `pdfplumber` for text extraction"_ beats _"You could use pdfplumber, PyPDF2, pypdf, pdfminer, or pdf2image"_.
- **First or second person in the description.** Triggers reliably less often.

## Two short examples

### Example 1 — generating a file

```markdown
---
name: weekly-digest
description: Generates a weekly digest as a Markdown file summarising the team's activity over a chosen period (new documents, completed items, key updates). Use when the user asks for a "weekly digest", "weekly recap", or "what happened this week".
---

# Weekly digest

## When to use

The user wants a single Markdown file recapping a recent period (defaults to the last 7 days).

## Inputs

- Optional date range. If absent, default to the past 7 days. Ask only if the user's phrasing is ambiguous.

## Steps

1. Resolve the date range. If the user said "this week", interpret as Monday→today.
2. Pull recent activity with `sql_query` — new documents, touched entities, updates in range.
3. Compose the digest in Markdown with three sections: **Documents**, **People & companies**, **Highlights**.
4. Write to `outputs/weekly-digest.md`.
5. Surface with `present_files({ paths: ["outputs/weekly-digest.md"] })`.

## Output

A Markdown file the user can read in chat or download.

## Edge cases

- No activity in range: produce the file anyway with a "No activity this week" line — better than no output.
- Range longer than 31 days: warn the user, ask if they really want to proceed.
```

### Example 2 — quick answer from data

```markdown
---
name: budget-status
description: Reports the current status of a budget the team tracks in their database (amount consumed, amount remaining, percentage used). Use when the user asks "where are we on the X budget", "how much is left on Y", or any variant phrasing.
---

# Budget status

## When to use

A quick read on a single budget. If the user wants a full breakdown or a chart, that's a different skill.

## Inputs

- Budget name. Ask via `ask_user_question` if not in the message.

## Steps

1. Resolve the budget by name with `sql_query`.
2. Compute `consumed = SUM(line_items.amount)` for that budget.
3. Reply in chat: one short sentence with consumed / total / percentage, formatted as currency.

## Output

A chat message. No file, no attachment.

## Edge cases

- Budget not found: list the three closest names by string distance and ask which one was meant.
- Total is zero: skip the percentage, say "no allowance set yet".
```

## Checklist before handing the draft to the user

- [ ] **Name** is a clean slug, ≤ 64 characters, no reserved words, no leading or trailing hyphen.
- [ ] **Description** has both _what_ and _when_, is third person, ≤ 1024 characters, mentions plausible trigger phrases.
- [ ] **Body** has clear numbered steps, names the actual tools used, says where the output lands.
- [ ] **No time-sensitive content**, **no Windows paths**, **consistent terminology** throughout.
- [ ] A fresh assistant with no context could execute the procedure correctly from this file alone.

If any box is unchecked, fix it first, then surface the draft.
