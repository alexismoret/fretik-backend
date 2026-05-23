## Patterns

### Read an email, then act on it

Read the message in **one turn**, inspect the result, then in the **next turn**
build the plan with concrete message IDs as literals — see the read→write rule
in the approval flow section below.

```python
# Turn 1 — read
from fretik_apps import outlook
msgs = outlook.list_messages(folder="inbox", unread_only=True, limit=10)
for m in msgs:
    print(m.id, m.subject, m.from_address)
```

```python
# Turn 2 — write a plan with literal message IDs
from fretik_apps import outlook, run_plan
run_plan([
    outlook.reply_email.op(
        message_id="AAMkAGUz...",
        body_html="<p>Got it, will reply tomorrow.</p>",
    ),
])
```

### Send several emails in one approval

`run_plan` accepts any mix of write ops — including N copies of the same one.
Use it instead of a Python loop calling `outlook.send_email()` directly: one
plan = one approval card = one click.

```python
from fretik_apps import outlook, run_plan
run_plan([
    outlook.send_email.op(
        to=["alice@example.com"],
        subject="Weekly update",
        body_html="<p>Hello Alice…</p>",
    ),
    outlook.send_email.op(
        to=["bob@example.com"],
        subject="Weekly update",
        body_html="<p>Hello Bob…</p>",
    ),
])
```

### Cross-provider plans

A single `run_plan` can mix providers (`outlook.<...>.op(...)` plus
`teams.<...>.op(...)`). The user approves the whole bundle in one card.

### Attachments

`send_email`, `reply_email`, `reply_all_email`, `forward_email` and
`create_draft` accept an optional `attachments` parameter — a list of objects
with `name`, `content_type` and `content_base64`. Microsoft Graph limits
inline attachments to ~3 MB each; encode your file's bytes with
`base64.b64encode(...).decode()`.

```python
import base64
with open("/workspace/outputs/report.pdf", "rb") as f:
    content = base64.b64encode(f.read()).decode()

from fretik_apps import outlook
outlook.send_email(
    to=["client@example.com"],
    subject="Monthly report",
    body_html="<p>Please find the report attached.</p>",
    attachments=[{
        "name": "report.pdf",
        "content_type": "application/pdf",
        "content_base64": content,
    }],
)
```

### Multiple connected mailboxes

When the user has connected several Outlook mailboxes (e.g. a "Pro" and a
"Personal"), calling a write without specifying which to use returns the
`EXTERNAL_APP_AMBIGUOUS_CONNECTION` error with the list of available IDs and
display names. Re-emit the call with `connection_id="<uuid>"` — every action
in the SDK accepts this implicit framework arg:

```python
outlook.send_email(
    connection_id="3f1a…-pro",
    to=["client@example.com"],
    subject="…",
    body_html="…",
)
```

The list of connected mailboxes is also surfaced in the agent system prompt
under "Connected external apps" with each connection's ID and display name.

### Calendar — ISO 8601 datetimes

`start` / `end` for `create_calendar_event` and `update_calendar_event` must be
ISO 8601 strings (`"2026-06-01T09:00:00"`). Pass `time_zone` separately —
default is UTC. For `list_calendar_events`, use the same ISO 8601 format for
the `start` / `end` window.

### Folders

Well-known mail folders use lowercase identifiers in the path: `inbox`,
`sentitems`, `drafts`, `deleteditems`, `archive`, `junkemail`. For a custom
folder, fetch its ID with `list_folders()` first and then call
`list_messages_in_folder(folder_id=...)`.
