---
name: outlook
description: Microsoft Outlook — read inbox, send email, manage calendar and contacts
version: 2508735c3e8a
---

# Microsoft Outlook — 28 actions

You can interact with the user's Microsoft Outlook account via the `fretik_apps.outlook` Python module.

## Read actions (auto-approved, eager)

- `outlook.list_messages(folder="inbox", unread_only=None, limit=25)` — List emails from a well-known mail folder
- `outlook.get_message(message_id)` — Fetch one email by ID, with its full HTML body
- `outlook.search_messages(query, limit=25)` — Full-text search across the mailbox
- `outlook.list_messages_in_folder(folder_id, unread_only=None, limit=25)` — List emails from a custom folder by its folder ID
- `outlook.list_folders()` — List the top-level mail folders of the mailbox
- `outlook.list_message_attachments(message_id)` — List attachments on a message (metadata only — no content)
- `outlook.download_message_attachment(message_id, attachment_id)` — Download one attachment in base64 (file attachments only)
- `outlook.list_calendar_events(start, end, limit=50)` — List calendar events within a date window
- `outlook.get_calendar_event(event_id)` — Fetch one calendar event by ID
- `outlook.list_contacts(limit=50)` — List contacts from the mailbox

## Write actions (require user approval — build with `.op()`)

- `outlook.send_email(to, subject, body_html, cc=None, bcc=None, attachments=None)` — Send a new email immediately (with optional inline attachments < 3MB)
- `outlook.reply_email(message_id, body_html, attachments=None)` — Reply to the sender of a message (with optional attachments)
- `outlook.reply_all_email(message_id, body_html, attachments=None)` — Reply to all recipients of a message (with optional attachments)
- `outlook.forward_email(message_id, to, comment=None, attachments=None)` — Forward a message to new recipients (with optional attachments)
- `outlook.create_draft(to, subject, body_html, cc=None, attachments=None)` — Create a draft email (not sent), with optional attachments
- `outlook.update_draft(message_id, subject=None, body_html=None)` — Update the subject or body of an existing draft
- `outlook.delete_message(message_id)` — Delete a message (moves it to Deleted Items)
- `outlook.move_message(message_id, destination_folder_id)` — Move a message to another mail folder
- `outlook.copy_message(message_id, destination_folder_id)` — Copy a message into another mail folder
- `outlook.mark_read(message_id)` — Mark a message as read
- `outlook.mark_unread(message_id)` — Mark a message as unread
- `outlook.flag_message(message_id)` — Flag a message for follow-up
- `outlook.create_folder(display_name, parent_folder_id=None)` — Create a new mail folder
- `outlook.create_calendar_event(subject, start, end, time_zone="UTC", location=None, attendees=None, body_html=None, is_online_meeting=None)` — Create a calendar event
- `outlook.update_calendar_event(event_id, subject=None, start=None, end=None, time_zone="UTC", location=None, body_html=None)` — Update fields of an existing calendar event
- `outlook.delete_calendar_event(event_id)` — Delete a calendar event
- `outlook.respond_to_event(event_id, response, comment=None)` — Accept, decline or tentatively accept a meeting invite
- `outlook.create_contact(given_name, surname=None, email=None, company_name=None, job_title=None, mobile_phone=None)` — Create a new contact

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

---

## Write actions & approval

Write actions NEVER execute on their own. Build them with `.op()` and
submit them together via `run_plan([...])` — the user approves the whole
plan ONCE.

- One write: `outlook.send_email(to=[...], subject="…", body_html="…")`
- Many writes: `run_plan([ <provider>.<action>.op(...), ... ])`

When you call `run_plan` (or a direct write), it raises
`fretik_apps.ApprovalPending`. This is EXPECTED — not an error. STOP.
The user reviews the plan in the UI; you will be prompted to continue.
When prompted, RE-RUN THE EXACT SAME CODE — the approved plan then
executes; reads re-run harmlessly. If the user rejects, you receive
their feedback as a message — adapt and write new code.

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

- Operations in one plan must be INDEPENDENT (no op uses another op's
  result). Dependent steps (create_folder, then move into it) → use
  TWO turns.
- For several writes, ALWAYS use a single `run_plan` — never chain
  bare writes.
- Partial failures come back per-op; re-submit a `run_plan` with only
  the failed ops.
