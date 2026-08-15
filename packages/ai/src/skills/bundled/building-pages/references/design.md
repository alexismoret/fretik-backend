# Design

You are not designing a brand. The product around your page already has one — typefaces, palette, radius, dark mode — and it is pushed into your page live. Do not re-pick any of it, and never write a hex or a raw `gray-500`.

That constraint frees your whole design budget for the axes that actually decide whether a screen is good: **what appears, where, at what size, next to what, and in what order.** Spend it deliberately, on this subject and this question. A layout that would work equally well over any other dataset is a template, not a design.

## Composition

**The shape follows the question.** Decide which one you are building before writing a line:

| What the user is really asking | Shape                                                                                          |
| ------------------------------ | ---------------------------------------------------------------------------------------------- |
| "How are we doing?"            | **Overview** — headline figures, then the one view that explains them, then the rows behind it |
| "Find the one that…"           | **Directory** — filters and search on top, dense list underneath, detail in a slideover        |
| "Work through these"           | **Master–detail** — the queue on the left, the selected item filling the right                 |
| "Do the thing"                 | **Console** — the action panel beside the state it acts on                                     |
| "What happened, and when"      | **Feed** — a timeline, grouped, newest first                                                   |

Then hold to these:

- **One page, one subject.** A page about deals shows deals. Add contacts, tasks and a calendar at equal weight and it has no subject; every section competes for the same attention and none wins.
- **The answer comes first.** The most important figure, state or row is visible before any scrolling. Everything else earns its place below it. If the top of your page is a title and a row of grey boxes, the answer is not on screen.
- **Fill the frame, but cap the line.** The page owns the app's whole content area. Cap prose and forms around `max-w-3xl` for readability; let tables and boards run wide. A narrow column floating in a wide frame reads as broken.
- **One vertical rhythm.** Pick `space-y-6` (calm) or `space-y-4` (dense) for the page and let sections differ by weight, not by ad-hoc margins.
- **Every region is sized by its content**, never the reverse. Give any drawn region — a chart, a map, a preview — an explicit height and let its container wrap it.
- **Unbounded content gets a bounded viewport.** Rows, a feed, a log, a long panel have no natural size — they are whatever the query returned today. Give that region a fixed height, scroll inside it, and pin whatever orients the reader to its edge. A region that grows with its data pushes everything below it off the screen and scrolls its own headings away.

## Space

Empty space is an instrument, and it only works when it is deliberate:

- **Passive space** is structural — gutters, margins, line spacing. Regular, and never noticed.
- **Active space** is emphasis — spent deliberately around one element so the eye lands there.
- **Orphaned space** is neither: a region that ended up large for a reason unrelated to its content. A reader cannot tell it apart from a component that failed to load, and it is the loudest signal that a screen was generated rather than designed.

Orphaned space almost always comes from a container sized by a sibling rather than by itself — cards in a row stretching to the tallest, a column taking the height of the fullest, a height chosen for content that has since shrunk. So the fix is never "add something to fill it". Diagnose, then choose in this order:

1. **Rebalance.** Thin content deserves a small region: let content determine size, give the larger area to the denser material, let a short block stay short. Reflowing costs nothing and beats padding every time.
2. **Deepen — only if the space is genuinely worth having.** A large region earns its size by answering the reader's next question: one level down (what makes up the figure beside it), a comparison (small multiples — the same chart per category, which is what wide space is actually good for), a ranking (the few rows driving the number), or a trend.
3. **Merge or drop.** If neither holds, it was never a region.

Decoration never counts as filling — no illustration, no oversized icon, no gradient, no restatement of a figure already on screen. Space doing no work is better empty and small than full of filler. The inverse fails too: a dense region with no passive space around it is unreadable. Space is a budget, not a leftover.

## Hierarchy

Three levels per screen, no more: the answer, the evidence, the detail. Make the difference obvious in size and weight rather than in colour.

- Page title `text-2xl font-display tracking-tight`, plus one line of `text-sm text-muted` saying what the page is FOR — not what it contains.
- Section heading `text-sm font-medium text-highlighted`, with a count beside it when a count is informative.
- Figures in `font-display tabular-nums`, sized by importance. `tabular-nums` on every column of numbers, always — proportional digits make columns ragged.
- Small uppercase labels (`text-xs uppercase tracking-wide text-muted`) are a seasoning. Three is a pattern; twelve is noise.

## Make every element carry information

This is where most generated screens fail: they render values correctly and mean nothing.

- **A figure needs a comparison.** A number alone cannot be judged. Give it the one comparison that makes it actionable — against the previous period, against the total, against a target, or against its own history. If no comparison exists, it is a line of text, not a headline.
- **Structure should encode something true.** Numbered markers, eyebrows, dividers and groupings are claims about the content. Number things only when order matters; group things only when the grouping is real. Decorative structure is worse than none.
- **Sort and group by what the reader acts on**, not by what the database returned first.
- **Show the shape of the data, not just its rows.** A distribution, a trend or a share communicates in one glance what fifty rows do not — but only when the rows behind it stay reachable.
- **Truncate honestly.** Long values get `truncate` plus the full value in a tooltip or the detail panel, never a silently cut string.

## Colour

Two palettes, and the difference decides everything:

- **The chrome — surfaces, text, borders, buttons, states — uses semantic tokens only**: `text-default` `text-muted` `text-dimmed` `text-toned` `text-highlighted`, `bg-default` `bg-elevated` `bg-accented` `bg-muted`, `border-default` `border-muted` `border-accented`, and the `primary` / `success` / `warning` / `error` / `neutral` scales. Never a hex or a raw hue here: this is what keeps the page correct in both light and dark mode without you thinking about it.
- **Surfaces are a hierarchy, not a palette.** `bg-default` is the page, and anything sitting ON the page shares it — a card is set apart by its border and its spacing, not by a fill. The raised tokens are a claim that something floats above the page or is currently active: an overlay, a hover, a selected row, one deliberately lifted unit. Give every container the same raised grey and nothing is above anything — you get a field of grey slabs, which is the most recognisable signature of a generated screen. Where a region really must lift, tint rather than fill (`bg-elevated/40`), and keep one level of elevation per screen.
- **The data brings its own colours, and they are meant to be used.** Categories, statuses, types and owners carry a colour and often an icon in the schema, and the full palette is live in the runtime — bound as CSS variables, since a class name cannot be assembled at runtime (`references/data.md` § Colour and icons). A page that renders every category in grey has thrown away the product's own visual language and reads as a report, not a screen. Reserve neutral for values that genuinely have no colour.
- **One value, one colour, everywhere on the page** — cell, chart segment, legend, filter chip. A category that changes colour between two regions of the same screen is worse than no colour at all.
- **`primary` is scarce** — the one action that matters, and at most one figure. It is the app's accent, not a category colour; never use it to mean a data value.
- **Never let colour carry meaning alone.** Pair it with an icon, a label or a position.

## Motion

Restraint reads as quality; scattered animation reads as generated. Prefer one orchestrated moment — a staggered reveal of the first band, a smooth height change when a detail opens — over five small effects. Everything else is plain state feedback: `transition-colors` on hover, a row that lifts on hover, a skeleton that swaps in place. Never re-animate a chart on every refetch; update it in place.

## Interaction

A page that only displays is a screenshot. The gap between "it shows the data" and "the team works in it" is almost entirely made of small, cheap affordances — and a page missing them feels thin no matter how well it is laid out.

- **Detail on demand.** Anything summarised somewhere should be openable in full somewhere else, without leaving the page.
- **The target is the whole item.** When clicking something opens it, the row — the card, the list item — takes the click, not a word inside it. A small live target inside a large inert surface is both slow to hit and undiscoverable: nothing tells the reader which few pixels respond. Give the container the click, a hover state and a pointer cursor, and let the inner controls that do something _else_ stop the event.
- **Controls over every dimension worth slicing.** One filter on a subject with eight meaningful attributes is an unfinished page; so is fifteen filters. Choose the ones a person would actually use to narrow their work, and give each one a visible current state and a way back to "all".
- **At least one verb.** Something must be doable here — an action on a record, a form to add one, a copy, an export, a link into the rest of the product. A page with no verb sends the user back to chat to do the actual work.
- **Ordering under the reader's control** where more than a handful of items are shown.
- **Visible freshness** — a way to refresh, and a refetch that dims rather than blanks.
- **Every state designed** — loading, populated, empty, failed. An empty box and a raw error string are both unfinished.
- **Depth where the subject has depth.** If the data supports more than one useful view, build more than one and let the user switch, rather than picking one and discarding the rest.

Ambition is part of the brief: when in doubt between shipping one more real capability and shipping one more decorative block, ship the capability.

## Copy

Words are design material; write them with the same care as spacing.

- Name things as the user names them, never as the system stores them. Labels come from the data's own field labels.
- Active voice on every control: "Mark won", not "Submit". An action keeps its name through the whole flow — the button that says "Publish" produces a toast that says "Published".
- Errors say what happened and what to do about it. They do not apologise and they are never vague.
- An empty state is an invitation to act, not a shrug.
- Sentence case, no filler, no exclamation marks. Each element does one job: a label labels, an example demonstrates.

## Self-critique

You never see the rendered page — no screenshot, no browser, and nobody downstream will fix it. This pass replaces your eyes. Run it against your own source before saving.

1. **Template test** — would this exact layout work for a completely different dataset? Then it encodes nothing about this one. Rework the top band.
2. **Fold test** — list what is visible in the first screen. Is the user's actual question answered there?
3. **Raw-value hunt** — find every interpolation of a record field in your template. Each must pass through a label, a formatter or a component. Raw keys, objects and ISO timestamps reaching a user are bugs.
4. **Meaning audit** — for each figure on the page, name its comparison. Any figure without one either gets one or gets demoted.
5. **Container audit** — count your bordered containers, then count the distinct fills across them. Delete the ones that group nothing; if they all carry the same raised grey, drop the fill and keep the border.
6. **Orphaned-space check** — for every region, is its size set by its own content or by a neighbour? Anything sized by a sibling gets rebalanced, deepened or merged.
7. **Four states** — for every dataset, find loading, populated, empty and failed in your source.
8. **Schema test** — reread the page assuming the data has moved: a category that was empty now dominates, a field that was uniform now varies. Anything that would look broken or would silently disappear was built from today's rows instead of from the schema.
9. **Colour test** — how many of the page's coloured elements take their colour from the data? If the answer is none, the schema's own palette is being wasted.
10. **Overflow test** — for every region, name what happens when its content exceeds it, on BOTH axes. Growing without limit, truncating silently and a bare "+N" are three dead ends.
11. **Verb check** — name one thing the user can do here, and the exact element they click to do it. If there is none, add detail-on-demand at minimum; if the target is smaller than the thing it opens, move it up to the container.
12. **Accent count** — more than two `primary` elements means the page has no focus.
