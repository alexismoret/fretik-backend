---
name: building-pages
description: Pages — live, data-bound screens the team opens in the app, written as real Vue over their data. When a page is the right answer, what you can do to one yourself, and what `buildPage` does for you. Read this to decide; you cannot build a page by hand.
---

# Pages

A page is a small Vue project over the team's data — `Page.vue`, `components/*.vue`, `composables/*.ts`, and a `page.json` holding its brief and data contract. The server compiles the whole project on every build and the app runs it in a sandboxed frame styled with the team's own design system. It stores CODE plus that contract, never a snapshot — it re-queries every time someone opens it, so its figures are never stale.

The bar is not "it displays the data". It is: **someone reopens this page every Monday instead of asking you.**

## Who writes it

`buildPage`, and only `buildPage`. You have no `create`.

It runs a specialist on the model the team picked for page design, with the design doctrine, the runtime contract and the row shapes of the data already in its prompt — so it starts writing where you would still be reading. It probes the data for real field names, writes the page's brief, reads the API of every component it uses, writes the project file by file, then RENDERS the page in a real browser, clicks through it, and fixes what it saw before handing back a url.

Send it everything past a targeted edit: a new page, a new view or feature on an existing one, a redesign, a section that needs different data. Put the whole request in `task`, in the user's own words, with the collections by name and the pageId when there is one — it never sees this conversation, so what you leave out it decides for itself. Do not narrow a vague ask on the user's behalf; the builder is built to expand it.

What is yours, through `managePage`: read a page — its manifest, and one file at a time — retouch a word, a label, a colour or a threshold with `edits`, `review` one to see what is actually wrong, publish it, delete it. That split is worth what it costs — a delegate to change one title is waste, and a title changed by hand is instant.

## When a page is the wrong answer

- A one-off number, or a question → answer in chat.
- A frozen report to send someone → a sandbox file (`presentFiles`).
- Data entry at scale, imports, records management → the collections UI already does it.
- A recurring process with steps and approvals → a workflow.

A page earns its keep when the team will REOPEN it.

## Publishing

`publish` mints a link anyone can open without an account. The code is frozen at that moment; the data stays live under the owning team's scope. **Ask the user before publishing** — it exposes what the team can see. Pages that read or write a connected app are refused at the gate. Re-publish to refresh the snapshot; `unpublish` kills the link for good.

## The builder's references

The files under `references/` are the page builder's manual, not background reading — open them only if you are the one writing the code.

| You are about to                                                          | Read                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bound a region, page a long list, avoid a silent component trap           | `references/techniques.md`                                                                                                                                                                                             |
| Wire datasets, filters, pagination, formatting, charts, or a write action | `references/data.md`                                                                                                                                                                                                   |
| Start from a working page of the same family                              | `references/pattern-directory.md` (filter, scan, open, act) · `pattern-workbench.md` (queue beside item) · `pattern-detail.md` (one record) · `pattern-overview.md` (figure band) · `pattern-board.md` (drag and drop) |
| Use a third-party library the runtime allows                              | `references/libraries/<name>.md` — one file per library that behaves differently here than its own docs assume                                                                                                         |

`design.md` and `taste.md` are in the builder's system prompt verbatim — reading them is a step spent re-fetching what it already has. `review-rubric.md` is the critic's own copy, nobody else's.
