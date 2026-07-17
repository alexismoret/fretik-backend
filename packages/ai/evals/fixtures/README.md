# Eval fixtures

Binary files consumed by `evals/cases/file-attachments.ts` (and any future
suite that sets `fixtures: [...]` on its cases). These files are NOT
checked into git (they're binary and would bloat the repo) — add them
manually once per dev machine.

## How seeding works

`evals/conversation-lifecycle.ts::createEphemeralConversation` reads the
case's `fixtures` field, then for each filename it:

1. Pushes the ORIGINAL `evals/fixtures/{filename}` into the conversation
   sandbox at `/workspace/attachments/{filename}` via the storage façade
   (`attachUserFile`, + S3 backup). `python` / `bash` operate on this
   original; NO markdown sidecar is written into the sandbox.
2. If a sibling `{stem}.md` sits next to the fixture (same basename,
   `.md` extension), pre-seeds the **content-addressed extraction cache**
   from it: a `file_extractions` row keyed by `(org, SHA-256)` + an S3
   sidecar at `file-extractions/{org}/{hash}.md`, and flips
   `ai_chat_files.hasMarkdown = true`. The new `read` tool resolves
   documents/images transparently to this cached text — a deterministic
   HIT, no live Mistral call (and it exercises dedup when two cases share
   a fixture). A text-less image fixture (no `{stem}.md`) gets an
   `image-skip` cache row so `read` deterministically points at `vision`.
3. Inserts a row in `ai_chat_files` with `status = 'ready'` + `fileHash`.
4. Appends a `{ type: 'file', mediaType, filename, url }` part to the
   seeded user message so the system prompt's `<file_attachments>`
   section gets populated via `buildAttachedFilesBlock`.

A missing fixture is **non-fatal** — the case runs with an empty
sandbox and the agent typically replies "I don't see that file",
which makes most judge rubrics fail. That's the signal to come
provision the missing file here.

## Files the operator must provide

Add the following into this directory. For each file the "source"
column is a hint on how to obtain or fabricate one — the exact content
doesn't matter, only the shape and whether an OCR sidecar is present.

| Filename              | Format | Content hint                                                                                             | OCR sidecar (`<stem>.md`)                                      | Used by                                   |
| --------------------- | ------ | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------- |
| `invoice.pdf`         | PDF    | Any scanned invoice with a TTC total + itemised lines (the rubric expects 10 364,32 USD)                 | **Required.** Put the OCR text (French) in `invoice.md`        | `file-pdf-read`, `par-two-reads`          |
| `data.xlsx`           | XLSX   | Spreadsheet with a column literally named `amount` (numeric, ≥10 rows)                                   | N/A — no sidecar for spreadsheets                              | `tp-xlsx-python`, `doc-python-one-call`   |
| `marina.jpg`          | JPEG   | Aerial photo of a marina / harbour full of moored boats (no text content)                                | **Must be ABSENT.** Validates the "no OCR sidecar" path        | `mm-image-scene-qa`, `mm-image-plus-text` |
| `long-report.md`      | MD     | 500 numbered lines each carrying `note #<n>` (assertions target lines 40 and 437 — keep that shape)      | N/A — already markdown                                         | `tp-read-offset`, `lc-deep-retrieval`     |
| `notes.txt`           | TXT    | Short plain-text notes (anything generic)                                                                | N/A                                                            | `par-two-reads`                           |
| `ilovepdf_merged.pdf` | PDF    | Several merged invoices; the main issuer is Vivavin with VAT 432 826 832 (rubric expects those literals) | **Required.** Sibling Mistral OCR sidecar `ilovepdf_merged.md` | `lc-multidoc-qa`                          |

Quick ways to generate the synthetic ones:

```bash
# long-report.md — 500 lines of realistic report-looking content
for i in $(seq 1 500); do echo "Line $i — Operations note #$i. Lorem ipsum dolor sit amet, consectetur adipiscing elit."; done > long-report.md

# notes.txt
printf "Meeting notes — Q1 2026\nFollow up with the vendor on the renewal quote.\n" > notes.txt

# data.xlsx — via Python if you don't have one on hand
python3 -c "
import pandas as pd, random
pd.DataFrame({'amount': [random.uniform(50,5000) for _ in range(50)], 'date': pd.date_range('2026-01-01', periods=50, freq='D')}).to_excel('data.xlsx', index=False)
"
```

For the image / PDF fixtures the easiest is to grab any real invoice /
receipt / schematic you have lying around and drop it here, then write
a quick markdown transcript of the text for the sidecars.

## C5 multimodal fixtures (native image / video)

The `multimodal` suite (`evals/cases/multimodal.ts`) grades native
image/video Q&A on the ANSWER. None of these takes an OCR sidecar (the
video and the photos carry no extractable text); a text-less image gets
an `image-skip` cache row automatically, and a video routes straight to
the vision tool. `marina.jpg` is reused from the table above; the two new
ones are real public files (download commands below). If you re-fetch
different content, update the matching judge rubric in `multimodal.ts`.

| Filename    | Format | Content the rubric expects                                                                           | Used by            |
| ----------- | ------ | ---------------------------------------------------------------------------------------------------- | ------------------ |
| `chart.png` | PNG    | Bar chart "Monthly revenue 2026", Jan–Jun, where **March** (95) is clearly the tallest bar           | `mm-chart-reading` |
| `clip.mp4`  | MP4    | "Big Buck Bunny" 10 s clip (~1 MB): an animated outdoor scene with a large grey-and-white **rabbit** | `mm-video-qa`      |

```bash
# chart.png — rendered by QuickChart (public Chart.js renderer); March is the peak
curl -sL -X POST https://quickchart.io/chart -H 'Content-Type: application/json' -o chart.png \
  -d '{"width":600,"height":400,"format":"png","chart":{"type":"bar","data":{"labels":["Jan","Feb","Mar","Apr","May","Jun"],"datasets":[{"label":"Monthly revenue (k)","data":[42,58,95,61,49,70]}]},"options":{"title":{"display":true,"text":"Monthly revenue 2026"}}}}'

# clip.mp4 — Big Buck Bunny, 360p, 10 s, ~1 MB (Blender open movie, CC-BY)
curl -sL -o clip.mp4 https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4
```

## C11 efficiency fixtures (generic, reproducible)

The `b2b-efficiency` suite (`evals/cases/b2b-efficiency.ts`) uses three
small, **industry-agnostic** text fixtures. Their EXACT content is
load-bearing — deterministic assertions check computed values — so
recreate them verbatim (they are gitignored like every fixture here).
Generic by design (CLAUDE.md: the core is not vertical-locked).

`ventes.csv` — totals: all = 42000, Logiciel = 29500, Service = 12500:

```csv
region,produit,montant
Nord,Logiciel,12000
Sud,Logiciel,8000
Nord,Service,5000
Sud,Service,7500
Est,Logiciel,9500
```

`contacts.csv` — three contacts (the file-modification case adds a
`statut` column):

```csv
nom,email,entreprise
Alice Martin,alice@acme.example,ACME
Bob Durand,bob@globex.example,Globex
Carla Petit,carla@initech.example,Initech
```

`rapport.md` — a short generic "quarterly operations review" (productivity
/ satisfaction / costs / large-account risk) the summary case condenses to
3 points. Any equivalent ~20-line generic business report works; keep the
four themes so the judge rubric has something to ground on.

## Using fixtures

These files are picked up automatically by any curated case that declares
`fixtures: [...]` (see `evals/conversation-lifecycle.ts`) on its next
`bun run evals:langfuse` run. Fixture-bound cases are the `tool-portability`
read/xlsx/vision probes and the `b2b-efficiency` suite; heavy extraction
fixtures stay deferred to the prod-grown gold set (see `evals/BACKLOG.md`).

The runner will log `[evals] fixture "foo" not found at ...` if any
file is missing, so you can iterate.
