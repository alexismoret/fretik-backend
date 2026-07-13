---
name: outlook
description: Microsoft Outlook — read and send email, organize mail folders, and manage calendar events and contacts on the user's connected Outlook account.
version: 4a50eb8c8c2c
---

# Microsoft Outlook — 38 actions

You can interact with the user's Microsoft Outlook account via the `fretik_apps.outlook` Python module.

## Read actions (auto-approved, eager)

- `outlook.list_messages(folder="inbox", unread_only=None, limit=25, offset=0)` — List emails from a well-known mail folder
- `outlook.get_message(message_id)` — Fetch one email by ID, with its full HTML body
- `outlook.search_messages(query, limit=25, offset=0)` — Full-text search across the mailbox
- `outlook.list_messages_in_folder(folder_id, unread_only=None, limit=25, offset=0)` — List emails from a custom folder by its folder ID
- `outlook.list_folders()` — List the top-level mail folders of the mailbox
- `outlook.list_message_attachments(message_id)` — List attachments on a message (metadata only — no content)
- `outlook.download_message_attachment(message_id, attachment_id)` — Download one attachment in base64 (file attachments only)
- `outlook.list_calendars()` — List every calendar the user can access (default, shared, secondary)
- `outlook.list_calendar_events(start, end, limit=50, offset=0, calendar_id=None)` — List calendar events within a date window
- `outlook.get_calendar_event(event_id, calendar_id=None)` — Fetch one calendar event by ID
- `outlook.list_event_instances(event_id, start, end, limit=50, offset=0, calendar_id=None)` — List the individual occurrences of a recurring event in a date window
- `outlook.list_contacts(limit=50, offset=0)` — List contacts from the mailbox
- `outlook.list_inbox_rules()` — List the inbox rules configured on the mailbox

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
- `outlook.delete_messages(message_ids)` — Delete up to 20 messages in a single Graph $batch request
- `outlook.move_messages(message_ids, destination_folder_id)` — Move up to 20 messages to a folder in a single Graph $batch request
- `outlook.mark_messages_read(message_ids)` — Mark up to 20 messages as read in a single Graph $batch request
- `outlook.mark_messages_unread(message_ids)` — Mark up to 20 messages as unread in a single Graph $batch request
- `outlook.mark_read(message_id)` — Mark a message as read
- `outlook.mark_unread(message_id)` — Mark a message as unread
- `outlook.flag_message(message_id, status="flagged", due_date=None, time_zone="UTC")` — Set the follow-up flag on a message (flag / mark complete / clear)
- `outlook.create_folder(display_name, parent_folder_id=None)` — Create a new mail folder
- `outlook.create_calendar_event(subject, start, end, time_zone="UTC", location=None, attendees=None, body_html=None, is_online_meeting=None, calendar_id=None)` — Create a calendar event
- `outlook.update_calendar_event(event_id, subject=None, start=None, end=None, time_zone="UTC", location=None, body_html=None, calendar_id=None)` — Update fields of an existing calendar event
- `outlook.delete_calendar_event(event_id, calendar_id=None)` — Delete a calendar event
- `outlook.respond_to_event(event_id, response, comment=None, calendar_id=None)` — Accept, decline or tentatively accept a meeting invite
- `outlook.create_contact(given_name, surname=None, email=None, company_name=None, job_title=None, mobile_phone=None)` — Create a new contact
- `outlook.create_inbox_rule(display_name, sequence=1, is_enabled=True, from_addresses=None, subject_contains=None, body_contains=None, has_attachments=None, move_to_folder_id=None, mark_as_read=None, auto_delete=None)` — Create an inbox rule (e.g. move incoming mail from a sender to a folder)
- `outlook.update_inbox_rule(rule_id, display_name=None, sequence=None, is_enabled=None, from_addresses=None, subject_contains=None, body_contains=None, has_attachments=None, move_to_folder_id=None, mark_as_read=None, auto_delete=None)` — Update an existing inbox rule (PATCH semantics, all fields optional)
- `outlook.delete_inbox_rule(rule_id)` — Delete an inbox rule

## Data models

Read actions return Pydantic models — field names below are EXACT. Use the names as-is (`m.from_address`, NOT `m.sender` or `m.from_`). A trailing `?` marks an optional field.

- `EmailAddress` — `address: str`, `name?: str`
- `Message` — `id: str`, `subject: str`, `from_address: str`, `to: list[str]`, `received_at: str`, `is_read: bool`, `has_attachments: bool`, `body_preview: str`, `web_link?: str`
- `MessageFull` — `id: str`, `subject: str`, `from_address: str`, `to: list[str]`, `cc: list[str]`, `received_at: str`, `is_read: bool`, `has_attachments: bool`, `body_html: str`, `web_link?: str`
- `MailFolder` — `id: str`, `display_name: str`, `parent_folder_id?: str`, `total_item_count: int`, `unread_item_count: int`
- `CalendarEvent` — `id: str`, `subject: str`, `start: str`, `end: str`, `location?: str`, `organizer?: str`, `attendees: list[str]`, `is_online_meeting: bool`, `body_preview?: str`, `web_link?: str`
- `Contact` — `id: str`, `display_name: str`, `email_addresses: list[str]`, `company_name?: str`, `job_title?: str`, `mobile_phone?: str`
- `WriteResult` — `id?: str`
- `Calendar` — `id: str`, `name: str`, `is_default_calendar: bool`, `can_edit: bool`, `color?: str`, `owner?: str`
- `BatchWriteResult` — `id: str`, `ok: bool`, `error?: str`
- `Attachment` — `id: str`, `name: str`, `content_type: str`, `size_bytes: int`, `sandbox_path?: str`, `content_base64?: str`
- `InboxRule` — `id: str`, `display_name: str`, `sequence: int`, `is_enabled: bool`, `is_read_only: bool`, `has_error?: bool`, `from_addresses?: list[str]`, `subject_contains?: list[str]`, `body_contains?: list[str]`, `has_attachments?: bool`, `move_to_folder_id?: str`, `mark_as_read?: bool`, `auto_delete?: bool`

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

When the team has several Outlook mailboxes — or other email connections
(`imap-smtp`, future Gmail, …) — the system prompt's `<external_apps>`
section already tells you how to disambiguate: pick silently when the user
named one, otherwise call `askUserQuestion`. Pass the chosen connection
via the implicit `connection_id="<uuid>"` arg, accepted by every action in
the SDK:

```python
outlook.send_email(
    connection_id="3f1a…-pro",
    to=["client@example.com"],
    subject="…",
    body_html="…",
)
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

## Voice & persona — write according to the connection's persona

Each connection of category `communication` carries a `persona` option
exposed in the system prompt's `<external_apps>` block. Read it BEFORE
drafting a message and adapt your voice accordingly.

### `persona: personal` — write AS the user, not AS an AI

This connection is the user's personal account. You are drafting on their
behalf — to the recipient it must look like the user wrote it.

- **NEVER** mention that you are an AI, an assistant, or a bot. No "I'd be
  happy to…", no "As your assistant…", no automated signatures like "Sent
  from Fretik".
- **Calibrate to whatever you actually know about how the user writes.**
  - If you already have examples in this turn's context — the thread you
    just read, a message the user paraphrased, prior conversation history,
    a sample in `searchKnowledge` — internalize that. Do NOT fetch more.
  - Otherwise, look up a couple of the user's past outbound messages on
    this channel via the read actions listed at the top of this SKILL
    (the one that lists messages the user has sent, then fetch one to
    see its full body).
  - From any example, internalize: how they sign off (full name, first
    name, an informal phrase, or nothing — some users never sign, do NOT
    invent a signature in that case), formality, sentence length, greeting
    habits, plain text vs HTML, emoji use.
  - **Do NOT quote or paraphrase the examples** — internalize the style.
- **Match the language to the situation, not to the user.** Replies and
  forwards continue in the language of the message you are answering. New
  outbound messages match what is natural for that recipient given any
  available signal (their past messages, their name, the explicit
  instruction the user gave you in this turn). When in doubt, use the
  language of the user's last message in this conversation.
- Write in plain, human prose. Short sentences. Match register exactly.
- If you have no calibration signal at all, default to plain human prose
  and DO NOT add a signature unless the user explicitly asked.

### `persona: bot` — write openly as Fretik / a team assistant

This connection is an assumed team / bot account. Standard assistant tone
applies: structured if helpful, clear, professional.

### Approval still applies in both modes

`persona` changes the voice, not the gate. Every write still goes through
`run_plan([...])` and the user reviews the draft before it leaves.

---

## Write actions & approval

Write actions NEVER execute on their own. Build them with `.op()` and
submit them together via `run_plan([...])` — the user approves the whole
plan ONCE.

- One write: `outlook.send_email(to=["name@example.com"], subject="…", body_html="…")`
- Many writes: `run_plan([ outlook.<action>.op(...), ... ])`

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
