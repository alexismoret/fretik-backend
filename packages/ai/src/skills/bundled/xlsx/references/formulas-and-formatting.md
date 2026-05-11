# xlsx — formulas & formatting cookbook

Recipes beyond the canonical set in SKILL.md. Read when the user's scenario isn't covered up there.

## Conditional aggregation

```python
# Count by status
ws["H2"] = '=COUNTIF(Status,"confirmed")'      # named range
ws["H3"] = '=COUNTIF(D2:D500,"confirmed")'     # plain range

# Sum rows where another column matches
ws["I2"] = '=SUMIF(D2:D500,"confirmed",F2:F500)'

# Multi-criteria count
ws["J2"] = '=COUNTIFS(D2:D500,"confirmed",E2:E500,">2026-01-01")'

# Multi-criteria sum
ws["K2"] = '=SUMIFS(F2:F500,D2:D500,"confirmed",E2:E500,">2026-01-01")'
```

## Lookups

```python
# XLOOKUP (Excel 365 / 2021+) — preferred for new files
ws["B2"] = '=XLOOKUP(A2,Carriers!A:A,Carriers!B:B,"-")'

# Classic VLOOKUP — still works everywhere
ws["B2"] = '=VLOOKUP(A2,Carriers!A:B,2,FALSE)'

# INDEX/MATCH — works in older Excel and is faster on large sheets
ws["B2"] = '=INDEX(Carriers!B:B,MATCH(A2,Carriers!A:A,0))'
```

## Running totals and percentages

```python
# Running total of column D, starting at row 2
for r in range(2, ws.max_row + 1):
    ws.cell(row=r, column=5, value=f"=SUM(D$2:D{r})")

# Share of total
for r in range(2, ws.max_row + 1):
    ws.cell(row=r, column=6, value=f"=D{r}/SUM(D$2:D${ws.max_row})")
    ws.cell(row=r, column=6).number_format = "0.0%"

# Period-over-period growth
ws["H2"] = "=(G2-G1)/G1"
ws["H2"].number_format = "0.0%"
```

## Nested conditionals

Prefer IFS over chained IFs; it reads better.

```python
# IF chain
ws["I2"] = '=IF(F2>10000,"large",IF(F2>1000,"mid","small"))'

# IFS — cleaner
ws["I2"] = '=IFS(F2>10000,"large",F2>1000,"mid",TRUE,"small")'

# SWITCH for exact-match dispatch
ws["J2"] = '=SWITCH(A2,"FR","Europe","DE","Europe","CN","Asia","US","Americas","Other")'
```

## Dates

```python
# Today's date (volatile — recomputes on open)
ws["B1"] = "=TODAY()"

# Year / month / day extraction
ws["C2"] = "=YEAR(A2)"
ws["D2"] = "=MONTH(A2)"
ws["E2"] = "=DAY(A2)"

# Days between two dates
ws["F2"] = "=B2-A2"

# Workdays only
ws["G2"] = "=NETWORKDAYS(A2,B2)"

# End of month
ws["H2"] = "=EOMONTH(A2,0)"

# First day of next month
ws["I2"] = "=EOMONTH(A2,0)+1"
```

## Text handling

```python
# Concatenation — use TEXTJOIN for lists, & for two-three parts
ws["B2"] = '=A2&" - "&C2'
ws["B2"] = '=TEXTJOIN(", ",TRUE,D2:F2)'

# Case
ws["C2"] = "=UPPER(A2)"
ws["C2"] = "=PROPER(A2)"

# Trim double spaces
ws["D2"] = "=TRIM(A2)"

# Split on delimiter (Excel 365)
ws["E2"] = '=TEXTSPLIT(A2,",")'

# Substring
ws["F2"] = "=LEFT(A2,3)"
ws["G2"] = "=MID(A2,5,3)"
```

## Array formulas & spills (Excel 365)

```python
# A single formula that fills a vertical range
ws["B2"] = "=UNIQUE(A2:A500)"
ws["C2"] = "=SORT(UNIQUE(A2:A500))"
ws["D2"] = '=FILTER(A2:A500,B2:B500="confirmed")'
ws["E2"] = "=SEQUENCE(12,1,1,1)"        # 12×1 range 1..12
```

Spill ranges live in a single cell; Excel extends them automatically. Don't fight them with pre-filled rows.

## Number format cookbook

| Context                | Format string                   | Renders                      |
| ---------------------- | ------------------------------- | ---------------------------- |
| Integer with thousands | `"#,##0"`                       | `1,234`                      |
| Signed delta           | `"+#,##0;-#,##0;0"`             | `+42` / `-42` / `0`          |
| Thousands with unit    | `"#,##0 \"t\""`                 | `1,234 t`                    |
| EUR money              | `"#,##0.00 €"`                  | `1 234,56 €`                 |
| USD money              | `"$#,##0.00"`                   | `$1,234.56`                  |
| Negative money in red  | `"#,##0.00 €;[Red]-#,##0.00 €"` | red for negatives            |
| Decimal (4 digits)     | `"0.0000"`                      | `0.1234`                     |
| Percent 1 decimal      | `"0.0%"`                        | `12.3%`                      |
| Percent signed         | `"+0.0%;-0.0%;0.0%"`            | `+12.3%` / `-12.3%` / `0.0%` |
| Date ISO               | `"yyyy-mm-dd"`                  | `2026-04-21`                 |
| Date US                | `"mm/dd/yyyy"`                  | `04/21/2026`                 |
| Date compact           | `"dd mmm yy"`                   | `21 Apr 26`                  |
| Time                   | `"hh:mm:ss"`                    | `14:05:09`                   |
| Duration > 24h         | `"[h]:mm"`                      | `31:30`                      |
| Scientific             | `"0.00E+00"`                    | `1.23E+03`                   |
| Custom unit            | `"0.0 \"kg\""`                  | `3.5 kg`                     |
| Phone US               | `"(000) 000-0000"`              | `(415) 555-0100`             |

Apply to a whole column:

```python
for cell in ws["F"][1:]:         # skip header
    cell.number_format = "#,##0.00 €"
```

## Conditional formatting

```python
from openpyxl.formatting.rule import CellIsRule, ColorScaleRule
from openpyxl.styles import PatternFill

# Red fill when value < 0
red = PatternFill("solid", fgColor="F8CBAD")
ws.conditional_formatting.add(
    "D2:D500",
    CellIsRule(operator="lessThan", formula=["0"], fill=red),
)

# Green→yellow→red color scale over a range
ws.conditional_formatting.add(
    "E2:E500",
    ColorScaleRule(
        start_type="min", start_color="63BE7B",
        mid_type="percentile", mid_value=50, mid_color="FFEB84",
        end_type="max", end_color="F8696B",
    ),
)
```

## Freezing, hiding, and protecting

```python
ws.freeze_panes = "A2"                      # header row
ws.freeze_panes = "B2"                      # header row + first column
ws.column_dimensions["F"].hidden = True     # hide a helper column
ws.row_dimensions[1].height = 24            # taller title row
ws.sheet_properties.tabColor = "1F4E78"     # colored tab
```

Protection (read-only except chosen cells):

```python
from openpyxl.styles import Protection
ws.protection.sheet = True                  # turn it on
ws["B2"].protection = Protection(locked=False)   # unlock one input cell
```

## Charts in openpyxl (embedded)

For simple embedded charts (bar/line/pie), openpyxl has a `chart` module. For richer charts, prefer the `data-viz` skill to produce a PNG and embed it with `ws.add_image`.

```python
from openpyxl.chart import BarChart, Reference

chart = BarChart()
chart.title = "Shipments by carrier"
chart.y_axis.title = "Volume"
chart.x_axis.title = "Carrier"
data = Reference(ws, min_col=2, min_row=1, max_col=2, max_row=ws.max_row)
cats = Reference(ws, min_col=1, min_row=2, max_row=ws.max_row)
chart.add_data(data, titles_from_data=True)
chart.set_categories(cats)
ws.add_chart(chart, "E2")
```
