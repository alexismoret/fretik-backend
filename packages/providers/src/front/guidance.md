## Patterns

### Triage a conversation

Read first, then plan. Filter by `inbox_id` + `status` to keep the
listing small — Front's max page size is 100.

```python
from fretik_apps import front, run_plan

inboxes = front.list_inboxes(limit=10)
support = next(i for i in inboxes.items if i.name == "Support")

page = front.list_conversations(
    inbox_id=support.id, status="unassigned", limit=25,
)
for c in page.items:
    print(c.id, c.subject, c.last_message_preview)
```

### Reply to a conversation

```python
run_plan([
    front.reply_to_conversation.op(
        conversation_id="cnv_abc",
        body_html="<p>Got it — looking into this now.</p>",
        archive_after=True,
    ),
])
```

### Send a new outbound conversation

Pick a channel deliberately when the inbox has more than one.

```python
run_plan([
    front.send_new_message.op(
        channel_id="cha_xyz",
        to=["client@example.com"],
        subject="Follow-up",
        body_html="<p>Hello…</p>",
    ),
])
```

### Update conversation state (one action covers everything)

`update_conversation` handles archive / reopen / assign / unassign /
move to inbox / mark spam in a single PATCH. Pass `assignee_id=""` to
unassign.

```python
run_plan([
    front.update_conversation.op(
        conversation_id="cnv_abc",
        status="archived",
        assignee_id="tea_lea",
    ),
])
```

### Add or remove tags (additive)

`update_conversation` does NOT take `tag_ids` — Front's `PATCH
conversation.tag_ids` REPLACES the whole set. Always go through
`add_conversation_tags` / `remove_conversation_tags`.

```python
run_plan([
    front.add_conversation_tags.op(
        conversation_id="cnv_abc", tag_ids=["tag_urgent", "tag_billing"],
    ),
])
```

### Leave an internal note

```python
run_plan([
    front.add_conversation_comment.op(
        conversation_id="cnv_abc",
        body="Heads up @lea — customer is escalating.",
    ),
])
```

Front resolves `@username` mentions automatically from the comment body
— use `list_teammates()` to get the right usernames.

### Pagination — cursor only

Front has no `offset`. Every list/search action returns a `XxxPage`
with `items` (typed list) and an optional `page_token`. Pass it back to
fetch the next page; iterate until `page_token is None`.

```python
all_open = []
token = None
while True:
    page = front.list_conversations(
        inbox_id=support.id, status="open", limit=100, page_token=token,
    )
    all_open.extend(page.items)
    if page.page_token is None:
        break
    token = page.page_token
```

For most chatbot workflows, a single `limit=100` page is enough —
paginate only when the user explicitly asks for "all".

### Search syntax

`search_conversations(query=...)` passes through Front's search
language. Supported operators:

| Operator                                                | Example                                                              |
| ------------------------------------------------------- | -------------------------------------------------------------------- |
| `is:`                                                   | `is:open`, `is:unassigned`, `is:snoozed`, `is:trashed`, `is:waiting` |
| `inbox:<id>`                                            | `inbox:inb_123`                                                      |
| `tag:<id>`                                              | `tag:tag_urgent`                                                     |
| `assignee:<id>`                                         | `assignee:tea_lea`                                                   |
| `from:<handle>` / `to:` / `cc:` / `bcc:` / `recipient:` | `from:user@example.com`                                              |
| `participant:<teammate_id>` / `author:` / `mention:`    | by teammate involvement                                              |
| `before:<epoch>` / `after:<epoch>` / `during:<epoch>`   | Time windows (Unix seconds)                                          |
| `custom_field:<name>=<value>`                           | `custom_field:order_id=A123`                                         |
| free text / `"quoted phrase"`                           | full-text                                                            |

Combine with whitespace: `is:unassigned tag:tag_urgent before:1716800000`.

**Rate-limit caveat:** search is rate-capped at **40% of the company
quota** — prefer `list_conversations` with filters when a simple
status/inbox filter does the job.

### 202 async on sends

`reply_to_conversation` and `send_new_message` return HTTP 202 — Front
delivers asynchronously and there is no message id in the immediate
response. The action returns `WriteResult { id: None }`; treat it as
success and do not poll.

### Custom fields on contacts — full set or unset

`update_contact` accepts only top-level fields (name, description,
is_spammer, links). Front's `PATCH /contacts/{id}` with a partial
`custom_fields` REPLACES the whole map — for now we do not expose
custom-field edits to keep the failure mode out of the agent's hands.

### Don't loop on 429

Front explicitly extends the back-off window when callers retry inside
an active `Retry-After`. The Nango proxy already honors
`X-RateLimit-Reset` / `Retry-After` automatically — if a call fails
with 429, surface it to the user, do not loop.

### Multiple connected Front workspaces

When the team has several Front connections, the system prompt's
`<external_apps>` section already tells you how to disambiguate: pick
silently when the user named one, otherwise call `askUserQuestion`.
Pass the chosen connection via the implicit `connection_id="<uuid>"`
arg — accepted by every action in the SDK:

```python
front.list_conversations(connection_id="3f1a…-pro", inbox_id="inb_x", limit=20)
```

If you call a write without `connection_id` and several Front
workspaces are connected, the dispatcher raises
`EXTERNAL_APP_AMBIGUOUS_CONNECTION` listing the candidates.

### Attachments

`reply_to_conversation`, `send_new_message`, and
`add_conversation_comment` accept an `attachments` array — each item is
`{ name, content_type, content_base64 }`. Encode the bytes with
`base64.b64encode(...).decode()`.
