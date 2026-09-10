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
