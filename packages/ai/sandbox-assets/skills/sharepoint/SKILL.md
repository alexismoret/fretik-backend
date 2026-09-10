---
name: sharepoint
description: Microsoft SharePoint — browse and search sites, read and write files in document libraries, query and update SharePoint list rows, and read site pages.
version: 2731514b2c95
---

# Microsoft SharePoint — 32 actions

You can interact with the user's Microsoft SharePoint account via the `fretik_apps.sharepoint` Python module.

## Read actions (auto-approved, eager)

- `sharepoint.search_sites(query, limit=25)` — Find SharePoint sites by name across the tenant
- `sharepoint.get_site(site_id)` — Fetch one site by ID
- `sharepoint.get_site_by_url(site_url)` — Resolve a SharePoint URL the user pasted into its site
- `sharepoint.list_followed_sites(limit=50)` — List the sites the connected account follows
- `sharepoint.list_libraries(site_id)` — List a site's document libraries
- `sharepoint.list_folder(drive_id, folder_id=None, folder_path=None, limit=100, page_token=None)` — List the files and folders directly inside a folder
- `sharepoint.get_item(drive_id, item_id=None, item_path=None)` — Fetch one file or folder's metadata by ID or by path
- `sharepoint.search_library(drive_id, query, limit=25)` — Search file and folder names + contents inside ONE library
- `sharepoint.search(query, entity_types=["driveItem"], limit=25, offset=0)` — Search files, list rows and sites across the WHOLE tenant (Microsoft Search)
- `sharepoint.download_file(drive_id, item_id)` — Download a file's content into the sandbox
- `sharepoint.resolve_share_link(share_url)` — Turn a SharePoint/OneDrive sharing link into the file it points at
- `sharepoint.list_versions(drive_id, item_id, limit=20)` — List a file's version history
- `sharepoint.list_permissions(drive_id, item_id)` — List who has access to a file or folder, and how
- `sharepoint.list_lists(site_id)` — List a site's lists (and its libraries seen as lists)
- `sharepoint.get_list(site_id, list_id)` — Fetch one list by ID or by its URL slug
- `sharepoint.list_columns(site_id, list_id)` — List a list's columns — READ THIS before filtering or writing rows
- `sharepoint.list_list_items(site_id, list_id, filter=None, order_by=None, columns=None, limit=50, page_token=None)` — List the rows of a list, optionally filtered and sorted
- `sharepoint.get_list_item(site_id, list_id, item_id)` — Fetch one list row with all its column values
- `sharepoint.list_pages(site_id, limit=50)` — List a site's pages (intranet news, wiki, home page)
- `sharepoint.get_page(site_id, page_id)` — Read a site page's text content

## Write actions (require user approval — build with `.op()`)

- `sharepoint.create_folder.op(drive_id, name, parent_folder_id="root", conflict_behavior="rename")` — Create a folder inside a library
- `sharepoint.create_upload_session.op(drive_id, file_name, parent_folder_id="root", conflict_behavior="rename")` — Open an upload slot for a file — send the bytes to the returned URL
- `sharepoint.update_item.op(drive_id, item_id, new_name=None, new_parent_folder_id=None)` — Rename a file or folder and/or move it to another folder
- `sharepoint.delete_item.op(drive_id, item_id)` — Delete a file or folder (goes to the site's recycle bin)
- `sharepoint.copy_item.op(drive_id, item_id, target_folder_id, target_drive_id=None, new_name=None)` — Copy a file or folder into another folder, possibly another library
- `sharepoint.restore_version.op(drive_id, item_id, version_id)` — Restore a previous version of a file as the current one
- `sharepoint.create_share_link.op(drive_id, item_id, link_type="view", scope="organization", expiration_date=None)` — Create a sharing link to a file or folder
- `sharepoint.grant_item_access.op(drive_id, item_id, emails, role="read", message=None, send_invitation=True, require_sign_in=True, expiration_date=None)` — Give named people access to a file or folder
- `sharepoint.revoke_item_access.op(drive_id, item_id, permission_id)` — Revoke one permission or sharing link on a file or folder
- `sharepoint.create_list_item.op(site_id, list_id, fields)` — Add a row to a list
- `sharepoint.update_list_item.op(site_id, list_id, item_id, fields)` — Update column values on an existing list row
- `sharepoint.delete_list_item.op(site_id, list_id, item_id)` — Delete a row from a list

## Data models

Read actions return Pydantic models — field names below are EXACT. Use the names as-is (`m.from_address`, NOT `m.sender` or `m.from_`). A trailing `?` marks an optional field.

- `Site` — `id: str`, `name: str`, `display_name: str`, `web_url: str`, `description?: str`, `created_at?: str`, `last_modified_at?: str`
- `Library` — `id: str`, `name: str`, `web_url: str`, `description?: str`, `drive_type: str`
- `DriveItem` — `id: str`, `name: str`, `is_folder: bool`, `size_bytes: int`, `web_url: str`, `mime_type?: str`, `child_count?: int`, `parent_folder_id?: str`, `parent_path?: str`, `drive_id?: str`, `list_item_id?: str`, `list_id?: str`, `created_at: str`, `last_modified_at: str`, `last_modified_by?: str`
- `FileDownload` — `id: str`, `name: str`, `content_type: str`, `size_bytes: int`, `sandbox_path?: str`, `download_url?: str`
- `ItemVersion` — `id: str`, `size_bytes?: int`, `last_modified_at: str`, `last_modified_by?: str`
- `Permission` — `id: str`, `roles: list[str]`, `granted_to: list[str]`, `link_type?: str`, `link_scope?: str`, `link_url?: str`, `inherited: bool`, `expires_at?: str`
- `ShareLink` — `id: str`, `link_url: str`, `link_type: str`, `link_scope: str`, `expires_at?: str`
- `SharePointList` — `id: str`, `name: str`, `display_name: str`, `web_url: str`, `description?: str`, `template?: str`, `created_at?: str`
- `ListColumn` — `name: str`, `display_name: str`, `type: str`, `required: bool`, `read_only: bool`, `choices?: list[str]`, `description?: str`
- `ListItem` — `id: str`, `web_url?: str`, `fields: dict`, `created_at?: str`, `last_modified_at?: str`, `created_by?: str`, `last_modified_by?: str`
- `SitePage` — `id: str`, `name: str`, `title: str`, `web_url: str`, `description?: str`, `page_layout?: str`, `published_at?: str`, `content_html?: str`
- `SearchHit` — `kind: Literal["driveItem", "listItem", "list", "drive", "site"]`, `id: str`, `name: str`, `web_url?: str`, `summary: str`, `drive_id?: str`, `site_id?: str`, `list_id?: str`, `size_bytes?: int`, `last_modified_at?: str`
- `UploadSession` — `upload_url: str`, `expires_at?: str`
- `DriveItemPage` — `items: list[DriveItem]`, `page_token?: str` (pass back to the same action to fetch the next page)
- `ListItemPage` — `items: list[ListItem]`, `page_token?: str` (pass back to the same action to fetch the next page)


## The shape of a SharePoint tenant

Everything hangs off a **site**. A site holds **document libraries** (files)
and **lists** (rows). Nothing else addresses content, and almost every action
below needs an id from one level up — so the first call of a SharePoint task
is nearly always a discovery call.

```
site  ──┬── library (drive_id) ── folder ── file (item_id)
        ├── list (list_id) ────── row (item_id) ── fields{}
        └── page (page_id)
```

## Patterns

### Get a site id first

Three ways in, best first:

1. **The connection names a default site** — `default_site_url` in this
   connection's `<external_apps>` block. Resolve it once with
   `get_site_by_url` and reuse the id for the rest of the turn.
2. **The user pasted a URL** — `get_site_by_url` takes ANY URL inside the
   site, including a deep link to a document. Never ask them for an id.
3. **Neither** — `search_sites(query="…")` on words from their request, or
   `list_followed_sites()` for the handful of sites this account works in.

```python
from fretik_apps import sharepoint
site = sharepoint.get_site_by_url(site_url="https://contoso.sharepoint.com/sites/Legal")
libs = sharepoint.list_libraries(site_id=site.id)   # libs[0].id is the drive_id
```

### Find a document

`search` (Microsoft Search) covers every site the account can reach in ONE
call — reach for it before walking folders by hand. `search_library` is the
narrow version when you already know which library, and `list_folder` is for
browsing a structure the user described.

`search` accepts KQL, which is how you get precision:

```python
sharepoint.search(query='filetype:pdf AND "master services agreement"', limit=10)
sharepoint.search(query='path:"https://contoso.sharepoint.com/sites/Legal" AND LastModifiedTime>=2026-01-01')
sharepoint.search(query="renewal", entity_types=["listItem"])   # rows, not files
```

Each hit carries the ids the follow-up needs: `drive_id` + `id` for a
`driveItem`, `site_id` + `list_id` + `id` for a `listItem`.

### Read a document's content

`download_file` streams the bytes into the sandbox and hands back
`sandbox_path`. The file never enters the conversation — open it with
whatever suits the format.

```python
f = sharepoint.download_file(drive_id="b!x…", item_id="01ABC…")
# f.sandbox_path → "/workspace/attachments/9f2c1a04_contract.pdf"
```

Bytes only reach the sandbox on a `download_file` call — a `list_folder`
result is metadata.

### Upload a file — read the reference first

Uploading is NOT one call: `create_upload_session` is the approved write, and
the bytes then go to the pre-authenticated URL it returns. Read
`references/uploading-files.md` before your first upload of a conversation —
it has the exact cell to write, the chunking rule past ~60 MB, and how to
upload a new VERSION of an existing document instead of a duplicate. Guessing
the shape produces a file that exists and is corrupt.

### Lists — read the columns before you touch a row

A SharePoint list's columns have an INTERNAL name that is not what the UI
shows: "Due date" is `Due_x0020_date` or `DueDate`, and a `Status` column may
really be `Statut0`. `list_columns(site_id, list_id)` is the mapping — it
returns `name` (internal), `display_name`, `type` and `read_only` — and
guessing instead of calling it produces rows silently missing half their
values.

Filter and select with those internal names, prefixed by `fields/`:

```python
page = sharepoint.list_list_items(
    site_id=site.id, list_id=lst.id,
    filter="fields/Status eq 'Open' and fields/Amount gt 1000",
    order_by="fields/Created desc",
    columns=["Title", "Status", "Amount"],
)
for row in page.items:
    print(row.id, row.fields)
```

Writing a row is the same field map:

```python
run_plan([sharepoint.create_list_item.op(
    site_id=site.id, list_id=lst.id,
    fields={"Title": "ACME renewal", "Status": "Open", "Amount": 1200},
)])
```

Never send a column whose `read_only` is `True` — Graph rejects the whole
write. A `personOrGroup` column takes `<InternalName>LookupId` with a user id,
not an email; a `lookup` column likewise takes `<InternalName>LookupId`.

### Pagination

`list_folder` and `list_list_items` return a page, not a list: `.items` plus
`.page_token`. Keep calling with the token until it comes back `None`. Every
other list action returns the whole answer for the `limit` you asked for.

```python
token, everything = None, []
while True:
    page = sharepoint.list_list_items(site_id=site.id, list_id=lst.id, page_token=token)
    everything += page.items
    token = page.page_token
    if token is None:
        break
```

### A library's files also have list columns

A document library IS a list, and the metadata a team files documents by —
Contract type, Client, Status, Review date — lives in its columns, not in the
file. Every `DriveItem` carries `list_id` + `list_item_id` for exactly this:
with the site id you already have, `get_list_item` and `update_list_item` read
and write that metadata. `update_item` only renames and moves.

```python
f = sharepoint.get_item(drive_id="b!x…", item_path="Contracts/acme.pdf")
row = sharepoint.get_list_item(site_id=site.id, list_id=f.list_id, item_id=f.list_item_id)
print(row.fields)          # {"Title": "ACME MSA", "ContractType": "MSA", …}
```

### Sharing — read the reference first

`create_share_link` (a URL) and `grant_item_access` (named people, plus an
email sent as the connected account) are different acts with defaults a user
can be held to afterwards. Read `references/sharing-and-permissions.md` before
any share, grant or revoke request: it has the `link_type` / `scope` matrix,
why `anonymous` is never a guess, and why an `inherited: True` permission
cannot be revoked from here.

### Deleting and copying

`delete_item` and `delete_list_item` send the item to the site's recycle bin,
where a user can restore it for 93 days. Say that when the user hesitates —
and still never delete anything they did not name.

`copy_item` returns immediately with nothing; SharePoint performs the copy in
the background. Confirm it by listing the destination folder a moment later
rather than by trusting the empty result.

### Multiple connected SharePoint tenants

When several SharePoint connections exist, the system prompt's
`<external_apps>` block already says how to disambiguate: pick silently when
the user named one, otherwise ask. Pass the choice through the implicit
`connection_id` argument every action accepts — e.g.
`sharepoint.list_libraries(connection_id="3f1a…", site_id="…")`.

Calling one without `connection_id` while several are connected raises
`EXTERNAL_APP_AMBIGUOUS_CONNECTION` listing the candidates — recover per the
upstream rule.

### Failures worth recognising

- `itemNotFound` on a site or a library the user swears exists → the connected
  account is not a member of that site. Say so: SharePoint permissions bound
  this connection, and no retry fixes it.
- `accessDenied` on a write while reads work → the account has read-only
  access to that site.
- `ADMIN_CONSENT_REQUIRED` → the tenant has not authorised Fretik. Stop, tell
  the user their IT admin must install the app for the organization (the
  connect modal has an "Install for the entire organization" toggle). Do not
  retry.
- HTTP 400 "too many resources" on `list_list_items` → the filter or sort hits
  a column SharePoint has not indexed on a list past 5 000 rows. Narrow to an
  indexed column (`Created`, `Modified`, `ID`, `Title`) or page through
  unfiltered.

### Reaching SharePoint from the other Microsoft apps

The ids come from the neighbouring app; nothing here needs a different call.

- **A Teams channel's documents** — `teams.get_channel_files_folder` answers
  a `drive_id` + `folder_id` that every action here takes. That is how you
  read, or upload into, the Files tab of a channel.
- **A file someone posted in Teams** — pass the attachment's `content_url` to
  `resolve_share_link` to get the `DriveItem`, then move it, set its
  metadata, or read its versions.
- **An email attachment** — `outlook.download_message_attachment` spills to
  `sandbox_path`; upload that path here.
- **Sharing a document by email or in Teams** — `create_share_link` for a
  URL, or hand `web_url` to `teams.send_channel_message(attachments=[...])`.
  Teams links the file without granting access to it, so pair it with
  `create_share_link(scope="organization")` outside the file's own site.

---

## Write actions & approval

Write actions NEVER execute on their own: `.op(...)` builds an operation,
`run_plan([...])` submits them, and calling a write action directly raises.
The user approves the whole plan at once.

- One write:   `run_plan([ sharepoint.create_folder.op(drive_id="…", name="…") ])`
- Many writes: `run_plan([ sharepoint.<action>.op(...), ... ])`

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
