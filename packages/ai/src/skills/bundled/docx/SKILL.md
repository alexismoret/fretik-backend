---
name: docx
description: Generate or edit Microsoft Word documents (.docx) with native styles, headings, tables, lists, images, and headers/footers. Use when the deliverable is a text-heavy document the user will open in a Word-compatible editor.
---

# docx skill

Deliver a Word document that opens cleanly, uses native Word styles (so the user can restyle everything from the Home ribbon), and carries real structure (headings, tables, lists) rather than visual fakes.

## When to use this skill

Trigger on: "Word", "docx", "document", "rapport", "memo", "lettre", "contrat", "compte-rendu", "note", "proposition", "procédure", "politique", and similar asks that imply a multi-section text deliverable the user will edit further.

Don't use for: a reply that only needs Markdown in the chat, a single-page pixel-perfect invoice (→ `pdf`), slides (→ `pptx`), or numeric tables the user will pivot (→ `xlsx`).

## Tool: python-docx

Always use `python-docx` (`from docx import Document`). It ships with Word's built-in style set, so setting `paragraph.style = "Heading 1"` produces a heading the user can restyle globally — the right way to build documents.

```python
from docx import Document

doc = Document()
doc.add_heading("Monthly carrier review — March 2026", level=0)
doc.add_paragraph(
    "This report summarises shipment volumes, on-time performance, "
    "and cost variance across the top ten carriers for March 2026."
)
doc.add_heading("Headline numbers", level=1)
# …
doc.save("monthly-carrier-review-2026-03.docx")
print("saved monthly-carrier-review-2026-03.docx")
```

Then:

```
presentFiles({ paths: ["monthly-carrier-review-2026-03.docx"], message: "Rapport mensuel transporteurs, mars 2026." })
```

## Workflow

### Create a new document

```python
from docx import Document
doc = Document()          # empty, default styles
# add content…
doc.save("<filename>.docx")
```

### Edit a document the user uploaded

```python
from docx import Document
doc = Document("draft-contract.docx")     # attached to the message
# …mutate paragraphs, tables, replace placeholders…
doc.save("draft-contract-edited.docx")    # save under a new filename
```

Rules for edits:

- Never overwrite the source file. Save as `…-edited.docx` or `…-v2.docx`.
- Prefer in-place text edits on existing paragraphs over adding new ones when the user asks for a rewrite — it preserves formatting the original applied.
- To replace a placeholder (`{{client_name}}`) across the whole document, walk every run of every paragraph and every cell's paragraphs.

### Use a template

If the user attaches `template.docx` and asks you to fill it:

```python
doc = Document("template.docx")
for p in doc.paragraphs:
    for run in p.runs:
        run.text = run.text.replace("{{client}}", "ACME SA").replace(
            "{{date}}", "2026-04-21"
        )
doc.save("acme-proposal-2026-04-21.docx")
```

Run-level replacement preserves font / bold / italic; paragraph-level replacement loses run boundaries.

## Structure: use real Word styles

Every heading goes through `doc.add_heading(text, level=N)` (N ∈ {0..9}). The zero level is the title; 1–3 are section levels.

```python
doc.add_heading("Monthly carrier review", level=0)     # title
doc.add_heading("Summary", level=1)                    # section
doc.add_heading("By carrier", level=2)                 # subsection
doc.add_heading("CMA CGM", level=3)                    # sub-subsection
```

Paragraphs use `doc.add_paragraph(text, style=None)`. Use built-in styles rather than hand-rolling bold/italic on every run:

- `"Normal"` — body text (default)
- `"Intense Quote"` — pullquote block
- `"Quote"` — simple indented quote
- `"List Bullet"` — bulleted item
- `"List Number"` — numbered item
- `"Caption"` — figure/table caption

Lists:

```python
for item in ["On-time rate", "Volume (TEU)", "Average transit time"]:
    doc.add_paragraph(item, style="List Bullet")

for item in ["Audit invoices", "Reconcile with contracts", "Prepare dispute file"]:
    doc.add_paragraph(item, style="List Number")
```

Nested lists: python-docx doesn't expose nesting directly. For a shallow nested structure, fall back to `docx`'s run-level indent:

```python
p = doc.add_paragraph(style="List Bullet")
p.paragraph_format.left_indent = Pt(36)       # deeper indent = nested
p.add_run("Sub-item under the previous bullet.")
```

Page breaks:

```python
doc.add_page_break()
```

Section breaks (odd-page / continuous / next-page):

```python
from docx.enum.section import WD_SECTION
new_section = doc.add_section(WD_SECTION.NEW_PAGE)
```

## Tables

Tables anchor every report. Use them for any two-or-more-column data.

```python
table = doc.add_table(rows=1, cols=4)
table.style = "Light Grid Accent 1"    # built-in — safe to pick any "Light *" or "Medium *"
hdr = table.rows[0].cells
hdr[0].text = "Carrier"
hdr[1].text = "Volume (TEU)"
hdr[2].text = "On-time rate"
hdr[3].text = "Cost variance"

rows = [
    ("CMA CGM", "1,240", "92.4%", "+3.1%"),
    ("Maersk",  "1,102", "89.7%", "-1.4%"),
    ("MSC",     "   985", "94.2%", "+0.8%"),
]
for carrier, volume, otp, cost in rows:
    cells = table.add_row().cells
    cells[0].text = carrier
    cells[1].text = volume
    cells[2].text = otp
    cells[3].text = cost
```

Table styles to know (all ship with Word):

- `"Light Grid Accent 1..6"` — clean bordered grid, various accent colors.
- `"Light List Accent 1..6"` — bold header, alternating rows.
- `"Medium Shading 1 Accent 1..6"` — dark header row, subtle body.
- `"Table Grid"` — plain bordered grid, no accent.

Column widths (set after the rows are added):

```python
from docx.shared import Inches
for cell in table.columns[0].cells:
    cell.width = Inches(1.6)
```

Alignment inside cells:

```python
from docx.enum.text import WD_ALIGN_PARAGRAPH
cell.paragraphs[0].alignment = WD_ALIGN_PARAGRAPH.RIGHT
```

Right-align every numeric column in a loop; keep text columns left-aligned.

## Images

```python
from docx.shared import Inches
doc.add_picture("chart.png", width=Inches(5.5))    # width keyword keeps aspect ratio
doc.add_paragraph("Figure 1 — Monthly volume by carrier.", style="Caption")
```

Images must live in the conversation sandbox. If the user needs a generated chart, produce it via the `data-viz` skill first, then embed the resulting PNG.

## Headers, footers, and page numbers

```python
section = doc.sections[0]
header = section.header.paragraphs[0]
header.text = "Fretik — Monthly carrier review"
footer = section.footer.paragraphs[0]
footer.text = "Confidential — 2026-04-21"
```

For live page numbers, insert a run with an `XML` field. That gets into OOXML territory — if the user explicitly needs automatic pagination, produce a PDF instead (`pdf` skill) where pagination is trivial, or document the limitation.

## Styling: colors, fonts, spacing

### Colors — accessible defaults

| Role      | Hex      | Notes                               |
| --------- | -------- | ----------------------------------- |
| Body text | `222222` | Near-black, softer than pure black  |
| Headings  | `1F4E78` | Deep blue, matches xlsx header fill |
| Accent    | `548235` | Muted green for positive emphasis   |
| Warning   | `C0504D` | Muted red for risk / breach         |
| Caption   | `595959` | Medium gray                         |
| Link      | `2E75B6` | Standard Word link blue             |

Applied on a run:

```python
from docx.shared import RGBColor, Pt
run = doc.add_paragraph().add_run("Key finding")
run.bold = True
run.font.color.rgb = RGBColor(0x1F, 0x4E, 0x78)
run.font.size = Pt(12)
```

### Fonts

Default to `Calibri` 11pt for body and 16pt bold for title — Word's out-of-the-box look. Override only when the user asks for a brand font.

### Paragraph spacing

- Body paragraphs: 6pt after.
- Headings: 12pt before, 6pt after.
- Tables: 6pt after the caption paragraph, 12pt after the last row.

```python
from docx.shared import Pt
p = doc.add_paragraph("…")
p.paragraph_format.space_after = Pt(6)
p.paragraph_format.line_spacing = 1.15
```

## Sources — cite inline or in a footer section

Two acceptable patterns:

1. **Inline citation at the end of a claim** — a single italic gray run after the last sentence of the paragraph. Best for shorter documents.

   ```python
   p = doc.add_paragraph("The average transit time in March was 18.2 days. ")
   cite = p.add_run("Source: querySql — shipments, 2026-04-21.")
   cite.italic = True
   cite.font.color.rgb = RGBColor(0x80, 0x80, 0x80)
   cite.font.size = Pt(9)
   ```

2. **Sources section at the end** — a short "Sources" H2 with one bullet per source line. Best for longer reports with many datapoints.

   ```
   Source: [System/Document], [Date], [Specific Reference], [URL if applicable]
   ```

Fill with actual references (no invention): extraction IDs, table names, filenames with timestamps, document IDs from the Fretik app with `/document/<id>` links.

## Code style

- Build the document top-down. Never insert paragraphs into the middle after the fact unless you're editing an existing file — it gets fragile.
- Prefer styles over manual formatting. `doc.add_paragraph("x", style="Intense Quote")` beats building the same look with runs and colors.
- One `Document()` per file. Multi-file jobs are multi-turn.
- Filename: kebab-case, dated, descriptive (`monthly-carrier-review-2026-03.docx`).
- Don't catch errors around `doc.save()` — let failures surface with a clear message.

## Reusable helpers

`scripts/docx_helpers.py` ships:

- `set_body_defaults(doc, font="Calibri", size=11)` — overrides the Normal style on all paragraphs.
- `add_header_footer(doc, header_text, footer_text)` — sets the first section's header/footer.
- `add_inline_citation(paragraph, source_line)` — appends the italic-gray cite run to the end of a paragraph.

Import:

```python
import sys
sys.path.insert(0, "skills/docx/scripts")
import docx_helpers as dh
```

## Common pitfalls

- **Bold / italic only on part of a paragraph.** Don't retype the whole paragraph with `.bold = True` — it makes the entire paragraph bold. Split into multiple runs: `p.add_run("Normal text. ")` then `p.add_run("Bold tail.").bold = True`.
- **Table cell text not centered vertically.** Cells default to top-aligned. Set `cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER` (import from `docx.enum.table`).
- **Unicode in a run crashes.** It doesn't — python-docx handles UTF-8 natively. If a character renders as `?` in Word, the issue is the font, not the library. Swap to Arial / Noto Sans.
- **`.text = "…"` on a cell wipes existing formatting.** Prefer `cell.paragraphs[0].runs[0].text = "…"` to preserve styles.
- **Trying to set page size / margins on every section individually.** Use `doc.sections[0]` and be aware that each `add_section()` inherits from the previous — mutate once before adding.
- **Saving in `.doc` format.** python-docx only writes `.docx` (Word 2007+). `.doc` is a different binary format — refuse the request and explain.
- **Forgetting `doc.save()`.** Like openpyxl, there's no autosave. Print `f"saved {path}"` before handing off.

## Further reading

- `references/table-styles.md` — visual preview of every built-in Word table style with the exact name to pass to `table.style = …`.
- `references/docx-templates.md` — pattern for turning a user's template into a placeholder-filling pipeline (mail-merge style).

Load via `read("skills/docx/references/<name>.md")` when the user's scenario demands it.
