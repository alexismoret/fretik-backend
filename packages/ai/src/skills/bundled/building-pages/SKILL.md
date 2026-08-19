---
name: building-pages
description: Build a page — a live, data-bound screen the team opens in the app, written as a real Vue SFC over their data. Covers design doctrine, the Nuxt UI catalogue, the data/action contract, the review rubric, and worked page patterns. Use for any dashboard, directory, board, console or mini-app request.
---

# Building pages

A page is ONE Vue SFC you write. The server compiles it on save and the app runs it in a sandboxed frame, styled with the team's own design system. You have all of Vue, all of Nuxt UI, Tailwind and Chart.js — and nothing renders, formats or decorates anything for you. What you write is exactly what the team gets.

The bar is not "it displays the data". It is: **someone reopens this page every Monday instead of asking you.** That means it answers its question in the first screen, stays legible when a dataset is empty or slow, shows values the way a person reads them, and offers the next action in place.

You do get to see it. `managePage { action: "review" }` renders the saved page in a real browser at two widths, clicks what looks clickable, empties every dataset, and comes back with measured defects plus a design critique. A page nobody has reviewed is a page nobody has seen.

## Process

1. **Probe the data first.** `dry_run` a definition with datasets and no `code`: it returns real field names, a real row, real distinct groups. Designing against imagined fields is the single biggest cause of a page that ships `[object Object]`.
2. **Write the brief before the code** — `definition.brief`: the page's job, who opens it, the features you commit to; then the layout in prose, ONE signature element, at most ONE moment of motion. Then ask whether that same brief would come out of a similar request over a completely different dataset. If it would, it encodes nothing about this subject — redo it. `references/design.md` is the input to this step.
3. **Read the API of the components you will use** — `{ action: "components" }`, before the template. Not optional: an unknown prop is dropped in silence and content in the wrong named slot renders somewhere else, with no error. A write that places one you never read says so in `warnings`.
4. **Build**, `dry_run`, save.
5. **Review, fix, review.** `blocking` first — those are measured, not opinions. Then the findings, one `edits` call each. A passing verdict closes the defect list, not the page: rounds left over go to `elevations`, the review's answer to what would make it better. Three reviews per page, then hand it over with the last elevations as what you would do next.

## Where the knowledge lives

Three layers, and using the wrong one is how pages come out generic:

| Layer                | What it answers                                                                               | How to get it                                                                                                       |
| -------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **Runtime contract** | What may I import, what does the bridge offer, what does the sandbox forbid                   | `managePage { action: "get_guide" }` — once per conversation, before your first page                                |
| **Component API**    | What does `UTable` / `USlideover` / `USelectMenu` actually accept — every prop, slot, variant | `managePage { action: "components", components: [...] }` — up to 6 at a time, generated from the library's own docs |
| **Judgment**         | Which component, which layout, which density, which words                                     | this skill's references, below                                                                                      |

## References

Load what the task needs.

| You are about to                                                          | Read                                                                                                                                   |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Lay out the page — composition, hierarchy, density, colour, motion, copy  | `references/design.md`                                                                                                                 |
| Decide what would make this page memorable rather than competent          | `references/taste.md`                                                                                                                  |
| Choose components, or render a table, list, form or overlay well          | `references/components.md`                                                                                                             |
| Wire datasets, filters, pagination, formatting, charts, or a write action | `references/data.md`                                                                                                                   |
| Start from a working page of the same family                              | `references/pattern-directory.md` (filter, scan, open, act) · `pattern-overview.md` (figure band) · `pattern-board.md` (drag and drop) |
| Know what the review will hold the page to                                | `references/review-rubric.md`                                                                                                          |

Anything real needs `design.md`. Anything with records needs `components.md` and `data.md`.

## Non-negotiables

The compiler refuses the write, or the sandbox silently drops the result, when you break these.

- **Static Tailwind classes only.** The compiler scans your source text; a class assembled at runtime (``:class="`bg-${c}-500`"``) styles nothing. Toggle between complete literal strings, or use `:style` for a value that is genuinely dynamic (a hex from the data, a computed width).
- **Icons are `i-lucide-*` only**, prefix included and written literally — a name is parsed as `i-<collection>-<icon>`, so `` `i-${icon}` `` asks for a collection that does not exist and silently renders an empty box. Icons reaching you from the data (`fields[].options[].icon`, `targetIcon`) already carry their prefix: pass them straight to `<UIcon :name>`, NEVER wrap them.
- **The import allowlist is closed** — `get_guide` names it, `references/components.md` § Beyond Nuxt UI says what each one is for. Nothing else, no relative files: it is one file. `@tanstack/vue-table` in particular is NOT importable — paginate and sort through the data contract.
- **No `fetch`, no storage, no `window.open`.** The bridge is the only door out; state lives in refs. Plain `<a href>` is fine — the app routes it.
- **Every dataset result has four outcomes**, and a page that renders one of them is broken for the other three: loading, `ok` with rows, `ok` with zero rows, and a failure (`error` / `forbidden` / `needs_connection`).
- `<style scoped>` exists but Tailwind covers almost everything; no `@import`, no `url()`.

## Publishing

`publish` mints a link anyone can open without an account. The code is frozen at that moment; the data stays live under the owning team's scope. **Ask the user before publishing** — it exposes what the team can see. Pages that read or write a connected app are refused at the gate. Re-publish to refresh the snapshot; `unpublish` kills the link for good.

## When a page is the wrong answer

- A one-off number, or a question → answer in chat.
- A frozen report to send someone → a sandbox file (`presentFiles`).
- Data entry at scale, imports, records management → the objects UI already does it.
- A recurring process with steps and approvals → a workflow.

A page earns its keep when the team will REOPEN it.
