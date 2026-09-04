# Design

You are not designing a brand. The product around your page already has one — typefaces, palette, radius, dark mode — and it is pushed into your page live. Do not re-pick any of it, and never write a hex or a raw `gray-500`.

That constraint frees your whole design budget for the axes that actually decide whether a screen is good: **what appears, where, at what size, next to what, and in what order.** Spend it deliberately, on this subject and this question. A layout that would work equally well over any other dataset is a template, not a design.

## Composition

**The shape follows the question.** Name the shape in `brief.design.archetype` before writing a line — an unnamed screen defaults, and the default is a title, four equal cards and a table.

| What the reader came to do | Shape                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| "How are we doing?"        | **Cockpit** — the figure that answers it, then the view that explains it, then the rows    |
| "Find the one that…"       | **Directory** — filters and search on top, a dense list under them                         |
| "Work through these"       | **Workbench** — the queue held beside the item, both live, the selection driving the right |
| "Check the numbers"        | **Ledger** — one dense table that IS the page, sorted, totalled, sticky-headed             |
| "Where is everything?"     | **Board** — columns that are the real states, and moving between them is the action        |
| "What happened, and when"  | **Feed** — dated events on a rail, grouped, newest first                                   |
| "Do the thing"             | **Console** — the action panel beside the state it acts on, and the result below           |
| "Read this and decide"     | **Report** — a narrative down one column, figures inline, sections anchored                |
| "Get me through this"      | **Wizard** — one decision per step, the state of the whole visible throughout              |

These are starting points and not a menu: combine two (a cockpit band above a workbench is the most useful page most teams have), or name one they do not cover. What matters is that the shape was CHOSEN — write it down, in `archetype`, in your own words.

Then hold to these:

- **One page, one subject.** A page about deals shows deals. Add contacts, tasks and a calendar at equal weight and it has no subject; every section competes for the same attention and none wins.
- **The composition is decided whole, then split.** Files are how a page is maintained, never how it is designed: choose the shape, the order and the weight of every region on the finished screen first, and only then cut it into components, each arriving with its place already assigned. A component designed on its own comes out a self-contained card — its own border, its own title, its own padding — and a page of those is a grid of boxes with no hierarchy, which reads worse than the same page written in one file. Regions of one composition share edges and alignment; they do not each announce themselves.
- **The answer comes first.** The most important figure, state or row is visible before any scrolling. Everything else earns its place below it. If the top of your page is a title and a row of grey boxes, the answer is not on screen.
- **Fill the frame, but cap the line.** The page owns the app's whole content area. Cap prose and forms around `max-w-3xl` for readability; let tables and boards run wide. A narrow column floating in a wide frame reads as broken.
- **Every region is sized by its content**, never the reverse. Give any drawn region — a chart, a map, a preview — an explicit height and let its container wrap it.
- **Unbounded content gets a bounded viewport.** Rows, a feed, a log, a long panel have no natural size — they are whatever the query returned today. Give that region a fixed height, scroll inside it, and pin whatever orients the reader to its edge. A region that grows with its data pushes everything below it off the screen and scrolls its own headings away.

## Grid and proportion

A stack of full-width sections is the layout you get when none was chosen. Decide the columns, then the spans, and write both in `brief.design.grid`.

- **Twelve columns, one gutter.** `grid grid-cols-12 gap-4` (or `gap-6` when calm) is enough for every page here. Regions take spans: `col-span-8` + `col-span-4` for a subject with a rail, `col-span-7` + `col-span-5` when the two are nearly peers, `col-span-3` × 4 for a band of figures. Uneven spans are the point — 6/6 says the two halves matter equally, and they rarely do.
- **A grid when the rows must line up, a flex column when they must not.** Regions of different heights in a row will stretch to the tallest one, which is where orphaned space comes from; `items-start` or a grid with explicit row spans stops it.
- **The rail.** One narrow column beside the subject — filters, a summary, related records, a table of contents — is the shape most pages want and almost none build. `UPage` with `#left`/`#right` takes a `UPageAside` and makes it sticky; `USidebar` is the same thing standing alone. Around `w-64` to `w-80`; more than that and it competes with the subject.
- **Three widths, and only three.** The page is captured and judged at 1280, 1024 and 390. At 1024 a four-across band becomes two-across (`grid-cols-2 lg:grid-cols-4`); at 390 every multi-column region is one column and the wide region scrolls inside itself. A layout with no `lg:` in it was written for one width.
- **Full-bleed earns its width.** A band that runs the whole frame above a narrower body is one of the few moves that reads as designed rather than assembled — use it once, for the thing the page is about.

## Density

How tightly the screen is packed is a decision about the reader, and it belongs in `brief.design.density`. An operator triaging a queue and a manager reading a summary do not want the same page.

- **Compact** — `size="sm"` on tables, buttons, inputs and badges; `space-y-3`/`gap-3`; twelve or more rows visible without scrolling. Right whenever the reader's job is to scan, compare or work through a list. Most working screens are this, and almost no generated one is.
- **Comfortable** — the defaults, `space-y-4`/`space-y-6`. Right for a mixed page somebody reads a few times a day.
- **Spacious** — `size="lg"`, `space-y-8`, one thing per band. Right for a report or a single decision, and wrong the moment there is a list.

Pick one and hold it: a page whose table is compact and whose form is spacious reads as two pages stapled together. Density is not the same as clutter — a dense screen with a firm grid and one clear hierarchy is easier to work in than a sparse one with neither.

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

Three levels per screen, no more: the answer, the evidence, the detail. Make the difference obvious in size and weight rather than in colour, and say which is which in `brief.design.hierarchy` — in sizes and shares, because "clear hierarchy" is true of every layout its author has just finished.

The scale, so the difference is a decision and not a nudge:

| Role                             | Type                                                                                               |
| -------------------------------- | -------------------------------------------------------------------------------------------------- |
| The one figure the page is about | `text-4xl` or `text-5xl font-display tabular-nums tracking-tight`                                  |
| Page title                       | `text-2xl font-display tracking-tight` + one `text-sm text-muted` line saying what the page is FOR |
| Supporting figures               | `text-xl` / `text-2xl font-display tabular-nums`                                                   |
| Section heading                  | `text-sm font-medium text-highlighted`, with a count when it informs                               |
| Body and cells                   | the default; `text-sm` when the density is compact                                                 |
| Eyebrow                          | `text-xs uppercase tracking-wide text-muted` — three per page is a pattern, twelve is noise        |

**One step, not three.** A page where the headline figure is `text-xl` and the supporting ones are `text-lg` has no hierarchy, only a gradient. The lead should be two or three times the size of what sits beside it, and there should be exactly one of it. `tabular-nums` on every column of numbers, always — proportional digits make columns ragged.

## Make every element carry information

This is where most generated screens fail: they render values correctly and mean nothing.

- **A figure needs a comparison.** A number alone cannot be judged. Give it the one comparison that makes it actionable — against the previous period, against the total, against a target, or against its own history. If no comparison exists, it is a line of text, not a headline.
- **Structure should encode something true.** Numbered markers, eyebrows, dividers and groupings are claims about the content. Number things only when order matters; group things only when the grouping is real. Decorative structure is worse than none.
- **Sort and group by what the reader acts on**, not by what the database returned first.
- **Show the shape of the data, not just its rows.** A distribution, a trend or a share communicates in one glance what fifty rows do not — but only when the rows behind it stay reachable.
- **Nothing is cut off silently.** A value a person is not allowed to finish reading is a value you did not show.

## Colour

Two palettes, and the difference decides everything:

- **The chrome — surfaces, text, borders, buttons, states — uses semantic tokens only**: `text-default` `text-muted` `text-dimmed` `text-toned` `text-highlighted`, `bg-default` `bg-elevated` `bg-accented` `bg-muted`, `border-default` `border-muted` `border-accented`, and the `primary` / `success` / `warning` / `error` / `neutral` scales. Never a hex or a raw hue here: that is what keeps the page correct in both modes without you thinking about it, and the build scans every file for one. The shape that hides best is a lookup mapping your categories to class strings — a private second copy of a schema that already carries a colour.
- **Surfaces are a hierarchy, not a palette.** `bg-default` is the page, and anything sitting ON it shares it — a card is set apart by its border and its spacing, not by a fill. The raised tokens claim that something floats above the page or is active: an overlay, a hover, a selected row, one deliberately lifted unit. Give every container the same raised grey and nothing is above anything. Where a region must lift, tint rather than fill (`bg-elevated/40`), one level per screen.
- **The data brings its own colours, and they are meant to be used.** Categories, statuses, types and owners carry a colour and often an icon in the schema, and the full palette is live in the runtime — bound as CSS variables, since a class name cannot be assembled at runtime (`references/data.md` § Colour and icons). A page that renders every category in grey has thrown away the product's own visual language and reads as a report, not a screen. Reserve neutral for values that genuinely have no colour.
- **One value, one colour, everywhere on the page** — cell, chart segment, legend, filter chip. A category that changes colour between two regions of the same screen is worse than no colour at all.
- **One dimension per row leads; the others are text.** A row carries several — status, priority, team, owner — and colouring them all makes them compete until none reads: a line of pale badges is a wash the eye skims. Pick the dimension the page is FOR, give it the badge and the schema's colour, set the rest in plain text. A question of rank, not quantity — the answer to a washed-out row is one fewer thing asking to be looked at.
- **`primary` is scarce** — the one action that matters, and at most one figure. It is the app's accent, not a category colour; never use it to mean a data value.
- **Never let colour carry meaning alone.** Pair it with an icon, a label or a position.

## Where depth opens

Every page has more to say than fits, and the question is where the rest goes. Answer it once, in `brief.design.containers`, for each kind of depth the page holds — because the reflex answer is a slideover for everything, and a page where every detail opens the same panel has decided nothing.

Ask in this order:

1. **Does the reader need what is on screen while they look?** No, and it is long or rich → its own view. No, and it must be finished or abandoned → `UModal`. Yes → keep going.
2. **How much is there?** A word or a date → `UTooltip`. A small block, a mini-form, a filter → `UPopover`. A whole record → `USlideover`, which is what keeps the list in sight while you read one of its rows.
3. **How often?** Ten times a session — editing a status, assigning an owner — and it goes INLINE: in the row, in a `UDropdownMenu` on the row, in place. An overlay per repetition is a page that fights its own reader.
4. **Is there an identity somebody would send to a colleague?** Then it is a view of its own even when a panel would have fit — a link to "the deal" is worth more than a slightly quicker panel.

A modal is an interruption and costs the reader their place; spend it on decisions that must not be half-made, never on showing information. Never on an error, never on onboarding, never on a long form.

## Motion

Restraint reads as quality; scattered animation reads as generated. Prefer one orchestrated moment — a staggered reveal of the first band, a smooth height change when a detail opens — over five small effects. Everything else is plain state feedback: `transition-colors` on hover, a row that lifts on hover, a skeleton that swaps in place. Never re-animate a chart on every refetch; update it in place.

What is available without a library: `<Transition>` and `<TransitionGroup>` (a list that re-sorts should move, not jump), Tailwind's `transition-*`/`duration-*`/`animate-*`, and `useTransition` from `@vueuse/core` for a figure that counts up once on load. Wrap anything that moves on its own in `motion-safe:` — a reader who asked their system for less motion is asking you.

## Interaction

A page that only displays is a screenshot. The gap between "it shows the data" and "the team works in it" is almost entirely made of small, cheap affordances — and a page missing them feels thin no matter how well it is laid out.

- **Detail on demand.** Anything summarised somewhere should be openable in full somewhere else, without leaving the page.
- **The target is the whole item**, not a word inside it. A small live target in a large inert surface is slow to hit and undiscoverable — nothing tells the reader which few pixels respond.
- **Controls over every dimension worth slicing.** One filter on a subject with eight meaningful attributes is an unfinished page; so is fifteen filters. Choose the ones a person would actually use to narrow their work, and give each one a visible current state and a way back to "all".
- **At least one verb.** Something must be doable here — an action on a record, a form to add one, a copy, an export, a link into the rest of the product. A page with no verb sends the user back to chat to do the actual work.
- **Ordering under the reader's control** where more than a handful of items are shown.
- **Visible freshness** — a way to refresh, and a refetch that dims rather than blanks.
- **The empty and failed states are designed too.** An empty box and a raw error string are both unfinished; the four outcomes themselves are in `references/data.md`.
- **Depth where the subject has depth.** If the data supports more than one useful view, build more than one and let the user switch, rather than picking one and discarding the rest.

Ambition is part of the brief: when in doubt between shipping one more real capability and shipping one more decorative block, ship the capability.

### The floor

Nobody asks for these, and a page without them reads as a first draft. They are the baseline a page is expected to clear before anything it was actually asked for counts as delivered — countable on purpose, so "is this finished" has an answer:

- **A filter over the dimension the page is for**, wired as a variable so it re-queries, from about twenty rows; a text search from about thirty; a clickable sort on the columns whose descriptor says `sortable`; pagination whenever `totalCount` exceeds the page size.
- **A detail view for the entity being listed**, opening where § Where depth opens sends it, and — when the type is writable — at least one action inside it.
- **A writable type means a write.** Declare at least one `record` operation and CALL it from the code; a declared operation nothing runs is a page that still sends the user elsewhere to do the work.
- **A layout that groups by a changeable value is itself the control.** Columns for a status, lanes for an owner, cells for a date: when the arrangement encodes a field, moving an item between groups sets that field. Drawing that arrangement and then routing the change through a dropdown elsewhere withholds the affordance the layout just promised — which reads as broken, not as simpler. Mechanics in `references/pattern-board.md`, and the registration rule in `libraries/drag-and-drop.md` before any `draggable()`.
- **A figure band whenever an aggregate means something** — one `aggregate` dataset, not a sum over the loaded page.
- **Nothing inert that looks live.** A card, a row, a tab or a chip styled as a target must do something when clicked — filter, open, navigate. The render gate MEASURES this and fails the page on it, because a decorative target costs a reader more than a plain one: they try it, nothing happens, and they stop trusting the rest. If there is nothing for it to do, style it as text.
- **The four dataset states, and the interactive ones**: hover, focus, disabled and pending on every control that writes.

Clear the floor first, then spend what is left on the signature.

## Copy

Words are design material; write them with the same care as spacing.

- Name things as the user names them, never as the system stores them. Labels come from the data's own field labels.
- Active voice on every control: "Mark won", not "Submit". An action keeps its name through the whole flow — the button that says "Publish" produces a toast that says "Published".
- Errors say what happened and what to do about it. They do not apologise and they are never vague.
- An empty state is an invitation to act, not a shrug.
- Sentence case, no filler, no exclamation marks. Each element does one job: a label labels, an example demonstrates.

## Before you save

`review` will look at the page for you — composition, spacing, containers, colour, accents, overflow, dead targets and the empty state are all things it renders, measures or judges, so they are not worth a checklist here. What it CANNOT do is read your source or know the schema, and that is exactly what this pass is for. Run it against your own code, before the first review, or you will spend review rounds on things you could have seen.

1. **Template test** — would this exact layout work over a completely different dataset? Then it encodes nothing about this one. Rework the top band.
2. **Schema test** — reread the page assuming the data has moved: a category that was empty now dominates, a field that was uniform now varies. Anything that would look broken or silently disappear was built from today's rows instead of from the schema. This is the check nothing downstream can run for you.
3. **Raw-value hunt** — find every interpolation of a record field. Each must pass through a label, a formatter or a component. Raw keys, objects and ISO timestamps reaching a user are bugs.
4. **Meaning audit** — for each figure, name its comparison. Any figure without one either gets one or gets demoted to a line of text.
5. **Loading and failure** — the review renders the EMPTY state; it never sees the other two. Find `loading` and a failed dataset in your source, for every dataset.
6. **Verb check** — name one thing the user can do here and the exact element they click to do it. If there is none, add detail-on-demand at minimum; if the target is smaller than the thing it opens, move it up to the container.
7. **Plan check** — reread `brief.design`. Is the archetype you named the screen you built? Is the hierarchy the one on screen, or did everything end up the same size? And go down `defaultsRejected` line by line: a page that named "four equal cards" as the thing it was avoiding and shipped four equal cards has written its own worst review, and the critic reads that list too.
