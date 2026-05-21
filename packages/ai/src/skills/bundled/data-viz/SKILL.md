---
name: data-viz
description: Render data as a chart (PNG via matplotlib) saved to the sandbox and surfaced inline in the chat. Use when a visual answer (trend, comparison, distribution, KPI) carries the message better than a numeric table.
---

# data-viz skill

Render a single-purpose chart that answers one question visually. Save as PNG at 2× pixel density so it looks sharp in the chat, then call `presentFiles` — the frontend renders PNGs **inline** as a preview image, not as a download card.

## When to use this skill

Trigger on: "chart", "graph", "graphique", "courbe", "camembert", "histogramme", "diagram", "diagramme", "plot", "visualise", "show me visually", "trace", "compare these two months/categories/vendors", and any question where the answer is a trend or a comparison (both are visually obvious, tedious in text).

Don't use for: a single number ("how many invoices in March?" — reply in text), a formatted table of many rows (→ `xlsx`), or a layout-critical print deliverable (→ `pdf`).

## Tool: matplotlib — always

Use matplotlib. It's in the sandbox, it's deterministic, and everything renders server-side (no fonts to worry about). Don't pull in seaborn / plotly / bokeh.

```python
import matplotlib
matplotlib.use("Agg")           # non-interactive backend — required, no display
import matplotlib.pyplot as plt

fig, ax = plt.subplots(figsize=(8, 4.5), dpi=160)

months = ["Oct", "Nov", "Dec", "Jan", "Feb", "Mar"]
revenue = [482000, 496000, 514000, 502000, 527000, 548700]

ax.plot(months, revenue, marker="o", linewidth=2, color="#1F4E78")
ax.set_title("Monthly revenue — last 6 months", loc="left", pad=10)
ax.set_ylabel("€")
ax.grid(True, axis="y", linestyle="--", linewidth=0.5, alpha=0.6)
ax.spines["top"].set_visible(False)
ax.spines["right"].set_visible(False)

# Value labels on top of each marker
for x, y in zip(months, revenue):
    ax.annotate(f"{y:,}", (x, y), textcoords="offset points",
                xytext=(0, 8), ha="center", fontsize=9, color="#222222")

# Source line — one short italic gray line bottom-left
fig.text(
    0.01, 0.01,
    "Source: querySql — invoices, as of 2026-04-21.",
    fontsize=8, style="italic", color="#808080",
)

fig.tight_layout()
fig.savefig("revenue-last-6-months.png", dpi=160, bbox_inches="tight")
plt.close(fig)
print("saved revenue-last-6-months.png")
```

Then hand off:

```
presentFiles({ paths: ["revenue-last-6-months.png"] })
```

The frontend detects `image/png` and renders it **inline as a preview image** inside the chat bubble (click to expand, download overlay on hover). **Do NOT pass a `message` when presenting only images** — the image speaks for itself; a caption would look redundant. Reserve `message` for mixed / document outputs.

## Chart selection: one chart per question

| Question                                                 | Chart                                                      | Notes                                               |
| -------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------- |
| How did X change over time?                              | Line                                                       | One line per series; ≤ 4 series to stay readable.   |
| Compare X across categories                              | Vertical bar                                               | Sort bars descending unless time order matters.     |
| Compare X across categories, long labels (country names) | Horizontal bar                                             | Readable labels without rotation.                   |
| Share of total (few categories, ≤ 5)                     | Pie, or better: horizontal bar with share labels           | Pies hurt comparison; prefer bars when possible.    |
| Relation between two variables                           | Scatter                                                    | Add a trend line if it's informative.               |
| X across both time and category                          | Grouped bar, or small multiples (one subplot per category) | Don't stack bars unless the total is the point.     |
| Composition of X over time                               | Stacked area                                               | Only when total matters; otherwise small multiples. |
| Distribution                                             | Histogram or box plot                                      | Histogram for one group; box for comparing groups.  |

## Styling: the palette

Use these colors in this priority order (first color = single-series default, two colors = two-series default, etc.):

```python
PALETTE = [
    "#1F4E78",   # primary deep blue
    "#C0504D",   # muted red
    "#548235",   # muted green
    "#E57A2C",   # muted orange
    "#7E5AA2",   # muted purple
    "#2E75B6",   # accent blue
    "#808080",   # gray (for an "Other" / residual bucket)
]
```

For sequential / ordinal data (e.g. "low / mid / high"), use a color gradient from `#D9E2EC` → `#1F4E78`. For diverging data (positive vs. negative), use `#548235` for positive and `#C0504D` for negative.

## Size and resolution

- Default figure: `figsize=(8, 4.5)` (16:9), `dpi=160` → ~1280×720 px, looks sharp even on retina displays.
- Full-width wide chart: `figsize=(10, 4)` → ~1600×640 px. Use for long time series.
- Square small multiples: `figsize=(6, 6)` → ~960×960 px.
- Always `fig.tight_layout()` before saving. Always `bbox_inches="tight"` on `savefig`. `plt.close(fig)` after saving is good hygiene — the Python kernel persists across calls in a conversation, so unclosed figures accumulate in memory across many calls.

## Labels, titles, annotations

- **Title**: short, declarative, left-aligned (`ax.set_title("...", loc="left")`). Prefer a sentence ("Volume rose 14% YoY") over a topic label ("Monthly volume").
- **Axis labels**: units mandatory (`"TEU"`, `"€"`, `"days"`). Skip axis labels only when units are in the title.
- **Tick labels**: rotate x-ticks 30–45° if they overlap. Use `ax.tick_params(axis="x", labelrotation=35)`.
- **Value labels on bars/markers** for small data sets (≤ 12 points). Use `ax.annotate(...)` with `offset points` so placement is resolution-independent.
- **Grid**: horizontal only (`axis="y"`), dashed, 50% alpha. Never a full grid — it crowds the chart.
- **Spines**: hide top and right (`ax.spines["top"].set_visible(False)`, same for `right`). Keep bottom and left.
- **Legend**: only when there are multiple series. Place outside the plot area if the legend would occlude data (`ax.legend(loc="center left", bbox_to_anchor=(1, 0.5))`).

## Sources

Always include a source line. One short italic gray line, positioned at `(0.01, 0.01)` in figure coordinates:

```python
fig.text(0.01, 0.01, "Source: ...", fontsize=8, style="italic", color="#808080")
```

For multi-source charts, concatenate with `·` (middle dot) — don't stack multiple source lines vertically; it clutters the bottom.

## Chart recipes

### Bar chart — categories, sorted

```python
import matplotlib.pyplot as plt

vendors = ["Acme", "Globex", "Initech", "Umbrella", "Stark"]
spend   = [124000, 110200, 98500, 81200, 73400]

order = sorted(range(len(vendors)), key=lambda i: spend[i], reverse=True)
vendors = [vendors[i] for i in order]
spend   = [spend[i]   for i in order]

fig, ax = plt.subplots(figsize=(8, 4.5), dpi=160)
bars = ax.bar(vendors, spend, color="#1F4E78")
ax.set_title("Spend by vendor — March 2026", loc="left", pad=10)
ax.set_ylabel("€")
ax.spines["top"].set_visible(False)
ax.spines["right"].set_visible(False)
for bar, v in zip(bars, spend):
    ax.annotate(f"{v:,}", (bar.get_x() + bar.get_width() / 2, v),
                textcoords="offset points", xytext=(0, 6),
                ha="center", fontsize=9, color="#222222")
fig.tight_layout()
fig.savefig("spend-by-vendor-march-2026.png", dpi=160, bbox_inches="tight")
plt.close(fig)
```

### Grouped bar — compare two series across categories

```python
import numpy as np
import matplotlib.pyplot as plt

categories = ["Acme", "Globex", "Initech", "Umbrella", "Stark"]
feb = [110000, 105000,  94000, 79000, 70000]
mar = [124000, 110200,  98500, 81200, 73400]

x = np.arange(len(categories))
w = 0.38

fig, ax = plt.subplots(figsize=(9, 4.5), dpi=160)
ax.bar(x - w/2, feb, w, label="Feb 2026", color="#2E75B6")
ax.bar(x + w/2, mar, w, label="Mar 2026", color="#1F4E78")
ax.set_xticks(x, categories)
ax.set_ylabel("€")
ax.set_title("Vendor spend — Feb vs Mar 2026", loc="left", pad=10)
ax.legend(frameon=False)
ax.spines["top"].set_visible(False)
ax.spines["right"].set_visible(False)
fig.tight_layout()
fig.savefig("vendor-spend-feb-vs-mar.png", dpi=160, bbox_inches="tight")
plt.close(fig)
```

### Line — trend, one or multiple series

```python
import matplotlib.pyplot as plt

months = ["Oct", "Nov", "Dec", "Jan", "Feb", "Mar"]
acme    = [ 98000, 102000, 111000, 105000, 110000, 124000]
globex  = [ 92000,  96000, 100000,  98000, 105000, 110200]
initech = [ 83000,  86000,  88000,  89000,  94000,  98500]

fig, ax = plt.subplots(figsize=(9, 4.5), dpi=160)
for label, series, color in [
    ("Acme",    acme,    "#1F4E78"),
    ("Globex",  globex,  "#C0504D"),
    ("Initech", initech, "#548235"),
]:
    ax.plot(months, series, marker="o", linewidth=2, label=label, color=color)
ax.set_title("Top 3 vendors — monthly spend (€)", loc="left", pad=10)
ax.set_ylabel("€")
ax.grid(True, axis="y", linestyle="--", linewidth=0.5, alpha=0.6)
ax.spines["top"].set_visible(False)
ax.spines["right"].set_visible(False)
ax.legend(frameon=False, loc="upper left")
fig.tight_layout()
fig.savefig("top-3-vendors-6m.png", dpi=160, bbox_inches="tight")
plt.close(fig)
```

### Horizontal bar — long labels

```python
import matplotlib.pyplot as plt

countries = ["United States", "United Kingdom", "Germany", "France", "Spain", "Italy"]
counts    = [87, 71, 62, 48, 41, 34]

fig, ax = plt.subplots(figsize=(8, 4.5), dpi=160)
ax.barh(countries[::-1], counts[::-1], color="#1F4E78")   # reverse so largest is top
ax.set_title("Clients by country — March 2026", loc="left", pad=10)
ax.set_xlabel("Clients")
ax.spines["top"].set_visible(False)
ax.spines["right"].set_visible(False)
for i, v in enumerate(counts[::-1]):
    ax.annotate(f"{v}", (v, i), textcoords="offset points",
                xytext=(4, 0), va="center", fontsize=9, color="#222222")
fig.tight_layout()
fig.savefig("clients-by-country-march-2026.png", dpi=160, bbox_inches="tight")
plt.close(fig)
```

### Small multiples — one chart per vendor

```python
import matplotlib.pyplot as plt

months = ["Oct", "Nov", "Dec", "Jan", "Feb", "Mar"]
series = {
    "Acme":     [ 98000, 102000, 111000, 105000, 110000, 124000],
    "Globex":   [ 92000,  96000, 100000,  98000, 105000, 110200],
    "Initech":  [ 83000,  86000,  88000,  89000,  94000,  98500],
    "Umbrella": [ 70000,  74000,  76000,  75000,  79000,  81200],
}

fig, axes = plt.subplots(2, 2, figsize=(9, 5), dpi=160, sharex=True, sharey=True)
for ax, (name, vals) in zip(axes.flat, series.items()):
    ax.plot(months, vals, marker="o", linewidth=1.8, color="#1F4E78")
    ax.set_title(name, loc="left", fontsize=11)
    ax.grid(True, axis="y", linestyle="--", linewidth=0.5, alpha=0.5)
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
fig.suptitle("Monthly spend by vendor — 6-month trend", x=0.01, ha="left",
             fontsize=13)
fig.tight_layout(rect=[0, 0.02, 1, 0.97])
fig.savefig("small-multiples-6m.png", dpi=160, bbox_inches="tight")
plt.close(fig)
```

## Code style

- One chart per call. If the user asked for "a few charts", produce them in sequence and `presentFiles` all their paths at once.
- `matplotlib.use("Agg")` before importing `pyplot`. We're headless. The kernel is stateful across calls, so call this **once** per conversation (no need to repeat it in every cell).
- `plt.close(fig)` after saving is good hygiene — figures accumulate in the persistent kernel otherwise. Not a hard requirement for one-off charts, but matters when a conversation produces many.
- Filename: kebab-case, descriptive, date-suffixed if the content is time-sensitive (`spend-by-vendor-march-2026.png`). Always `.png`.
- `plt.show()` is OK now — the kernel is Jupyter, so the PNG is captured into `richResults` and auto-saved under `outputs/results/`. Use it when you want to inspect the chart yourself before deciding whether to ship it via `presentFiles`. For final deliverables, prefer an explicit `savefig` to a known path under `outputs/` — that way the path is stable and `presentFiles` can reference it.

## Reusable helpers

`scripts/viz_helpers.py` ships:

- `apply_house_style(ax)` — hides top/right spines, draws the dashed horizontal grid.
- `add_source(fig, text)` — italic gray source line at the canonical position.
- `annotate_bars(ax, bars, values, fmt="{:,}")` — value labels on top of each bar.
- `save_and_close(fig, filename, dpi=160)` — tight layout + savefig + close in one call.

Import:

```python
import sys; sys.path.insert(0, "skills/data-viz/scripts")
import viz_helpers as vz

fig, ax = plt.subplots(figsize=(8, 4.5), dpi=160)
ax.bar(vendors, spend, color="#1F4E78")
vz.apply_house_style(ax)
vz.add_source(fig, "Source: querySql — invoices, as of 2026-04-21.")
vz.save_and_close(fig, "spend-by-vendor.png")
```

## Common pitfalls

- **Text too small when displayed inline.** Bump `figsize` (wider) or set `fontsize=12` on labels. The frontend renders at max 384px tall — anything below 16:9 gets hard to read.
- **Legend overlaps data.** Move it outside with `bbox_to_anchor=(1.02, 1)` and add `fig.tight_layout()` + explicit `subplots_adjust(right=0.75)`.
- **Too many colors.** Don't auto-assign — use the palette explicitly. More than 5 series on one chart is unreadable.
- **Bars touching.** Use the default bar `width=0.8`; don't override unless you're doing grouped bars.
- **Font warnings at savefig.** Harmless, but noisy. Suppress with `warnings.filterwarnings("ignore", category=UserWarning)`.
- **Chart shows but data is wrong.** Verify the data upstream with a `print(df.head())` / `print(list(zip(x, y)))` before plotting. A wrong chart is worse than no chart.
- **Saving as SVG.** Only if the user explicitly asked. PNG is the default because the frontend renders `image/png` inline; SVG would also render but PNG is universally supported.

## Further reading

- `references/chart-choice.md` — decision tree for "what chart should I use" with worked examples.

Load via `read("skills/data-viz/references/chart-choice.md")` when a user's data shape is ambiguous.
