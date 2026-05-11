---
name: xlsx
description: Generate or edit Excel workbooks (.xlsx) with live formulas, styled headers, number/date formats, multi-sheet layouts, and source citations. Use when the deliverable is a numeric spreadsheet the user will open in an Excel-compatible tool.
---

# xlsx skill

Deliver a workbook that opens cleanly in Excel, carries live formulas where computation matters, is styled for readability, and cites its own sources.

## When to use this skill

Trigger on: "Excel", "xlsx", "spreadsheet", "tableau", "feuille", "classeur", "workbook", "budget", "pivot", "aggrégation", "rapport mensuel/trimestriel", or any request that implies the user wants an editable file of numbers rather than a read-only table in the reply.

Don't use for: a one-shot numeric summary the user just wants to read once (a Markdown table is lighter) or a chart-only deliverable (use `data-viz`).

## Tool choice: pandas OR openpyxl — rarely both in the same cell

Split the work cleanly:

- **pandas** — load, reshape, filter, join, aggregate-for-inspection. Ideal for the "get the numbers right" phase.
- **openpyxl** — write the final `.xlsx`: formulas, cell styles, column widths, number formats, freeze panes. Everything that makes the workbook pleasant to open.

Never use `DataFrame.to_excel()` for a deliverable — it produces a dump (no formulas, no styling, no sensible widths). `to_excel` is fine for debugging; the final file always goes through openpyxl.

## Workflow

### Create a fresh workbook

```python
from openpyxl import Workbook
wb = Workbook()
ws = wb.active
ws.title = "Summary"
wb.create_sheet("Details")
# …append rows, set formulas, style…
wb.save("report.xlsx")
print("saved report.xlsx")
```

### Edit a workbook the user uploaded

The file already lives in the conversation sandbox — open it by filename.

```python
from openpyxl import load_workbook
wb = load_workbook("quote-v1.xlsx")
ws = wb["Lines"]
ws.cell(row=12, column=3, value=1_850)   # update an input, formulas downstream update themselves
wb.save("quote-v2.xlsx")                 # NEVER overwrite the source file
```

Rules for edits:

- Always save under a new filename (`-v2`, `-edited`, a dated suffix). The user may want to diff against their original.
- Preserve existing formulas: update the cells they read from, not the result cells.
- Default `load_workbook(path)` keeps formulas intact. `data_only=True` returns cached values only — use it only when you need to _read_ computed values, never when you'll edit.

### After saving, always hand off

```
presentFiles({ paths: ["<filename>.xlsx"], message: "<one-line caption>" })
```

The frontend renders the file card with a Download button and an "Open with Excel" action.

## Golden rule: formulas over hardcoded results

Any cell whose value is derived from other cells in the same workbook MUST be an Excel formula, not a Python-computed number. When the user edits an input, the derived cell updates — that's the entire point of delivering an editable spreadsheet.

Rule of thumb: if the value could be written as a cell reference, write it as `=…`.

**Examples of what to write:**

- Column total → `ws["D21"] = f"=SUM(D2:D{ws.max_row - 1})"`
- Row-level derivation inside a loop → `ws.cell(row=r, column=6, value=f"=D{r}*E{r}")`
- Cross-sheet lookup → `ws["B2"] = "='By carrier'!D10"`
- Conditional count → `ws["G2"] = '=COUNTIF(F:F,"confirmed")'`
- Weighted growth → `ws["H2"] = "=(H1-H0)/H0"` then `cell.number_format = "0.0%"`

**Wrong moves** (computed in Python, cell holds a dead number):

- `ws["D21"] = df["D"].sum()` — the total is frozen.
- `ws["H2"] = (row_new - row_old) / row_old` — growth cell won't follow if the user edits `row_old`.
- `ws["C10"] = statistics.mean(values)` — average is dead.

**When hardcoding IS correct:**

1. Primary input data you just fetched — the whole point of the sheet is to render those literals.
2. An explicitly snapshotted value (e.g. invoice total that must not drift if line items change later). Be deliberate about this; document it with a small note in the `Notes` sheet.
3. Constants with no cell counterpart (e.g. "Report generated on {date}" in a header).

Prefer structured references (`$B$1` for a fixed constant, `D$2:D$500` for a fixed range) so formulas survive row insertion.

See `references/formulas-and-formatting.md` for a broader catalogue: conditional sums, running totals, nested IFs, XLOOKUP, and how to fan formulas across many rows with one `ws.cell(row=r, ...)` loop.

## Styling

### Colors — accessible defaults

Use this palette unless the user asks for a brand one:

| Role               | Hex      | Notes                                             |
| ------------------ | -------- | ------------------------------------------------- |
| Header fill        | `1F4E78` | Deep blue; white text sits on it with AA contrast |
| Header text        | `FFFFFF` | White                                             |
| Total row fill     | `D9E2EC` | Slightly darker than body; signals aggregation    |
| Zebra stripe       | `F2F6FA` | Optional, very pale blue                          |
| Negative / warning | `C0504D` | Muted red for threshold breaches, negative deltas |
| Positive / success | `548235` | Muted green for positive deltas                   |
| Footnote text      | `808080` | Gray — for source lines and disclaimers           |

Colors exist to guide the eye, not to decorate. Resist rainbow schemes.

### Layout conventions

- Row 1 is either a merged title (font 14, bold, spans used columns) followed by a blank row and headers in row 3 — OR the header row directly when the sheet name serves as the title. Pick one style per workbook and stick with it.
- `ws.freeze_panes = "A2"` (or `"A4"` with a title row) so headers stay visible on scroll.
- Column widths: every labelled column gets at least `max(header_length, 10)`. Long-text columns get 40–60 plus `cell.alignment = Alignment(wrap_text=True)`.
- One logical table per sheet. If two tables are side-by-side, they belong on separate sheets.

### Number formats — always set them

| Data          | Format                                                             |
| ------------- | ------------------------------------------------------------------ |
| Integer count | `"#,##0"`                                                          |
| Currency EUR  | `"#,##0.00 €"`                                                     |
| Currency USD  | `"$#,##0.00"`                                                      |
| Percentage    | `"0.0%"` (value is the decimal; Excel multiplies by 100 on render) |
| Date          | `"yyyy-mm-dd"`                                                     |
| Date+time     | `"yyyy-mm-dd hh:mm"`                                               |
| Weight        | `"#,##0 \"kg\""` (literal unit)                                    |

```python
for cell in ws["E"][1:]:        # column E, skip header
    cell.number_format = "#,##0.00 €"
```

## Sources: cite every table

A workbook the user will share or archive must say where its numbers came from. One or more lines below the last data row, in italic gray (`808080`), merged across the table columns:

```
Source: [System/Document], [Date], [Specific Reference], [URL if applicable]
```

Examples (invent-free — fill with what you actually used):

- `Source: Fretik extraction ext_abc123, 2026-04-21, rows where status='confirmed'`
- `Source: querySql — extractions + documents, team_id, as of 2026-04-21 09:00 Europe/Paris`
- `Source: shipments.csv uploaded 2026-04-20 14:32 UTC, sheet "raw", rows 2–487`

When a sheet pulls from multiple sources, write one line per source. Use `scripts/workbook_helpers.add_source_footer(ws, lines)` to apply the canonical styling.

## Code style

- One worksheet per logical concept; no side-by-side tables.
- Build the header row via `scripts/workbook_helpers.style_header_row(ws)` — don't repeat the Font / Fill / Alignment block inline.
- Write rows with `ws.append(tuple)`, not a nested `ws.cell(row=, column=, value=)` loop — it reads cleaner.
- Filenames: kebab-case, descriptive, dated when the content is time-sensitive (`carrier-performance-2026-q1.xlsx`). No spaces, no accents.
- Don't wrap `wb.save()` in try/except. A save failure is always actionable — let the error surface.
- No `wb.close()` — `.save()` closes automatically; calling both raises.

## Reusable helpers

`scripts/workbook_helpers.py` (in this skill folder) ships:

- `style_header_row(ws, fill="1F4E78", color="FFFFFF")` — canonical header style.
- `autosize_columns(ws, min_w=10, max_w=60)` — width = longest string in each column, clamped.
- `add_source_footer(ws, lines)` — italic-gray source lines, one row below current data.

Import with:

```python
import sys
sys.path.insert(0, "skills/xlsx/scripts")
import workbook_helpers as wh

wh.style_header_row(ws)
wh.autosize_columns(ws)
wh.add_source_footer(ws, ["Source: querySql, as of 2026-04-21"])
```

## Common pitfalls

- **Formula shows up as literal text in Excel.** The cell was written with a leading apostrophe or forced to string type. Plain `ws["B10"] = "=SUM(B2:B9)"` is correct — openpyxl converts it.
- **Dates render as `46355` instead of `2026-03-01`.** You wrote a `date`/`datetime` object without setting `cell.number_format = "yyyy-mm-dd"`.
- **Numbers render as text and can't be summed.** The value was a `str` (`"1200"`), not an `int`/`float`. Convert upstream.
- **Merged cells inside a SUM range.** `=SUM(B2:B9)` over a range where `B5:C5` is merged raises in some Excel versions. Merge only title/decoration cells.
- **Default `Sheet` lingers.** `Workbook()` creates a default `Sheet`. Rename it (`wb.active.title = "X"`), don't add alongside via `create_sheet(..., 0)` unless you also delete the default.
- **NaN / infinity in a cell.** Excel can't store these. Convert upstream to `None` (→ empty cell) or a sentinel.
- **Forgot to save.** openpyxl buffers in memory. `wb.save(path)` is mandatory. Print a confirmation (`print(f"saved {path}")`) before calling `presentFiles`.
- **Overwrote the user's source file.** Always save edits under a new name.
- **Used `to_excel()` for a deliverable.** Re-read the Tool choice section.
- **Over-styled.** More than three colors on a sheet → it looks like a school project. Stick to the palette above.

## Further reading

Large reference material is kept out of SKILL.md to respect the progressive disclosure pattern. Load on demand:

- `references/formulas-and-formatting.md` — exhaustive formula recipes (conditional, lookup, text, date, window functions) and number format cookbook.

Use `read("skills/xlsx/references/formulas-and-formatting.md")` when the user's need goes beyond the canonical examples here.
