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

from fretik_apps import imap_smtp, run_plan
run_plan([imap_smtp.send_email.op(
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
run_plan([imap_smtp.send_email.op(
    connection_id="3f1a…-work",
    to=["client@example.com"],
    subject="…",
    body_html="…",
)])
```

If you call a write without `connection_id` and several mailboxes are
connected, the dispatcher raises `EXTERNAL_APP_AMBIGUOUS_CONNECTION`
listing the candidates — recover by picking one per the rule above.
