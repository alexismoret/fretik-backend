# Skills audit backlog

Audit of all agent-facing skills against `.agent/agent-context-framework.md`
(2026-07-17, prompt-refonte chantier). Method: mechanical sweep (stale tool/
section names, industry vocabulary in bundled skills, approval-flow
duplication vs the system prompt, line counts vs value) + sampled prose
review. NOT shipped to the model — maintainer notes only.

## Verdicts

| File                                                                     | Lines           | Verdict                                                                                                                      |
| ------------------------------------------------------------------------ | --------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| bundled/docx/SKILL.md                                                    | 735             | OK — legitimate technical depth (patterns, traps)                                                                            |
| pdf/reference.md · pptx/pptxgenjs.md · pdf/forms.md · pptx/editing.md    | 640/581/312/213 | OK — reference material, read on demand                                                                                      |
| bundled/doc-coauthoring/SKILL.md                                         | 401             | MINOR — subjective tightening pass pending (see backlog)                                                                     |
| bundled/pdf · xlsx · data-viz · tabular-extraction · pptx · skill-author | 342-235         | OK                                                                                                                           |
| bundled/designing-object-types/SKILL.md                                  | 96              | OK — canonical home for object modeling                                                                                      |
| bundled/platform-guide/*                                                 | new             | OK (written under the framework)                                                                                             |
| providers/shiptify/guidance.md                                           | 217             | MINOR — over the ~150-line bar; overage is worked examples + API validation traps (legitimate), but a −20% pass is plausible |
| providers/front/guidance.md                                              | 179             | MINOR — same: tightening pass, no structural issue                                                                           |
| providers/outlook · imap-smtp · planner · teams · exchange               | 167-94          | OK                                                                                                                           |

Findings worth recording:

- **Zero stale references** (manageTasks, listEntities, getDocumentContent, old prompt section names) across all 16 skills.
- **Zero industry vocabulary** in bundled skills (the `BL` hit in xlsx L260 is an Excel column letter, not a bill of lading).
- **No approval-flow duplication**: provider guidance mentions of `run_plan`/approval are provider-specific mechanics (bulk `*_messages` variants, one-plan bundling, API quirks) — the doctrine itself lives only in `<external_apps>`.

## Backlog (do under the framework, not urgent)

1. `shiptify/guidance.md` — tightening pass: compress repeated `run_plan` scaffolding across examples; target ≤180 lines without losing the validation traps.
2. `front/guidance.md` — same pass; target ≤150.
3. `doc-coauthoring/SKILL.md` — subjective prose review (longest non-reference bundled body after docx); check anti-patterns B/D.
4. Full-prose (non-mechanical) review of data-viz + tabular-extraction against §3 patterns — deferred, no signal of violations.
