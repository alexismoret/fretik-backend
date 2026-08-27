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

from fretik_apps import outlook, run_plan
run_plan([outlook.send_email.op(
    to=["client@example.com"],
    subject="Monthly report",
    body_html="<p>Please find the report attached.</p>",
    attachments=[{
        "name": "report.pdf",
        "content_type": "application/pdf",
        "content_base64": content,
    }],
)])
```

### Multiple connected mailboxes

When the team has several Outlook mailboxes — or other email connections
(`imap-smtp`, future Gmail, …) — the system prompt's `<external_apps>`
section already tells you how to disambiguate: pick silently when the user
named one, otherwise call `askUserQuestion`. Pass the chosen connection
via the implicit `connection_id="<uuid>"` arg, accepted by every action in
the SDK:

```python
run_plan([outlook.send_email.op(
    connection_id="3f1a…-pro",
    to=["client@example.com"],
    subject="…",
    body_html="…",
)])
```

If you call a write without `connection_id` and several Outlook mailboxes
are connected, the dispatcher raises `EXTERNAL_APP_AMBIGUOUS_CONNECTION`
listing the candidates — recover by picking one per the rule above.

### Bulk writes — prefer `*_messages` over `run_plan([*_message] * N)`

For >5 messages, use the batch variants — one Graph `$batch` request
per call (cap **20 messages each**, loop in Python for larger sets) +
one approval row with a count instead of N separate rows:

- `outlook.delete_messages(message_ids=[...])` (max 20)
- `outlook.move_messages(message_ids=[...], destination_folder_id=...)` (max 20)
- `outlook.mark_messages_read(message_ids=[...])` / `mark_messages_unread` (max 20)

Returns `list[BatchWriteResult]` with per-id `ok` + optional `error` —
partial failures don't block the batch. Retry only the failed ones.
`id` in the result is the batch index (`"0".."19"`); zip with your
input list to recover the original `message_id`.

```python
ids = [m.id for m in outlook.list_messages(folder="junkemail", limit=100)]
for chunk_start in range(0, len(ids), 20):
    chunk = ids[chunk_start:chunk_start + 20]
    run_plan([outlook.delete_messages.op(message_ids=chunk)])
```

### Pagination

All list/search actions accept `limit` (max 100) and `offset` (default
0, Graph `$skip`). Walk via `offset=0`, `offset=100`, `offset=200`, ….

### Flagging a message

`flag_message(message_id, status, due_date=None)` with `status` one of
`flagged` / `complete` / `notFlagged`:

- `flagged` (default) — mark for follow-up, optional `due_date` (ISO 8601).
- `complete` — mark a previously flagged message as done (the check
  appears in Outlook).
- `notFlagged` — clear the flag.

### Calendar — ISO 8601 datetimes

`start` / `end` for `create_calendar_event` and `update_calendar_event` must be
ISO 8601 strings (`"2026-06-01T09:00:00"`). Pass `time_zone` separately —
default is UTC. For `list_calendar_events`, use the same ISO 8601 format for
the `start` / `end` window.

### Multiple calendars

By default every calendar action targets the user's primary calendar.
To work on shared / secondary calendars: call `list_calendars()`, pick
the `id`, then pass `calendar_id=<id>` to any of `list_calendar_events`,
`get_calendar_event`, `create_calendar_event`, `update_calendar_event`,
`delete_calendar_event`, `respond_to_event`, `list_event_instances`.

### Recurring events

`list_calendar_events(start, end)` already expands recurring series
within the window (it uses `/calendarView` server-side). To get only
the occurrences of one specific master series, call
`list_event_instances(event_id=<master_id>, start=..., end=...)`.

### Folders

Well-known mail folders use lowercase identifiers in the path: `inbox`,
`sentitems`, `drafts`, `deleteditems`, `archive`, `junkemail`. For a custom
folder, fetch its ID with `list_folders()` first and then call
`list_messages_in_folder(folder_id=...)`.
