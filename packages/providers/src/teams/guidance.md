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

### Sending non-image files

Not supported — Microsoft Graph requires uploading the file to OneDrive
first, which is not part of v1. If the user really needs to share a PDF /
Excel, embed a clickable URL in `body_html` (any URL they already have).

### Multiple connected Teams tenants

When several Teams connections exist — or other communication connections
(`outlook`, `imap-smtp`, …) — the system prompt's `<external_apps>` block
handles disambiguation. Pass the chosen `connection_id` explicitly:

```python
teams.send_chat_message(
    connection_id="3f1a…-contoso",
    chat_id="19:…",
    body_html="<p>Hi.</p>",
)
```

Calling a write without `connection_id` while several Teams tenants are
connected raises `EXTERNAL_APP_AMBIGUOUS_CONNECTION` — recover per the
upstream rule.

### Admin consent failures

`ADMIN_CONSENT_REQUIRED` on a write means the user's tenant has not
authorised Fretik. Stop, tell the user their IT admin must install the app
for the organization (the connect modal has an "Install for the entire
organization" toggle). Do not retry.
