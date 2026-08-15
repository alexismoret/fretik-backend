# Bundled skills — origin and licensing

Every skill in this folder was authored in-house for Fretik. No skill body was copied or ported from any third-party source; each was written from scratch by the team using the public documentation of the underlying libraries (openpyxl, python-docx, python-pptx, reportlab, matplotlib) and standard software-engineering practice.

| Skill             | Origin   | License            | Notes                                                                                      |
| ----------------- | -------- | ------------------ | ------------------------------------------------------------------------------------------ |
| `xlsx`            | In-house | Fretik proprietary | Produces `.xlsx` with openpyxl; helpers in `scripts/workbook_helpers.py`.                  |
| `docx`            | In-house | Fretik proprietary | Produces `.docx` with python-docx; helpers in `scripts/docx_helpers.py`.                   |
| `pptx`            | In-house | Fretik proprietary | Produces `.pptx` with python-pptx; helpers in `scripts/pptx_helpers.py`.                   |
| `pdf`             | In-house | Fretik proprietary | Produces `.pdf` with reportlab (Platypus + canvas); helpers in `scripts/pdf_helpers.py`.   |
| `data-viz`        | In-house | Fretik proprietary | Produces chart PNGs with matplotlib; helpers in `scripts/viz_helpers.py`.                  |
| `doc-coauthoring` | In-house | Fretik proprietary | Prose-writing protocol (no scripts).                                                       |
| `building-pages`  | In-house | Fretik proprietary | Design + component-choice doctrine for generated pages. See the note below on its sources. |

## `building-pages` and its sources

The skill body is ours. Two third-party sources informed it, neither of them copied:

- **Nuxt UI docs** (MIT, https://ui.nuxt.com). The component API corpus served by `managePage { action: "components" }` is generated verbatim from the library's published `llms-full.txt` by `scripts/sync-nuxt-ui-docs.ts`, and lives OUTSIDE this folder, under `src/tools/assets/nuxt-ui/`. Each generated file carries its source and licence line. MIT permits this; regenerate it on every `@nuxt/ui` upgrade rather than editing a file by hand.
- **Anthropic's `frontend-design` skill** (Apache-2.0). Read for its approach to design process and restraint; nothing was reproduced. Our doctrine had to diverge anyway — that skill tells an agent to choose its own palette and typefaces, while a generated page must inherit the product's.

## A note on Anthropic's public skills

Anthropic publishes a reference skills repository at https://github.com/anthropics/skills. Some skills in that repo are released under Apache-2.0 and may be vendored into this folder in the future (with their `LICENSE.txt` preserved and an entry added to this table).

The four document skills (`xlsx`, `docx`, `pptx`, `pdf`) in that repo are **source-available but proprietary** (each ships its own `LICENSE.txt` forbidding reproduction, derivative works, and redistribution). Fretik's same-named skills here were written independently from Anthropic's OSS library documentation and do **not** reproduce, paraphrase, or derive from Anthropic's proprietary SKILL.md files.

If you add a new skill to this folder in the future, follow the same rule: write from scratch using OSS library docs and your own voice, or vendor an Apache-2.0 (or equivalent) skill verbatim with its license preserved. Don't download-and-tweak proprietary material.
