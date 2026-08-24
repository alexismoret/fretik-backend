---
name: imap-smtp
description: Email over IMAP/SMTP — read, search, and send email on the user's connected mailbox for any standards-based provider (Gmail app password, OVH, Fastmail, custom servers, …).
version: dfe6d94f548a
---

# Email (IMAP/SMTP) — 19 actions

You can interact with the user's Email (IMAP/SMTP) account via the `fretik_apps.imap_smtp` Python module.

## Read actions (auto-approved, eager)

- `imap_smtp.list_messages(folder="inbox", unread_only=None, limit=25, offset=0)` — List emails from a well-known mail folder, newest received_at first
- `imap_smtp.get_message(message_id)` — Fetch one email by ID, with its full HTML body
- `imap_smtp.search_messages(query=None, query_or=None, limit=25, offset=0)` — Full-text search across the INBOX, newest received_at first
- `imap_smtp.list_messages_in_folder(folder_id, unread_only=None, limit=25, offset=0)` — List emails from a custom folder by its folder ID, newest received_at first
- `imap_smtp.list_folders()` — List every mail folder of the mailbox
- `imap_smtp.list_message_attachments(message_id)` — List attachments on a message (metadata only — no content)
- `imap_smtp.download_message_attachment(message_id, attachment_id)` — Download one attachment — binary is spilled to `sandbox_path`

## Write actions (require user approval — build with `.op()`)

- `imap_smtp.send_email(to, subject, body_html, cc=None, bcc=None, attachments=None)` — Send a new email immediately (with optional attachments)
- `imap_smtp.reply_email(message_id, body_html, attachments=None)` — Reply to the sender of a message (preserves In-Reply-To threading)
- `imap_smtp.forward_email(message_id, to, comment=None, attachments=None)` — Forward a message to new recipients (with optional comment)
- `imap_smtp.mark_read(message_id)` — Mark a message as read (sets the \Seen flag)
- `imap_smtp.mark_unread(message_id)` — Mark a message as unread (clears the \Seen flag)
- `imap_smtp.delete_message(message_id)` — Move a message to Trash (or expunge if no Trash folder exists)
- `imap_smtp.move_message(message_id, destination_folder_id)` — Move a message to another folder
- `imap_smtp.delete_messages(message_ids)` — Delete multiple messages in a single IMAP batch (move to Trash, or expunge if no Trash exists)
- `imap_smtp.move_messages(message_ids, destination_folder_id)` — Move multiple messages to another folder in a single IMAP batch
- `imap_smtp.mark_messages_read(message_ids)` — Mark multiple messages as read (single IMAP STORE per source folder)
- `imap_smtp.mark_messages_unread(message_ids)` — Mark multiple messages as unread (single IMAP STORE per source folder)
- `imap_smtp.create_folder(display_name, parent_folder_id=None)` — Create a new mail folder

## Data models

Read actions return Pydantic models — field names below are EXACT. Use the names as-is (`m.from_address`, NOT `m.sender` or `m.from_`). A trailing `?` marks an optional field.

- `Message` — `id: str`, `subject: str`, `from_address: str`, `to: list[str]`, `received_at: str`, `is_read: bool`, `has_attachments: bool`, `body_preview: str`
- `MessageFull` — `id: str`, `subject: str`, `from_address: str`, `to: list[str]`, `cc: list[str]`, `received_at: str`, `is_read: bool`, `has_attachments: bool`, `body_html: str`
- `MailFolder` — `id: str`, `display_name: str`, `parent_folder_id?: str`, `total_item_count: int`, `unread_item_count: int`
- `Attachment` — `id: str`, `name: str`, `content_type: str`, `size_bytes: int`, `sandbox_path?: str`, `content_base64?: str`
- `WriteResult` — `id?: str`

## Patterns

### Read an email, then act on it

Read the message in **one turn**, inspect the result, then in the **next turn**
build the plan with concrete message IDs as literals — see the read→write rule
in the approval flow section below.

```python
# Turn 1 — read
from fretik_apps import imap_smtp
msgs = imap_smtp.list_messages(folder="inbox", unread_only=True, limit=10)
for m in msgs:
    print(m.id, m.subject, m.from_address)
```

```python
# Turn 2 — write a plan with literal message IDs
from fretik_apps import imap_smtp, run_plan
run_plan([
    imap_smtp.reply_email.op(
        message_id="SU5CT1g.4271",
        body_html="<p>Got it, will reply tomorrow.</p>",
    ),
])
```

### Send several emails in one approval

`run_plan` accepts any mix of write ops — including N copies of the same one.
Use it instead of a Python loop calling `imap_smtp.send_email()` directly: one
plan = one approval card = one click.

```python
from fretik_apps import imap_smtp, run_plan
run_plan([
    imap_smtp.send_email.op(
        to=["alice@example.com"],
        subject="Weekly update",
        body_html="<p>Hello Alice…</p>",
    ),
    imap_smtp.send_email.op(
        to=["bob@example.com"],
        subject="Weekly update",
        body_html="<p>Hello Bob…</p>",
    ),
])
```

### Attachments

`send_email`, `reply_email` and `forward_email` accept an optional
`attachments` parameter — a list of objects with `name`, `content_type` and
`content_base64`. Encode your file's bytes with `base64.b64encode(...).decode()`.

```python
import base64
with open("/workspace/outputs/report.pdf", "rb") as f:
    content = base64.b64encode(f.read()).decode()

from fretik_apps import imap_smtp
imap_smtp.send_email(
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

### Bulk writes — prefer `*_messages` over `run_plan([*_message] * N)`

For >5 messages, use the batch variants — one IMAP round-trip per
source folder + one approval row with a count, instead of N
connections + N approval rows:

- `imap_smtp.delete_messages(message_ids=[...])`
- `imap_smtp.move_messages(message_ids=[...], destination_folder_id=...)`
- `imap_smtp.mark_messages_read(message_ids=[...])` / `mark_messages_unread`

Mixed-folder ids are grouped server-side; each returns `list[WriteResult]`.

### Folders

Well-known folder aliases (RFC 6154 SPECIAL-USE, plus Gmail's
`\Important` extension): `inbox`, `sentitems`, `drafts`, `deleteditems`,
`archive`, `junkemail`, `flagged`, `important`, `allmail`. For a custom
folder, call `list_folders()`, take its `id`, then pass it to
`list_messages_in_folder(folder_id=...)`. The same path is accepted as
`destination_folder_id` and `parent_folder_id`.

### Search — INBOX only, no Gmail `OR` syntax

`search_messages(query=...)` runs an IMAP TEXT search on the **INBOX
only** (deliberate v1 limit; for other folders, use
`list_messages_in_folder` + Python filter).

**IMAP TEXT does NOT parse the Gmail-style `OR` keyword.** For
alternatives, use the dedicated param:
`search_messages(query_or=["github", "vercel", "sentry"])` (native
IMAP `SEARCH OR`). Exactly one of `query` / `query_or` is required.

### Field types gotcha

`Message.to` and `Message.cc` are `list[str]` — use `", ".join(m.to)`
to format. `f"{m.to:60s}"` raises `TypeError`.

### Reply vs. forward

- `reply_email` sends to the original sender only — sets the `In-Reply-To`
  and `References` headers so the response threads correctly in the
  recipient's client.
- `forward_email` re-sends the original (subject prefixed with `Fwd:`,
  body quoted) to a new recipient list. Optional `comment` is added above
  the quote.

There is **no `reply_all_email`** in v1: the original CC list isn't always
easy to reconstruct cleanly over raw IMAP. If you need to reply to multiple
recipients, use `send_email(to=[...])` with explicit addresses.

### Multiple connected mailboxes

When the team has several IMAP/SMTP mailboxes — or other email connections
(`outlook`, future Gmail, …) — the system prompt's `<external_apps>`
section already tells you how to disambiguate: pick silently when the user
named one, otherwise call `askUserQuestion`. Pass the chosen connection
via the implicit `connection_id="<uuid>"` arg, accepted by every action in
the SDK:

```python
imap_smtp.send_email(
    connection_id="3f1a…-work",
    to=["client@example.com"],
    subject="…",
    body_html="…",
)
```

If you call a write without `connection_id` and several mailboxes are
connected, the dispatcher raises `EXTERNAL_APP_AMBIGUOUS_CONNECTION`
listing the candidates — recover by picking one per the rule above.

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

- One write: `imap_smtp.send_email(to=["name@example.com"], subject="…", body_html="…")`
- Many writes: `run_plan([ imap_smtp.<action>.op(...), ... ])`

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
