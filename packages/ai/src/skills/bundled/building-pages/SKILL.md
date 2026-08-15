---
name: building-pages
description: Build a page — a live, data-bound screen the team opens in the app, written as a real Vue SFC over their data. Covers design doctrine, the Nuxt UI catalogue, the data/action contract, and worked page patterns. Use for any dashboard, directory, board, console or mini-app request.
---

# Building pages

A page is ONE Vue SFC you write. The server compiles it on save and the app runs it in a sandboxed frame, styled with the team's own design system. You have all of Vue, all of Nuxt UI, Tailwind and Chart.js — and nothing renders, formats or decorates anything for you. What you write is exactly what the team gets.

The bar is not "it displays the data". It is: **someone reopens this page every Monday instead of asking you.** That means it answers its question in the first screen, stays legible when a dataset is empty or slow, shows values the way a person reads them, and offers the next action in place.

You never see the result. You cannot screenshot it, and nobody will fix it for you — so the discipline below replaces your eyes.

## Process

1. **Probe the data before you design anything.** `dry_run` a definition with datasets and no `code`: it returns real field names, a real row, real distinct groups. Designing against imagined fields is the single biggest cause of a page that ships `[object Object]`.
2. **Plan in one paragraph, before code.** The page's one job. The layout in a sentence. The three things visible without scrolling. The one element the page is remembered by. If that paragraph would fit any other page over any other dataset, it is a template, not a design — redo it.
3. **Build** — read the references you need first (below).
4. **Critique your own source**, against `references/design.md` § Self-critique. Fix what fails there.
5. **`dry_run` the finished definition**, then save. Fix compile errors and dataset errors before the user ever opens it.

## Where the knowledge lives

Three layers, and using the wrong one is how pages come out generic:

| Layer                | What it answers                                                                               | How to get it                                                                                                       |
| -------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **Runtime contract** | What may I import, what does the bridge offer, what does the sandbox forbid                   | `managePage { action: "get_guide" }` — once per conversation, before your first page                                |
| **Component API**    | What does `UTable` / `USlideover` / `USelectMenu` actually accept — every prop, slot, variant | `managePage { action: "components", components: [...] }` — up to 6 at a time, generated from the library's own docs |
| **Judgment**         | Which component, which layout, which density, which words                                     | this skill's references, below                                                                                      |

Never guess a prop. An unknown prop is dropped silently and an unregistered component renders as nothing — both produce a page that looks broken for no visible reason. Ask for the API of the components your page will use, in one call, before writing the template.

## References

Load what the task needs.

| You are about to                                                          | Read                       |
| ------------------------------------------------------------------------- | -------------------------- |
| Lay out the page — composition, hierarchy, density, colour, motion, copy  | `references/design.md`     |
| Choose components, or render a table, list, form or overlay well          | `references/components.md` |
| Wire datasets, filters, pagination, formatting, charts, or a write action | `references/data.md`       |
| Start from a working page of the same family                              | `references/patterns.md`   |

Anything real needs `design.md`. Anything with records needs `components.md` and `data.md`.

## Non-negotiables

The compiler refuses the write, or the sandbox silently drops the result, when you break these.

- **Static Tailwind classes only.** The compiler scans your source text; a class assembled at runtime (``:class="`bg-${c}-500`"``) styles nothing. Toggle between complete literal strings, or use `:style` for a value that is genuinely dynamic (a hex from the data, a computed width).
- **Imports: `vue`, `@nuxt/ui`, `chart.js` / `chart.js/auto`, `#fretik/sdk`, `@vueuse/core`, `@internationalized/date`, and the four Pragmatic drag-and-drop paths** (`references/components.md` § Beyond Nuxt UI lists what each is for). Nothing else, no relative files — it is one file. `@tanstack/vue-table` is NOT importable: paginate and sort through the data contract, not through the table's own row models.
- **Icons are `i-lucide-*` only**, prefix included. A name is parsed as `i-<collection>-<icon>`, so a schema icon like `calendar-check` written as `` `i-${icon}` `` asks for the `calendar` collection and silently renders an empty box. Always `` `i-lucide-${icon}` ``.
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
