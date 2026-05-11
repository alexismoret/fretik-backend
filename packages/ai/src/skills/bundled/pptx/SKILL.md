---
name: pptx
description: Generate or edit PowerPoint decks (.pptx) with proper layouts, bullet lists, tables, images, and basic charts. Use when the deliverable is a slide presentation the user will open in a PowerPoint-compatible tool.
---

# pptx skill

Deliver a deck that opens cleanly, uses real layouts (so the user can edit every slide from the Outline view), and respects the "one idea per slide" discipline.

## When to use this skill

Trigger on: "PowerPoint", "pptx", "slides", "diapos", "présentation", "pitch", "deck", "briefing", "support de réunion", "kickoff", "quarterly review", and similar asks that imply a sequence of talking points.

Don't use for: a single-page visual summary (→ `data-viz` PNG is usually enough), a printable document (→ `pdf`), or dense data tables the user will pivot (→ `xlsx`).

## Tool: python-pptx

`from pptx import Presentation`. python-pptx builds decks on top of PowerPoint's built-in slide layouts, which means the user can restyle the whole deck from the Design tab in PowerPoint.

```python
from pptx import Presentation
from pptx.util import Inches, Pt

prs = Presentation()                 # empty deck with the "Office" theme

title_slide_layout = prs.slide_layouts[0]       # Title
title_slide = prs.slides.add_slide(title_slide_layout)
title_slide.shapes.title.text = "Monthly carrier review"
title_slide.placeholders[1].text = "March 2026 — Fretik ops"

prs.save("monthly-carrier-review-2026-03.pptx")
print("saved monthly-carrier-review-2026-03.pptx")
```

Then:

```
presentFiles({ paths: ["monthly-carrier-review-2026-03.pptx"], message: "Support du point mensuel transporteurs." })
```

## The slide layout catalogue

`prs.slide_layouts` is an ordered collection of the deck's built-in layouts. With the default blank `Presentation()`, you get:

| Index | Layout name          | Use for                                                         |
| ----- | -------------------- | --------------------------------------------------------------- |
| 0     | Title Slide          | Deck cover                                                      |
| 1     | Title and Content    | Headline + bullets/table/image                                  |
| 2     | Section Header       | Dividers between parts of the deck                              |
| 3     | Two Content          | Side-by-side comparison                                         |
| 4     | Comparison           | Two columns with sub-headings                                   |
| 5     | Title Only           | Big title, empty body (for a chart occupying most of the slide) |
| 6     | Blank                | Pixel-free canvas                                               |
| 7     | Content with Caption | Main body with a captioned sidebar                              |
| 8     | Picture with Caption | Large image + caption                                           |

Pick a layout deliberately. Default to `1` (Title and Content) for 80% of body slides.

## Workflow

### Create a fresh deck

```python
prs = Presentation()            # default theme
# …add slides…
prs.save("<filename>.pptx")
```

### Edit a deck the user uploaded

```python
prs = Presentation("existing-deck.pptx")
slide = prs.slides[2]                  # indexed from 0
# …mutate shapes on the slide…
prs.save("existing-deck-v2.pptx")      # never overwrite the source
```

Rules for edits:

- Preserve the user's theme. Don't call `Presentation()` without a filename when editing — that replaces the theme.
- To swap a slide's text, walk its `shapes`, find shape(s) with `has_text_frame`, iterate `paragraphs` and their `runs`, replace text at the run level (preserves font/color/size).
- To replace an image placeholder, replace the `Picture` shape's `image` via `shape.image` replacement pattern or delete+insert.

### Start from a branded template

If the user attaches `template.pptx`:

```python
prs = Presentation("template.pptx")          # inherits theme, fonts, colors
# add slides using prs.slide_layouts from the template, not the default ones
```

The user's layout catalogue may differ from the default one. Inspect:

```python
for i, layout in enumerate(prs.slide_layouts):
    print(i, layout.name)
```

## Common slide recipes

### Title + bullets

```python
from pptx.util import Pt

slide = prs.slides.add_slide(prs.slide_layouts[1])   # Title and Content
slide.shapes.title.text = "Headline numbers — March 2026"

body = slide.placeholders[1]
tf = body.text_frame
tf.text = "Volume: 5,487 TEU (+4.1% MoM)"        # first bullet

for line in [
    "On-time rate: 91.2% (+0.8 pts MoM)",
    "Average transit time: 18.2 days (-0.5 d MoM)",
    "Cost variance vs. contract: +1.9%",
]:
    p = tf.add_paragraph()
    p.text = line
    p.level = 0          # bullet level (0 = top, 1 = sub, …)
    p.font.size = Pt(18)
```

Rule: **one headline per slide, four bullets maximum, one idea per bullet.** If you need more, split into two slides.

### Section divider

```python
slide = prs.slides.add_slide(prs.slide_layouts[2])   # Section Header
slide.shapes.title.text = "Part II — Carrier performance"
slide.placeholders[1].text = "Volumes, on-time, and cost deltas across the top 10 carriers."
```

### Two-column comparison

```python
slide = prs.slides.add_slide(prs.slide_layouts[3])   # Two Content
slide.shapes.title.text = "CMA CGM vs. Maersk — March 2026"

left, right = slide.placeholders[1], slide.placeholders[2]
left.text_frame.text = "CMA CGM"
for b in ["Volume: 1,240 TEU", "On-time: 92.4%", "Cost: +3.1% vs. contract"]:
    left.text_frame.add_paragraph().text = b

right.text_frame.text = "Maersk"
for b in ["Volume: 1,102 TEU", "On-time: 89.7%", "Cost: -1.4% vs. contract"]:
    right.text_frame.add_paragraph().text = b
```

### Table slide

```python
from pptx.util import Inches
slide = prs.slides.add_slide(prs.slide_layouts[5])   # Title Only
slide.shapes.title.text = "Top 5 carriers — March 2026"

rows, cols = 6, 4                    # header + 5 data rows
left, top, width, height = Inches(0.5), Inches(1.5), Inches(9), Inches(4)
table = slide.shapes.add_table(rows, cols, left, top, width, height).table

headers = ["Carrier", "Volume (TEU)", "On-time rate", "Cost variance"]
for i, h in enumerate(headers):
    cell = table.cell(0, i)
    cell.text = h
    for run in cell.text_frame.paragraphs[0].runs:
        run.font.bold = True

data = [
    ("CMA CGM", "1,240", "92.4%", "+3.1%"),
    ("Maersk",  "1,102", "89.7%", "-1.4%"),
    ("MSC",     "985",   "94.2%", "+0.8%"),
    ("Hapag-Lloyd", "812", "88.1%", "+2.9%"),
    ("ONE",     "734",   "90.5%", "+0.3%"),
]
for r, row in enumerate(data, start=1):
    for c, v in enumerate(row):
        table.cell(r, c).text = v
```

### Image slide (e.g. a chart produced by `data-viz`)

```python
from pptx.util import Inches
slide = prs.slides.add_slide(prs.slide_layouts[5])   # Title Only
slide.shapes.title.text = "Volume by carrier — March 2026"
slide.shapes.add_picture(
    "volume-by-carrier.png",
    Inches(0.5), Inches(1.5),
    width=Inches(9),
)
```

When the chart is wider than tall, center it horizontally and use full width; when taller than wide, set `height=Inches(5.5)` instead of width.

### Charts native to python-pptx

python-pptx can create native PowerPoint charts (bar / line / pie). Use them when the user will want to tweak the chart inside PowerPoint (change colors, re-order series). Otherwise prefer a generated PNG via `data-viz` — it renders identically everywhere and is simpler to style.

```python
from pptx.chart.data import CategoryChartData
from pptx.enum.chart import XL_CHART_TYPE
from pptx.util import Inches

chart_data = CategoryChartData()
chart_data.categories = ["CMA CGM", "Maersk", "MSC", "Hapag-Lloyd", "ONE"]
chart_data.add_series("TEU", (1240, 1102, 985, 812, 734))

slide = prs.slides.add_slide(prs.slide_layouts[5])
slide.shapes.title.text = "Volumes by carrier"
chart_shape = slide.shapes.add_chart(
    XL_CHART_TYPE.COLUMN_CLUSTERED,
    Inches(0.5), Inches(1.5), Inches(9), Inches(5),
    chart_data,
)
```

## Styling

### Colors — default palette

| Role              | Hex      | Notes                            |
| ----------------- | -------- | -------------------------------- |
| Title text        | `1F4E78` | Deep blue, matches xlsx and docx |
| Body text         | `222222` | Near-black                       |
| Accent            | `2E75B6` | Lighter blue for callouts        |
| Positive          | `548235` | Muted green                      |
| Negative          | `C0504D` | Muted red                        |
| Muted / secondary | `808080` | Gray for captions and sources    |

```python
from pptx.dml.color import RGBColor
run.font.color.rgb = RGBColor(0x1F, 0x4E, 0x78)
```

### Fonts

Default to `Calibri` for everything. Title size 32–40, body 18–24, captions 12–14. Don't mix more than two type sizes on the same slide.

### Layout discipline

- Pick one layout per section of the deck and stick with it. Switching layouts every slide produces visual noise.
- Keep at least 1 inch of whitespace on the top, bottom, left, and right. Text hitting the edges signals overflow.
- Never shrink the default title box to cram more content — split the slide.

## Sources

Place the source on the lower-right of the slide that presents the data, in 10pt italic gray:

```python
from pptx.util import Inches, Pt
from pptx.dml.color import RGBColor

src_box = slide.shapes.add_textbox(Inches(0.3), Inches(6.8), Inches(9.4), Inches(0.4))
tf = src_box.text_frame
tf.text = "Source: querySql — shipments, 2026-04-21. Filter: team_id, status='confirmed'."
p = tf.paragraphs[0]
p.alignment = 3          # right
run = p.runs[0]
run.italic = True
run.font.size = Pt(10)
run.font.color.rgb = RGBColor(0x80, 0x80, 0x80)
```

For a multi-source slide (e.g. a chart combining querySql + webFetch), use two lines stacked.

## Code style

- Top-down: title slide → section dividers → content slides → closing slide. Insert slides in the order they appear.
- Use `prs.slide_layouts[N]` with the index, not `.get()` by name — the catalogue order is stable for the default theme and for any template worth its salt.
- Keep `add_slide` → mutate → next slide. Don't batch all `add_slide` calls first and then loop to set titles; it's harder to read.
- One `Presentation()` per file.
- Filename: kebab-case, dated, descriptive.

## Reusable helpers

`scripts/pptx_helpers.py` ships:

- `add_title_slide(prs, title, subtitle)` — one-liner for the cover.
- `add_bullets_slide(prs, title, bullets, subtitle=None)` — Title and Content layout with a list of strings.
- `add_source_box(slide, text)` — italic-gray source textbox in the bottom band.

Import:

```python
import sys; sys.path.insert(0, "skills/pptx/scripts")
import pptx_helpers as ph

ph.add_title_slide(prs, "Monthly carrier review", "March 2026 — Fretik ops")
ph.add_bullets_slide(
    prs,
    "Headline numbers",
    [
        "Volume: 5,487 TEU (+4.1% MoM)",
        "On-time rate: 91.2% (+0.8 pts MoM)",
        "Cost variance: +1.9% vs. contract",
    ],
)
```

## Common pitfalls

- **Text frame auto-shrinks and your 6 bullets become unreadable.** Split the slide. Don't fight with `text_frame.auto_size`.
- **Title box disappears.** You added a slide from `slide_layouts[6]` (Blank). Pick a layout with a title placeholder.
- **Font changes on only the first run of a paragraph.** Paragraph-level font changes don't cascade to runs that were added later. Set the font on each run.
- **Image stretched.** You specified both `width` and `height` on `add_picture`. Pass only one — python-pptx preserves the aspect ratio.
- **Table columns all the same width.** `add_table` splits width equally; adjust `table.columns[i].width = Inches(…)` per column afterwards.
- **Slide renders fine in LibreOffice Impress but fonts are wrong in PowerPoint.** You used a font that isn't installed on Windows. Stick to Calibri / Arial / Times New Roman for portability.
- **Saving to `.ppt` (legacy) instead of `.pptx`.** python-pptx only writes `.pptx`. Refuse the request politely.

## Further reading

- `references/chart-recipes.md` — native python-pptx chart recipes (when to embed vs. when to drop in a PNG from `data-viz`).
- `references/slide-patterns.md` — 10 reusable slide patterns for ops reviews (KPI row, RAG status, risk register, milestone timeline, …).

Load via `read("skills/pptx/references/<name>.md")` when needed.
