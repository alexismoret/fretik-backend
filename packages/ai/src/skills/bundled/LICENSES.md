# Bundled skills — origin

| Skill                                                                                       | Origin                                             |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `docx` · `pdf` · `pptx` · `xlsx`                                                            | Adapted from `anthropics/skills`, tuned for Fretik |
| `doc-coauthoring`                                                                           | Rewritten in-house (2026-08-19)                    |
| `building-pages` · `data-viz` · `designing-collections` · `platform-guide` · `skill-author` | In-house                                           |

## Re-syncing the four Office skills

Upstream owns their bodies; we own three adaptations. On every sync, copy upstream
over the folder and re-apply exactly these:

- a `> **Fretik sandbox.**` blockquote after the frontmatter — `/workspace` paths,
  the `skill_loader` import form, `outputs/` + `presentFiles`. Upstream cannot know
  our plumbing;
- the upstream line saying paths are relative to the skill directory, deleted where
  our blockquote already says it more precisely;
- the `license:` frontmatter key, dropped.

Then `bun run format` — upstream markdown is not Prettier-shaped, and `bun run check`
fails on it otherwise.

Do NOT hand-edit the bodies otherwise — local edits are silently lost on the next
sync and make the diff unreadable. Fix things upstream-shaped instead: pin a new
dependency in `services/e2b/template/requirements.txt` (Python) or the
`npm install -g` layer in `template/build.ts` (Node) so the skill's "preinstalled"
claims hold.

## `building-pages` and its sources

One third-party source feeds it, kept outside this folder: the **Nuxt UI docs**
(MIT, https://ui.nuxt.com). The component corpus served by `pageDocs` is
generated verbatim from the library's
published `llms-full.txt` by `scripts/sync-nuxt-ui-docs.ts` into
`src/tools/assets/nuxt-ui/`, each file carrying its source and licence line. MIT
permits this — regenerate on every `@nuxt/ui` upgrade rather than editing by hand.
