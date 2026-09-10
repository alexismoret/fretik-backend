## Patterns

### Find a conversation, then act on it

`search_messages` covers chats AND channels in one Graph call — Teams is too
noisy to enumerate by hand. Each hit's `kind: "chat" | "channel"` tells you
which read action to follow up with.

```python
from fretik_apps import teams
for h in teams.search_messages(query="Q3 roadmap", limit=10):
    if h.kind == "channel":
        teams.list_channel_message_replies(
            team_id=h.team_id, channel_id=h.channel_id,
            message_id=h.message_id, limit=5,
        )
    else:
        teams.list_chat_messages(chat_id=h.chat_id, limit=5)
```

### Reply in a thread vs start a new one

`reply_to_channel_message` posts inside the existing thread.
`send_channel_message` starts a NEW thread — only use it when there is no
parent to attach to.

### Start a chat with someone new

`create_chat` takes Azure AD user IDs (NOT emails). Resolve a name with
`find_user`, then submit one approval:

```python
from fretik_apps import teams, run_plan
matches = teams.find_user(query="alice")
# pick one based on display_name / email, then:
run_plan([teams.create_chat.op(member_user_ids=["<aad-user-id-from-matches>"])])
```

### Receiving file attachments

Messages with file attachments expose `attachments[].content_url` (OneDrive /
SharePoint sharing link). Pass it to `download_message_attachment` — the
binary is auto-spilled to `Attachment.sandbox_path`, ready for `vision`,
`pypdf`, `pillow`, etc.

```python
msg = teams.get_chat_message(chat_id="19:…", message_id="170…")
if msg.attachments:
    att = teams.download_message_attachment(content_url=msg.attachments[0]["content_url"])
    # att.sandbox_path → "/workspace/attachments/abc12345_report.pdf"
```

Only file-reference attachments (OneDrive / SharePoint) are supported.
Inline `hostedContents` images on incoming messages and adaptive cards are
not exposed.

### Sending inline images

`send_chat_message`, `send_channel_message`, and `reply_to_channel_message`
accept an optional `inline_images: [{name, content_type, content_base64}]`.
Each image rides inline (Graph `hostedContents`), embedded as a base64
payload — max ~4 MB per image, `image/png`/`image/jpeg`/`image/gif` only.
The mapper appends `<img>` tags to `body_html` automatically.

```python
import base64
from fretik_apps import teams, run_plan

with open("/workspace/outputs/chart.png", "rb") as f:
    encoded = base64.b64encode(f.read()).decode()

run_plan([
    teams.send_chat_message.op(
        chat_id="19:…",
        body_html="<p>Voici le graphe de la semaine.</p>",
        inline_images=[{
            "name": "chart.png",
            "content_type": "image/png",
            "content_base64": encoded,
        }],
    ),
])
```

### Sending a document

A Teams message never carries file bytes — it carries a LINK to a file that
already lives in SharePoint. That is what `attachments=[{name, content_url}]`
does, and why it needs no file permission.

**The file is already in SharePoint** — one approval:

```python
doc = sharepoint.search(query='filetype:pdf "Q1 report"', limit=1)[0]
run_plan([teams.send_channel_message.op(
    team_id="…", channel_id="19:…",
    body_html="<p>Le rapport Q1.</p>",
    attachments=[{"name": doc.name, "content_url": doc.web_url}],
)])
```

**The file is not there yet** — put it in the channel's own folder first.
`get_channel_files_folder` hands you the exact `drive_id` + `folder_id` the
sharepoint app takes, so the document lands in the Files tab of that channel
rather than in some unrelated library:

```python
f = teams.get_channel_files_folder(team_id="…", channel_id="19:…")
# → f.drive_id, f.folder_id  → sharepoint.create_upload_session(...)
```

Upload per `sharepoint`'s reference, then attach the resulting `web_url` in a
second turn — the upload and the message are two writes, and operations in
one plan must be independent.

**Access is not granted for you.** Teams links the file; it does not share
it. Anyone in the channel already has access to that channel's folder, so a
channel post is safe. For a chat, or a file from another site, pair it with
`sharepoint.create_share_link(scope="organization")` or
`grant_item_access` — otherwise the recipient gets a link that 403s.

If there is genuinely no SharePoint connection, fall back to putting a
clickable URL in `body_html`.

### Multiple connected Teams tenants

When several Teams connections exist — or other communication connections
(`outlook`, `imap-smtp`, …) — the system prompt's `<external_apps>` block
handles disambiguation. Pass the chosen `connection_id` explicitly:

```python
run_plan([teams.send_chat_message.op(
    connection_id="3f1a…-contoso",
    chat_id="19:…",
    body_html="<p>Hi.</p>",
)])
```

Calling a write without `connection_id` while several Teams tenants are
connected raises `EXTERNAL_APP_AMBIGUOUS_CONNECTION` — recover per the
upstream rule.

### Admin consent failures

`ADMIN_CONSENT_REQUIRED` on a write means the user's tenant has not
authorised Fretik. Stop, tell the user their IT admin must install the app
for the organization (the connect modal has an "Install for the entire
organization" toggle). Do not retry.
