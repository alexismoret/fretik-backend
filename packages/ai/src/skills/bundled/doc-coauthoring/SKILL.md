---
name: doc-coauthoring
description: Co-author long-form text documents over multiple turns — keep voice and structure consistent, handle scoped revisions without rewriting whole sections, cite every factual claim. Use when the deliverable is multi-section prose the user will iterate on before exporting.
---

# doc-coauthoring skill

Guide a multi-turn document-writing session where the user steers structure, tone, and scope. The deliverable is text — either rendered directly in the chat, or persisted via the `docx` / `pdf` skills once the user is happy with it.

## When to use this skill

Trigger on: "write me a report", "draft a proposal", "aide-moi à rédiger", "restructure this memo", "expand section 3", "shorten the executive summary", "reword this paragraph to be more formal", "find a better title", "add a conclusion", and similar multi-step writing collaborations.

Don't use for: one-shot text that doesn't need iteration (a single email, a chat reply), or producing the final-format file (→ `docx` / `pdf` once the content is locked).

## Principles

### One structure, agreed once

Before writing, propose a section outline (3–8 sections, each with a one-line purpose) and get explicit user approval. Every subsequent turn refers to sections by number, and reshapes only the agreed scope. If the user asks for a change that breaks the structure, surface the conflict and ask whether to update the outline.

### Revise, don't rewrite

When the user asks for a change to a paragraph, edit that paragraph. Don't silently re-produce the whole document. When a change has ripple effects elsewhere (e.g. adjusting a number changes the executive summary), state which other sections will be touched and touch only those.

### One voice per document

Pick a register at the start and hold it. The defaults:

- **Executive reports / internal memos** — factual, crisp, first-person plural ("we observed", "we recommend"), short paragraphs (2–4 sentences).
- **Proposals / RFPs** — confident, benefit-oriented, second-person ("you'll get", "your team"), mid-length paragraphs.
- **Policies / procedures** — imperative, numbered, no adjectives ("audit invoices monthly", "escalate to level 2 within 2 business hours").
- **Client-facing letters / courriers** — formal, full sentences, one idea per paragraph, signatures and references in the proper places.

Switch only when the user explicitly asks. If they don't, lock the register by the end of the first paragraph.

### Cite every factual claim

Any number, date, name, or factual assertion pulled from a tool result gets an inline citation. Format — same convention as xlsx/docx/pptx/pdf:

```
Source: [System/Document], [Date], [Specific Reference], [URL if applicable]
```

Place the citation:

- Inline, in parentheses, at the end of the sentence → for dense factual paragraphs.
- As a numbered footnote-style reference at the end of the section → for longer texts with many citations (`[^1]`, `[^2]` convention).

Don't bury citations at the very end of the document; the reader must be able to verify each claim as they read it.

### Surface open questions visibly

When there's a fact you don't have, a number that's pending, or a decision the user needs to make, write a `> TODO — [one-line question]` blockquote in place, and list every `TODO` at the top of each rewrite. Example:

```
> TODO — confirm the Q1 2026 on-time rate for MSC (tool returned no data for March 28–31).
```

Don't paper over gaps with approximations.

## Workflow

### Turn 1 — Intent capture

Ask, in one concise turn, for whatever of the following the user hasn't already said:

1. **Document type** (report, proposal, policy, memo, letter).
2. **Audience** (executives, peers, clients, regulators).
3. **Length target** (half page, one page, 3–4 pages, ≥ 10 pages).
4. **Source material** (what data / files / docs the draft should be grounded in).
5. **Constraints** (deadline, confidentiality, template to follow).

If the conversation already covered some of these, confirm your inferences rather than re-asking.

### Turn 2 — Outline

Propose a numbered section outline with a one-line purpose for each. Mark sections as `(data-grounded)` when they depend on a tool call, `(narrative)` otherwise. Example:

```
1. Executive summary (narrative, ≤ 150 words)
2. Volume and on-time performance — March 2026 (data-grounded)
3. Top 5 carriers (data-grounded)
4. Risks and mitigations (narrative)
5. Recommendations for April (narrative)
```

Get explicit confirmation or iterate. Don't start writing the body until the outline is approved.

### Turn 3 — First full draft

Write every section at the agreed length. For data-grounded sections, run the tool calls first, then write. Cite every datum. Surface every gap as a `> TODO`.

### Turns 4+ — Revision loop

The user asks for changes. Do the minimum-diff revision:

- Paragraph-level change → rewrite that paragraph, show it in context (the surrounding paragraphs unchanged).
- Section-level restructure → rewrite that section, confirm before touching any other.
- Global tone change → propose the register shift and a one-paragraph sample before applying it everywhere.

Keep a visible changelog between turns:

```
Changes since last turn:
- Section 1: tightened to 120 words
- Section 3: added CMA CGM row, updated the total
- Section 5, recommendation 2: softened tone per your feedback
```

### Final turn — Handoff

When the user signals they're done (`"ok parfait"`, `"that's good, export it"`), offer to persist via:

- `docx` skill — for a Word document the user will edit further or share externally.
- `pdf` skill — for a final, print-ready version.

Never auto-persist without the user's say-so — they may still want to iterate.

## Length discipline

Match the target:

- ≤ 1 page (≤ 300 words): 1 title, 2–3 sections, zero subsections.
- 2–4 pages (500–1200 words): 1 title, 4–6 sections, at most 1 level of subsection.
- 5–10 pages (1500–3000 words): 1 title, 6–9 sections, subsections where needed, include a one-paragraph executive summary at the top.
- ≥ 10 pages: add a table of contents, number every subsection, include a references section at the end.

Don't pad. A shorter document that says exactly what the reader needs is always better than a longer one that says the same thing with scaffolding.

## Formatting conventions (in-chat preview)

Use Markdown while drafting in the conversation so the user sees structure:

- `#` for the document title, `##` for sections, `###` for subsections.
- Numbered lists for steps, bulleted for unordered.
- `> TODO — …` blockquotes for gaps.
- Tables for any two-or-more-column comparison.
- Inline citations in parentheses at the end of each factual sentence.

When the user approves the draft, the `docx` / `pdf` skills convert this structure to native styles (see their respective SKILL.md files).

## Code style — NONE

This skill doesn't execute code directly. It's a prose-writing discipline. All tool calls are for data gathering (querySql, searchKnowledge, webFetch, …), not document rendering. Rendering happens in the final `docx` / `pdf` turn.

## Common pitfalls

- **Starting to write before the outline is approved.** Forces the user into reactive editing. Get the outline right first.
- **Silently rewriting a section the user didn't ask to change.** Breaks trust. Always announce the scope of each edit in the changelog.
- **Inventing a number to fill a gap.** Always write a `> TODO` instead.
- **Mixed voice inside a single paragraph.** Pick one register per document and hold it.
- **Bullet lists for narrative text.** Bullets are for enumerations, not arguments. Paragraphs hold arguments.
- **No citations inline.** Dump at the end = unverifiable. Attach each citation to the claim it supports.
- **Expanding scope beyond the outline.** If you have more to say than the outline allows, flag it and propose an outline update; don't append a "bonus section".
