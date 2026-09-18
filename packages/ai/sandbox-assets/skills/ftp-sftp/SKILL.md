---
name: ftp-sftp
description: File transfer over FTP, FTPS and SFTP — browse a remote file server, read its folders and file metadata, download and upload files in bulk, and move, rename or delete what is there.
version: b6521e288c70
---

# File transfer (FTP/SFTP) — 10 actions

You can interact with the user's File transfer (FTP/SFTP) account via the `fretik_apps.ftp_sftp` Python module.

## Read actions (auto-approved, eager)

- `ftp_sftp.get_server_info()` — Show the connection's protocol, starting folder and capabilities
- `ftp_sftp.list_directory(path="", pattern=None, include_directories=True, sort="name", limit=200)` — List the files and folders directly inside one folder
- `ftp_sftp.find_files(pattern, path="", max_depth=3, modified_after=None, limit=200)` — Search a folder tree for files matching a name pattern
- `ftp_sftp.get_entries(paths)` — Check whether paths exist and read their metadata
- `ftp_sftp.download_files(paths)` — Download files into the sandbox — bytes land at `sandbox_path`

## Write actions (require user approval — build with `.op()`)

- `ftp_sftp.upload_files.op(files, on_conflict="replace", create_directories=True)` — Upload files to the server (creates missing folders)
- `ftp_sftp.move_entries.op(moves, create_directories=True)` — Move or rename files and folders
- `ftp_sftp.delete_files.op(paths)` — Delete files (not folders)
- `ftp_sftp.create_directory.op(path, mode=None)` — Create a folder, with any missing parents
- `ftp_sftp.delete_directory.op(path, recursive=False)` — Delete a folder — empty by default, with its contents on request

## Data models

Read actions return Pydantic models — field names below are EXACT. Use the names as-is (`m.from_address`, NOT `m.sender` or `m.from_`). A trailing `?` marks an optional field.

- `RemoteEntry` — `name: str`, `path: str`, `type: Literal["file", "directory", "symlink"]`, `size_bytes?: int`, `modified_at?: str`, `mode?: str`, `owner?: str`, `group?: str`
- `EntryLookup` — `path: str`, `exists: bool`, `type?: Literal["file", "directory", "symlink"]`, `size_bytes?: int`, `modified_at?: str`, `mode?: str`, `error?: str`
- `RemoteFile` — `path: str`, `name: str`, `size_bytes: int`, `content_type: str`, `sandbox_path?: str`, `content_base64?: str`, `error?: str`
- `ServerInfo` — `protocol: Literal["sftp", "ftp", "ftps", "ftps-implicit"]`, `host: str`, `working_directory: str`, `root_path?: str`, `supports_modified_time: bool`, `supports_size: bool`, `supports_permissions: bool`, `server_software?: str`
- `WriteResult` — `path: str`, `ok: bool`, `error?: str`


## What this connection is

A folder tree on somebody else's server, reached over SFTP, FTPS or plain
FTP. There are no ids: a **path** identifies everything, and the same path is
what every action takes and returns.

Three facts shape every task here.

- **There is no recycle bin.** Not in FTP, not in SFTP. A delete is final.
- **A path may be pinned.** If the connection has a root folder, you never see
  it: paths start at that folder and `/` means it.
- **FTP servers differ in what they can answer.** Timestamps, sizes and
  permissions are optional on FTP and guaranteed on SFTP.

## Patterns

### Start by looking around

`get_server_info()` once per conversation tells you where relative paths
start and what this particular server can answer. Check it before you sort or
filter on `modified_at` — on an FTP server without MLSD every timestamp is
`None`, and a "newest file" picked from those is a coin toss.

```python
from fretik_apps import ftp_sftp
info = ftp_sftp.get_server_info()
print(info.working_directory, info.supports_modified_time)

entries = ftp_sftp.list_directory(path="in", pattern="*.csv", sort="modified_desc")
for e in entries:
    print(e.path, e.size_bytes, e.modified_at)
```

`list_directory` reads ONE folder. `find_files` walks a tree — use it when the
files are spread over dated subfolders, and keep `max_depth` honest:

```python
recent = ftp_sftp.find_files(path="archive", pattern="*.edi",
                             max_depth=3, modified_after="2026-09-01T00:00:00Z")
```

### "Has the file arrived yet?"

`get_entries` answers for a whole list in one round-trip and reports
`exists: False` instead of raising — which is the expected answer when you are
waiting on a partner's drop.

```python
found = ftp_sftp.get_entries(paths=["in/ORDER_2026-09.csv", "in/INVOICE_2026-09.csv"])
missing = [f.path for f in found if not f.exists and not f.error]
unknown = [f.path for f in found if f.error]
```

`exists: False` with an `error` set means the lookup failed, not that the
file is absent — a folder the account may not list answers the same way. Do
not report "the file has not arrived" on one of those.

### Download many files in one call

`download_files` takes a LIST. One call is one connection; ten calls are ten
handshakes for the same bytes, so batch by default. The bytes land in the
sandbox at `sandbox_path` and never enter the conversation.

```python
files = ftp_sftp.download_files(paths=[e.path for e in entries[:10]])
import pandas as pd
for f in files:
    if f.error:
        print("skipped", f.path, f.error)
        continue
    df = pd.read_csv(f.sandbox_path)
```

A file that fails comes back with `error` set while the rest still arrive —
always check it before touching `sandbox_path`.

### Upload many files in one approval

`upload_files` takes a LIST too, and one call is one approval card. Read each
file, base64 it, and send them together — never a Python loop of one-file
plans.

```python
import base64
from fretik_apps import ftp_sftp, run_plan

payload = []
for name in ["ORDER_A.csv", "ORDER_B.csv"]:
    with open(f"/workspace/outputs/{name}", "rb") as fh:
        payload.append({
            "remote_path": f"out/{name}",
            "content_base64": base64.b64encode(fh.read()).decode(),
        })

run_plan([ftp_sftp.upload_files.op(files=payload, on_conflict="fail")])
```

`on_conflict` decides what happens to a file already at that path: `replace`
(the default) overwrites it with no way back, `rename` writes `ORDER_A (1).csv`
beside it, `fail` leaves it alone and reports it. On a partner's drop folder,
`fail` is usually what they meant.

Missing parent folders are created for you. `mode` (`0644`) applies on SFTP
only — on FTP the upload still succeeds and the result says the permissions
were skipped.

An empty `content_base64` writes a 0-byte file. Send a file the partner
requires but expects empty exactly as it is — padding it with a newline
changes the bytes they parse.

### Moving, renaming, deleting

`move_entries` does both moving and renaming — they are one operation on both
protocols. The classic "consume a drop folder" is a batch download followed by
a batch move into `processed/`:

```python
run_plan([ftp_sftp.move_entries.op(moves=[
    {"from_path": "in/ORDER_A.csv", "to_path": "processed/ORDER_A.csv"},
    {"from_path": "in/ORDER_B.csv", "to_path": "processed/ORDER_B.csv"},
])])
```

Prefer that move over `delete_files`: it is reversible and the partner can see
what you took. `delete_files` handles files only; a folder goes through
`delete_directory`, which refuses a non-empty one unless you pass
`recursive=True` — and that wipes the tree with no undo, so only ever on a
path the user named.

Every bulk write returns one row per input with `ok` / `error`. Read them:
a batch can half-succeed, and reporting "done" on twelve rows of which three
failed is the failure mode that matters here. A failed row names its own file
and no other — fix that entry and re-send it alone. When every row failed,
nothing was written and nothing is cached, so the corrected call runs.

Those rows are the receipt: `ok` means the server acknowledged the bytes, so
do not re-list the folder to confirm. On a drop folder a partner's process may
already have taken the file, and an empty listing there is not a failed
upload.

### Multiple connected file servers

When several FTP/SFTP connections exist, the system prompt's `<external_apps>`
block already says how to disambiguate: pick silently when the user named one,
otherwise ask. Pass the choice through the implicit `connection_id` argument
every action accepts — e.g.
`ftp_sftp.list_directory(connection_id="3f1a…", path="in")`.

Calling one without `connection_id` while several are connected raises
`EXTERNAL_APP_AMBIGUOUS_CONNECTION` listing the candidates — recover per the
upstream rule.

### Failures worth recognising

- **A file the user swears is there, `exists: False`** → the path is probably
  relative to a different folder. `get_server_info().working_directory` and a
  `list_directory` of its parent settle it in one call.
- **`Path … resolves outside this connection's root folder`** → the connection
  is pinned. Work inside it; there is no path that escapes.
- **Permission denied on a write while reads work** → the account is read-only
  on that server. Say so rather than retrying; nothing here can change it.
- **`Download budget exceeded` / `Too many files in one call`** → split the
  request. These ceilings are about what crosses into the sandbox, not about
  what the server holds.
- **`The file server did not finish within 50s`** → the call ran out of wall
  clock, not out of bytes. Ask for fewer files in one go. A transfer that
  cannot fit a turn belongs in a scheduled workflow.
- **`Incomplete transfer: the server announced N bytes and sent M`** → the
  file was NOT read, and nothing was written to the sandbox. Never treat it
  as an empty file; retry it on its own.
- **Every `modified_at` is `None`** → this FTP server does not report times.
  Sort by name, or ask the user which file they mean.

### This is not the place to poll

Waiting for a partner to drop a file is a schedule, not a turn. Set up a
workflow that runs `list_directory` on a cron and acts when something new
appears — re-listing the same folder inside one conversation burns the turn
and answers the same thing each time.

---

## Write actions & approval

Write actions NEVER execute on their own: `.op(...)` builds an operation,
`run_plan([...])` submits them, and calling a write action directly raises.
The user approves the whole plan at once.

- One write:   `run_plan([ ftp_sftp.upload_files.op(files=[{…}]) ])`
- Many writes: `run_plan([ ftp_sftp.<action>.op(...), ... ])`

`run_plan` raises `fretik_apps.ApprovalPending`. This is EXPECTED — not an
error. Stop there. Never wrap it in `try/except` (that hides the approval
card), and never `print` the ops as a preview instead of calling it — no
call, no plan.

Once the user decides, the outcome replaces that same tool result. It covers
only the operations it lists: if any code sat AFTER the `run_plan` call,
re-run the identical cell — approved plans replay from cache and never execute
twice. On rejection you get their feedback — adapt and write new code.

### STRONG RULE — read→write flows
When a plan depends on data you just read, you MUST inline the read
results as EXPLICIT LITERALS in the `.op()` calls. Do NOT compute
`.op()` arguments from a read performed in the same script as
`run_plan`.

Correct: read in one turn, inspect the results, THEN in the next turn
write `run_plan([...])` with concrete IDs / addresses as literals.

Why: on re-run after approval, a volatile read (inbox changed) would
change the plan's lookupHash and force a needless re-approval.

### Plan rules
- Every write of the turn goes in ONE `run_plan`. A second call in the
  same cell is lost: the first raises and the rest of the cell never runs.
- Operations in one plan must be INDEPENDENT (no op uses another op's
  result). Dependent steps (create_folder, then move into it) → use
  TWO turns.
- A plan may mix actions from several apps — one approval for all of them.
- Partial failures come back per-op; re-submit a `run_plan` with only
  the failed ops.
