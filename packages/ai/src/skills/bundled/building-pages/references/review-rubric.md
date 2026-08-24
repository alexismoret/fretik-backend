# Review rubric

What `managePage { action: "review" }` measures and what it judges. The same text is the critic's instructions, so nothing here is a surprise: build against it.

The review renders the saved page in a real browser at 1280, 1024 and 390, clicks what looks clickable, and captures the page a second time with every dataset emptied. Two channels come back, and they do not overlap.

**The gate is measured.** No model is involved and no score can overrule it:

- the page mounted, and reported no error;
- the console is clean;
- every overlay a click opens has content in it;
- every target that advertises itself as clickable changes something when clicked;
- nothing overflows horizontally, at any of the three widths;
- the emptied page still says something.

A page can be beautiful and fail the gate. Those failures come back as `blocking` and are fixed before anything else — they are the class of bug that ships (a slideover that opens empty, a card whose chips do nothing).

**The score is judged**, from the screenshots and the brief, by a critic that did not build the page and starts from the assumption that it is mediocre. Four criteria.

Two things the critic is held to, because they are where a review goes wrong in opposite directions. **8 is not a resting place** — a page that works and reads cleanly lands at 7 or 8, and the critic owes you what separates it from the band above rather than four eights and a compliment. And **the data is live**: a dataset with no rows today is a legitimate state of a working page, so the review judges whether the page explains itself when empty, never how much data happens to exist right now.

## design ×0.35 — is this a designed screen, or an arranged one

Composition serves the question; the answer is above the fold; hierarchy is legible at a glance; space is deliberate; colour comes from the data, one dimension per row leads rather than every field wearing a pale badge, and `primary` is scarce; the mobile capture is a layout, not a squeezed desktop.

- **0–3** unreadable, overlapping, or broken at one of the two widths.
- **4–6** renders correctly and reads as generated: a title, a row of equal cards, a table. Nothing wrong, nothing decided. This is the default score.
- **7–8** the layout encodes this subject — regions sized by their content, one clear focus, the first screen answers the page's question.
- **9–10** the composition itself teaches the data: someone who knows the domain would recognise the thinking.

## functionality ×0.25 — can the team work in it

Filters over the dimensions a person actually slices by, ordering, detail on demand, at least one verb, visible freshness, all four dataset states designed. Judged on what the captures show, gate findings included.

A shape that promises a mutation must be able to perform one. Lanes invite a card to be dragged between them, a checkbox invites a toggle, a status chip invites a change — draw any of them on a page that declares no operation and you have built a promise nothing keeps. Either wire the write, or choose the shape that reads as a view.

A board is the shape with no read-only excuse: when the lane field is writable, cards move by DRAG wired to the write, and a board shipped without it — whatever control stands in for it — is a **finding**, named as such, not a style note. "Choose the shape that reads as a view" is an out only where the data truly cannot be written from the page.

- **0–3** display-only, or a control that does nothing.
- **4–6** the obvious controls exist and stop there.
- **7–8** the page covers the work someone opens it to do, including the empty and failed paths.
- **9–10** it replaces the tool the team was using for this.

## craft ×0.20 — the hundred small decisions

Values formatted the way a person reads them (never a raw key, an ISO timestamp, an ID, an `[object Object]`); labels from the data's own vocabulary; alignment and `tabular-nums` on figures; truncation honest; copy in sentence case and active voice; no stray placeholder.

- **0–3** raw values reach the user.
- **4–6** correct but mechanical — system labels, unformatted numbers, generic empty states.
- **7–8** every value passes through a formatter and every label reads as written by a person.
- **9–10** the details compound: the page feels edited.

## originality ×0.20 — could this have been generated for anything

The harshest question, and the one that separates a good page from a memorable one: **would this exact layout work over a completely different dataset?** If yes, it encodes nothing.

- **0–3** interchangeable with any other dashboard.
- **4–6** the standard shape for its family, competently done.
- **7–8** one element is specific to this subject and could not be moved elsewhere.
- **9–10** the page has a signature — a view, a grouping, a moment — that someone would describe to a colleague.

## Verdict

The weighted score is computed from the four, server-side. **Ship** needs all three: a passing gate, no blocking finding, and ≥ 7.5. Anything else is **revise**.

Three reviews per page. Past that the score stops moving and the edits start trading one flaw for another — spend the budget on the findings that name a fix, and hand the rest to the user.

## Findings

Each finding names where it is on screen, what is wrong, and the fix. They arrive sorted by severity; `blocking` ones come from the gate and are facts, `major` and `minor` are the critic's judgement. Apply them with `update { edits }` — a finding is about one region, so resending the whole file to change one card is waste.

## Elevations

A second list, and a different question: not what is broken, but what would make the page better than it is. At most three, ordered by how much they change the page, each naming where on screen it goes, the change, and what the reader gains.

They arrive whenever the page scores below 9, **including on a page that ships** — that is the whole point of the channel. A page with no defects still has a next level, and without this the review of a working page returns nothing to do.

- **A round left after a passing verdict is spent here.** Apply them the same way as findings, one `edits` call each, then review again.
- **On the last round they become what you tell the user.** "Still weak" is a shrug; an elevation is a specific thing you would do next, which is what someone can decide about.
- They are about the design and the capability, never about the data. Nobody asks for more records.
