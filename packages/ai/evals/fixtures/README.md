# Eval fixtures

Binary files consumed by `evals/cases/file-attachments.ts` (and any future
suite that sets `fixtures: [...]` on its cases). These files are NOT
checked into git (they're binary and would bloat the repo) — add them
manually once per dev machine.

## How seeding works

`evals/conversation-lifecycle.ts::createEphemeralConversation` reads the
case's `fixtures` field, then for each filename it:

1. Pushes `evals/fixtures/{filename}` into the conversation sandbox at
   `/workspace/attachments/{filename}` via the storage façade
   (`attachUserFile`). The façade also queues an S3 backup so a
   sandbox recreated after expiry sees the file again.
2. If a sibling `{stem}.md` sits next to the fixture (same basename, `.md`
   extension), pushes it too as the OCR sidecar at
   `/workspace/attachments/{stem}.md` and flips
   `ai_chat_files.hasMarkdown = true`. The `read` tool auto-resolves
   PDFs / DOCX / images to this sidecar (see `src/tools/read.ts`).
3. Inserts a row in `ai_chat_files` with `status = 'ready'`.
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

| Filename                          | Format | Content hint                                                                                                  | OCR sidecar (`<stem>.md`)                                                               | Used by                            |
| --------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------- |
| `invoice.pdf`                     | PDF    | Any scanned invoice with a TTC total + itemised lines                                                         | **Required.** Put the OCR text (French) in `invoice.md`                                 | `file-pdf-read`                    |
| `data.xlsx`                       | XLSX   | Spreadsheet with a column literally named `amount` (numeric, ≥10 rows)                                        | N/A — no sidecar for spreadsheets                                                       | `file-xlsx-python`                 |
| `receipt.jpg`                     | JPEG   | Photo/scan of a receipt with a total + a date                                                                 | **Required.** Put the OCR text in `receipt.md`                                          | `file-image-doc-read`              |
| `diagram.png`                     | PNG    | Any image with a schema / diagram in its bottom-right quadrant, coloured arrows                               | **Must be ABSENT.** This case validates that the agent reaches for `vision`, not `read` | `file-image-visual-view`           |
| `cat.jpg`                         | JPEG   | Plain photo (no text content)                                                                                 | **Must be ABSENT.** Validates the "no OCR sidecar" path                                 | `file-image-non-document`          |
| `long-report.md`                  | MD     | Long markdown report — ≥ 35 KB so `read` returns a `<persisted-output>` envelope; include ≥ 200 real lines    | N/A — already markdown                                                                  | `file-oversized-read-pagination`   |
| `notes.txt`                       | TXT    | Short plain-text notes (anything)                                                                             | N/A                                                                                     | `file-vision-rejects-text`         |
| `26FRS8592110000744702_1_dae.pdf` | PDF    | Real DAE customs declaration with 43 wine articles (sourced from conv `019df045-f39a-76a5-a7fa-c74c7de68551`) | **Required.** Sibling Mistral OCR sidecar `26FRS8592110000744702_1_dae.md`              | `tabular-multidoc-cross-reference` |
| `ilovepdf_merged.pdf`             | PDF    | 8 merged invoices with `TOTAL HT €` columns matching the DAE articles above                                   | **Required.** Sibling Mistral OCR sidecar `ilovepdf_merged.md`                          | `tabular-multidoc-cross-reference` |

Quick ways to generate the synthetic ones:

```bash
# long-report.md — 500 lines of realistic report-looking content
for i in $(seq 1 500); do echo "Line $i — Transport sector note #$i. Lorem ipsum dolor sit amet, consectetur adipiscing elit."; done > long-report.md

# notes.txt
printf "Shipping notes — Q1 2026\nSee attached BL for carrier confirmation.\n" > notes.txt

# data.xlsx — via Python if you don't have one on hand
python3 -c "
import pandas as pd, random
pd.DataFrame({'amount': [random.uniform(50,5000) for _ in range(50)], 'date': pd.date_range('2026-01-01', periods=50, freq='D')}).to_excel('data.xlsx', index=False)
"
```

For the image / PDF fixtures the easiest is to grab any real invoice /
receipt / schematic you have lying around and drop it here, then write
a quick markdown transcript of the text for the sidecars.

## Re-running just the file-attachments suite

Once the files are in place:

```bash
cd backend/packages/ai
bun run evals -- --suite file-attachments --concurrency 2
```

The runner will log `[evals] fixture "foo" not found at ...` if any
file is missing, so you can iterate.
