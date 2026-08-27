---
name: exchange
description: Microsoft Exchange (EWS) — read and send email, and manage calendar and contacts on the user's connected on-premises or hosted Exchange account.
version: 70099c2efe67
---

# Microsoft Exchange — 33 actions

You can interact with the user's Microsoft Exchange account via the `fretik_apps.exchange` Python module.

## Read actions (auto-approved, eager)

- `exchange.list_messages(folder="inbox", unread_only=None, limit=25, offset=0)` — List emails from a well-known mail folder
- `exchange.get_message(message_id)` — Fetch one email by ID, with its full HTML body
- `exchange.search_messages(query, limit=25, offset=0)` — Search the Inbox with an Exchange AQS query
- `exchange.list_messages_in_folder(folder_id, unread_only=None, limit=25, offset=0)` — List emails from a custom folder by its folder ID
- `exchange.list_folders()` — List every mail folder of the mailbox
- `exchange.list_message_attachments(message_id)` — List attachments on a message (metadata only — no content)
- `exchange.download_message_attachment(message_id, attachment_id)` — Download one attachment — binary is spilled to `sandbox_path`
- `exchange.list_calendar_events(start, end, limit=50, offset=0)` — List calendar events in a date window (recurring series expanded)
- `exchange.get_calendar_event(event_id)` — Fetch one calendar event by ID
- `exchange.list_contacts(limit=50, offset=0)` — List contacts from the mailbox
- `exchange.list_inbox_rules()` — List the inbox rules configured on the mailbox (read-only)

## Write actions (require user approval — build with `.op()`)

- `exchange.send_email.op(to, subject, body_html, cc=None, bcc=None, attachments=None)` — Send a new email immediately (with optional attachments)
- `exchange.reply_email.op(message_id, body_html)` — Reply to the sender of a message
- `exchange.reply_all_email.op(message_id, body_html)` — Reply to all recipients of a message
- `exchange.forward_email.op(message_id, to, comment=None)` — Forward a message to new recipients (with optional comment)
- `exchange.create_draft.op(to, subject, body_html, cc=None, attachments=None)` — Create a draft email (not sent)
- `exchange.update_draft.op(message_id, subject=None, body_html=None)` — Update the subject or body of an existing draft
- `exchange.delete_message.op(message_id)` — Delete a message (moves it to Deleted Items)
- `exchange.move_message.op(message_id, destination_folder_id)` — Move a message to another folder
- `exchange.copy_message.op(message_id, destination_folder_id)` — Copy a message into another folder
- `exchange.delete_messages.op(message_ids)` — Delete multiple messages in one batch (move to Deleted Items)
- `exchange.move_messages.op(message_ids, destination_folder_id)` — Move multiple messages to another folder in one batch
- `exchange.mark_messages_read.op(message_ids)` — Mark multiple messages as read
- `exchange.mark_messages_unread.op(message_ids)` — Mark multiple messages as unread
- `exchange.mark_read.op(message_id)` — Mark a message as read
- `exchange.mark_unread.op(message_id)` — Mark a message as unread
- `exchange.flag_message.op(message_id, status="flagged", due_date=None)` — Set the follow-up flag on a message (flag / mark complete / clear)
- `exchange.create_folder.op(display_name, parent_folder_id=None)` — Create a new mail folder
- `exchange.create_calendar_event.op(subject, start, end, location=None, attendees=None, body_html=None, is_online_meeting=None)` — Create a calendar event
- `exchange.update_calendar_event.op(event_id, subject=None, start=None, end=None, location=None, body_html=None)` — Update fields of an existing calendar event
- `exchange.delete_calendar_event.op(event_id)` — Delete a calendar event (cancels for attendees)
- `exchange.respond_to_event.op(event_id, response, comment=None)` — Accept, decline or tentatively accept a meeting invite
- `exchange.create_contact.op(given_name, surname=None, email=None, company_name=None, job_title=None, mobile_phone=None)` — Create a new contact

## Data models

Read actions return Pydantic models — field names below are EXACT. Use the names as-is (`m.from_address`, NOT `m.sender` or `m.from_`). A trailing `?` marks an optional field.

- `Message` — `id: str`, `subject: str`, `from_address: str`, `to: list[str]`, `received_at: str`, `is_read: bool`, `has_attachments: bool`, `body_preview: str`
- `MessageFull` — `id: str`, `subject: str`, `from_address: str`, `to: list[str]`, `cc: list[str]`, `received_at: str`, `is_read: bool`, `has_attachments: bool`, `body_html: str`
- `MailFolder` — `id: str`, `display_name: str`, `parent_folder_id?: str`, `total_item_count: int`, `unread_item_count: int`
- `CalendarEvent` — `id: str`, `subject: str`, `start: str`, `end: str`, `location?: str`, `organizer?: str`, `attendees: list[str]`, `is_online_meeting: bool`, `body_preview?: str`
- `Contact` — `id: str`, `display_name: str`, `email_addresses: list[str]`, `company_name?: str`, `job_title?: str`, `mobile_phone?: str`
- `InboxRule` — `id: str`, `display_name: str`, `sequence: int`, `is_enabled: bool`, `has_error?: bool`
- `WriteResult` — `id?: str`
- `Attachment` — `id: str`, `name: str`, `content_type: str`, `size_bytes: int`, `sandbox_path?: str`, `content_base64?: str`

## Patterns

### Read an email, then act on it

Read in **one turn**, inspect the result, then in the **next turn** build the plan
with concrete message IDs as literals.

```python
# Turn 1 — read
from fretik_apps import exchange
msgs = exchange.list_messages(folder="inbox", unread_only=True, limit=10)
for m in msgs:
    print(m.id, m.subject, m.from_address)
```

```python
# Turn 2 — reply with a literal message ID
from fretik_apps import exchange, run_plan
run_plan([
    exchange.reply_email.op(
        message_id="AAMkAGI2...",
        body_html="<p>Got it, will reply tomorrow.</p>",
    ),
])
```

`reply_email`, `reply_all_email` and `forward_email` thread natively (EWS quotes the
original) — pass only your new text in `body_html` / `comment`.

### Bulk writes — prefer `*_messages` over a loop

For several messages, use the batch variants — one EWS round-trip and one approval
row with a count, instead of N single calls:

- `exchange.delete_messages(message_ids=[...])` (moves to Deleted Items)
- `exchange.move_messages(message_ids=[...], destination_folder_id=...)`
- `exchange.mark_messages_read(message_ids=[...])` / `mark_messages_unread`

### Attachments

`send_email` and `create_draft` accept `attachments` — a list of `{name,
content_type, content_base64}`. Encode bytes with `base64.b64encode(...).decode()`.
`download_message_attachment` spills the binary to `sandbox_path` (its
`content_base64` is always `None`); read the file from that path.

### Folders

Well-known folders: `inbox`, `sentitems`, `drafts`, `deleteditems`, `archive`,
`junkemail`. For a custom folder, call `list_folders()`, take its `id`, then pass it
to `list_messages_in_folder(folder_id=...)`. The same `id` is accepted as
`destination_folder_id` and `parent_folder_id`.

### Search — Inbox only, AQS syntax

`search_messages(query=...)` runs an Exchange AQS query on the **Inbox**. AQS
supports field scopes and boolean operators, e.g.
`subject:invoice AND from:alice@example.com`, `received:today`, `hasattachments:true`.
For other folders, use `list_messages_in_folder` + a Python filter.

### Calendar — pass ISO 8601 with an offset

`list_calendar_events(start, end)` returns occurrences within the window (recurring
series are expanded). For `create_calendar_event` / `update_calendar_event`, give
`start` / `end` as ISO 8601 **with a timezone offset** (e.g. `2026-06-01T09:00:00Z`)
so the instant is unambiguous.

### Field types gotcha

`Message.to` / `Message.cc` are `list[str]` — use `", ".join(m.to)` to format.
`list_messages` returns light summaries (no recipient list, no body); call
`get_message(message_id=...)` for the full `to` / `cc` and HTML body.

### Not available

`flag_message` needs Exchange 2013+. Inbox rules are **read-only**
(`list_inbox_rules`) — there is no create/edit/delete (EWS rule writes would risk
wiping the user's existing Outlook rules).

### Multiple connected mailboxes

When the team has several Exchange mailboxes — or other email connections
(`outlook`, `imap-smtp`, …) — the system prompt's `<external_apps>` section already
tells you how to disambiguate: pick silently when the user named one, otherwise ask.
Pass the chosen connection via the implicit `connection_id="<uuid>"` arg, accepted by
every action:

```python
run_plan([exchange.send_email.op(
    connection_id="3f1a…-ops",
    to=["client@example.com"],
    subject="…",
    body_html="…",
)])
```

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

Write actions NEVER execute on their own: `.op(...)` builds an operation,
`run_plan([...])` submits them, and calling a write action directly raises.
The user approves the whole plan at once.

- One write: `run_plan([ exchange.send_email.op(to=["name@example.com"], subject="…", body_html="…") ])`
- Many writes: `run_plan([ exchange.<action>.op(...), ... ])`

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
