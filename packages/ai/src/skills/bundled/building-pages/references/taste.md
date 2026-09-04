# Taste

_Written 2026-08. A list of what looks generated is a snapshot of what everyone is generating — reread it when the examples start sounding like the thing to do._

`design.md` is the doctrine: composition, space, hierarchy, colour. This file is the shorter, meaner question underneath it — **would anyone remember this page?** — and the two moves that answer it: knowing what the default output looks like, and spending your one budget on something specific.

## The default output

These are not mistakes. Each one is a defensible choice that a model makes because it is the average of everything it has seen, and a screen assembled entirely from them is recognisable from across the room.

- A title, a row of four equal cards, a table. In that order. Every time.
- Every container the same raised grey with the same radius and the same shadow, so nothing is above anything.
- An icon on every label, a badge on every value, a card around every paragraph.
- Everything centred, everything the same size, everything the same weight.
- Gradients, glass, and glow used as decoration rather than as meaning.
- Section headings that name a container rather than a subject — "Overview", "Details", "Statistics", "Data" — and the same reflex one step down, naming the WIDGET: "Monthly histogram of due dates & budget" is the chart you built, while "Where the budget lands, month by month" is what the reader takes away. A heading that survives being read aloud to someone who cannot see the screen is naming the subject.
- One filter, no sort, no detail view — the page you look at instead of the page you work in.
- **The same dozen components, whatever the subject.** Measured across ten generated pages: a table, a slideover, a select, a skeleton, an empty state, and icons — seventeen components out of the hundred and seventeen the runtime registers. No avatars on people, no timeline on dated events, no tabs, and a status badge on two pages out of ten. The catalogue is above, in full, one line each; reaching for the first component that would work is what makes it useless.
- **Everything at one width.** Sections stacked full-bleed down the page, all the same, because nobody decided which one was the subject.

The test is not "is this wrong". It is: **remove the data and read the layout. Could it be any other page?**

And its harder sibling, once the plan exists: **read `defaultsRejected` and look at the screen.** A page that named a default it was avoiding and shipped it anyway has not been designed; it has been described.

## Where the audacity goes

The palette, the typefaces, the radius and dark mode come from the team's design system and are pushed into your page live. You do not get to pick them, and that is not the constraint it sounds like — it removes the axes where taste is cheapest and leaves five where it actually decides:

1. **Layout.** An asymmetric split, a rail down one side, a workbench that fills the screen, a band that runs full width above a narrow column. Almost every generated page is a stack of equal-width sections; almost no good one is.
2. **Scale.** One figure at three times the size of everything else says what the page is about, before any label. A page where every number is the same size has no subject.
3. **One signature element.** The thing the page is remembered by — see below. One. Two is a collection.
4. **One motion moment.** A staggered reveal of the first band, a height that grows as a detail opens. Everything else is plain state feedback.
5. **The data's own colour as structure.** Not a decorative accent: the thing that makes a category recognisable across the cell, the chart, the legend and the filter.
6. **One more view than was asked for**, when the data supports it and the reader would use it. Not one more block — one more way to see the same subject: the same records on their dates, the same figures split by the dimension nobody thought to slice.

## Signature elements that earn their place

A signature is not an ornament. It is one place where the page does something specific to ITS subject that no generic dashboard would do:

- A ranked queue with a computed score, so the page answers "what do I do first" instead of "what exists".
- A distribution drawn behind a figure, so the number carries its own shape.
- A comparison pane that holds two records side by side.
- A calendar or timeline rail that puts the rows on the axis the work actually happens on.
- A completeness meter per row, so the gaps in the data become the work.
- A grouped board where the columns are the real states of the process, and moving between them is the action.
- Two views of one subject held side by side, so the comparison is the page rather than a thing the reader assembles in their head.
- A period rail down one side that filters everything at once, so the question "and last month?" costs one click.

Each one exists because someone asked what the reader would do next. That is the whole method: **name the decision the reader came to make, then build the one element that makes it obvious.** If you cannot name the decision, the page is a report.

## The line

Restraint is not blandness, and audacity is not decoration. Every bold choice here is bold about the SUBJECT — a bigger number, a sharper order, a truer grouping. Nothing on this page should be interesting because of how it looks; the interesting parts should be interesting because of what they say.
