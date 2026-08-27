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
