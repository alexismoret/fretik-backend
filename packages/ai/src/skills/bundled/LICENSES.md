# Bundled skills — origin and licensing

Every skill in this folder was authored in-house for Fretik. No skill body is copied or ported from any third-party source; each was written from scratch by the team using the public documentation of the underlying libraries (openpyxl, python-docx, python-pptx, reportlab, matplotlib) and standard software-engineering practice. Where a public skill informed our thinking, we took the approach and wrote our own prose against our own platform — an approach is not expression.

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

The skill body is ours. One third-party source feeds it, and it is not copied into this folder:

- **Nuxt UI docs** (MIT, https://ui.nuxt.com). The component API corpus served by `managePage { action: "components" }` is generated verbatim from the library's published `llms-full.txt` by `scripts/sync-nuxt-ui-docs.ts`, and lives OUTSIDE this folder, under `src/tools/assets/nuxt-ui/`. Each generated file carries its source and licence line. MIT permits this; regenerate it on every `@nuxt/ui` upgrade rather than editing a file by hand.

## Adding a skill to this folder

Two acceptable routes, and nothing between them:

- **Write it from scratch** — your own prose, our own tools and vocabulary. Reading a public skill for its approach first is fine; reproducing or paraphrasing its text is not.
- **Vendor it verbatim** when its licence explicitly allows redistribution — keep the upstream `LICENSE.txt` beside the SKILL.md and add a row to the table above naming the source and the licence.

A public skill that ships **no licence file** is not implicitly permissive: treat it as un-vendorable and take the first route. Never download-and-tweak.
