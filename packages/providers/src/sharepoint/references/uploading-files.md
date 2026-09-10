# Uploading a file to SharePoint

Read this before your first upload of a conversation. Guessing the shape
produces a file that exists and is corrupt.

## Why it is two steps

The Nango Proxy carries a JSON body, and Microsoft Graph takes RAW BYTES on
`PUT …/content` — a base64 string sent there lands in the document verbatim.
So `create_upload_session` (the approved write) returns a pre-authenticated
`upload_url`, and the bytes go straight to that URL from the sandbox. It is
also what Microsoft prescribes for anything over 4 MB, so one path covers
every size.

The URL carries its own authentication and expires in about 15 minutes. Send
it the file and nothing else — never an `Authorization` header of your own.

## The whole thing, in one cell

The first run stops at `run_plan` with the approval card. On the re-run after
approval the plan replays from cache and the PUT goes through — so both halves
belong in the SAME cell.

```python
import urllib.request
from fretik_apps import sharepoint, run_plan

data = open("/workspace/outputs/Q1-report.pdf", "rb").read()

results = run_plan([sharepoint.create_upload_session.op(
    drive_id="b!x…", parent_folder_id="root", file_name="Q1-report.pdf",
)])
upload_url = results[0]["data"]["upload_url"]

req = urllib.request.Request(upload_url, data=data, method="PUT")
req.add_header("Content-Range", f"bytes 0-{len(data) - 1}/{len(data)}")
with urllib.request.urlopen(req) as resp:
    print(resp.status)   # 200 or 201 — the file is in SharePoint
```

`results[0]` is `{"ok": True, "data": {...}}` — check `ok` before reading
`data` if the plan carried several operations.

## Files over ~60 MB

One PUT covers up to roughly 60 MB. Past that, send consecutive byte ranges to
the same URL, each ≤ 60 MB and aligned to 320 KiB (327 680 bytes):

```python
CHUNK = 320 * 1024 * 10          # 3.2 MB — any multiple of 320 KiB works
total = len(data)
for start in range(0, total, CHUNK):
    chunk = data[start:start + CHUNK]
    req = urllib.request.Request(upload_url, data=chunk, method="PUT")
    req.add_header(
        "Content-Range",
        f"bytes {start}-{start + len(chunk) - 1}/{total}",
    )
    with urllib.request.urlopen(req) as resp:
        status = resp.status      # 202 between chunks, 200/201 on the last
```

Graph answers `202 Accepted` with the ranges it still expects until the final
chunk, which answers `200`/`201` with the created item.

## Updating a document instead of duplicating it

`conflict_behavior="replace"` uploads a NEW VERSION of the file already
carrying that name — the previous version stays in the history, recoverable
with `list_versions` + `restore_version`. That is how you update a document.

- `"rename"` (the default) creates `Q1-report 1.pdf` beside the original.
- `"fail"` refuses when the name is taken — use it when the user must be
  told rather than silently given a second copy.

## Where the folder id comes from

`parent_folder_id` is a folder's `id` from `list_folder`, or the literal
`"root"` for the top level of the library. There is no path variant on this
action: resolve the folder first with `get_item(drive_id, item_path=…)` and
pass its `id`.

## When it fails

- `accessDenied` on the `create_upload_session` call → the connected account
  has read-only access to that library.
- The PUT answers `403`/`404` → the URL expired (15 minutes). Re-run the cell;
  the approved plan replays and mints a fresh one.
- The PUT answers `409` → a `conflict_behavior="fail"` upload hit an existing
  name.
