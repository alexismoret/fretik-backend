---
name: front
description: Front — read inbox, send email, manage calendar and contacts
version: 011397f3e17b
---

# Front — 30 actions

You can interact with the user's Front account via the `fretik_apps.front` Python module.

## Read actions (auto-approved, eager)

- `front.list_inboxes(limit=50, page_token=None)` — List the Front inboxes the connection can access
- `front.list_teammates(limit=50, page_token=None)` — List teammates in the Front company
- `front.list_tags(limit=50, page_token=None)` — List company tags (used to resolve names to tag IDs)
- `front.list_conversations(inbox_id=None, status=None, limit=25, page_token=None)` — List conversations, optionally scoped to one inbox
- `front.search_conversations(query, limit=25, page_token=None)` — Full-text search using Front search syntax
- `front.get_conversation(conversation_id)` — Fetch conversation metadata (status, assignee, tags, …)
- `front.list_conversation_messages(conversation_id, limit=20, page_token=None)` — List messages in a conversation thread (paginated)
- `front.list_conversation_comments(conversation_id, limit=25, page_token=None)` — List internal comments (notes) on a conversation
- `front.list_conversation_events(conversation_id, limit=25, page_token=None)` — List the event history of a conversation (audit log)
- `front.list_contacts(updated_after=None, updated_before=None, limit=50, page_token=None)` — List contacts in the Front company
- `front.get_contact(contact_id)` — Fetch one contact by ID
- `front.find_contact(handle, limit=25, page_token=None)` — Find contacts by handle (email / phone) via conversation search
- `front.list_rules(limit=50, page_token=None)` — List Front automation rules (read-only)
- `front.get_rule(rule_id)` — Fetch one automation rule by ID

## Write actions (require user approval — build with `.op()`)

- `front.reply_to_conversation(conversation_id, body_html, text=None, channel_id=None, to=None, cc=None, bcc=None, archive_after=None, tag_ids_after=None, attachments=None)` — Reply to a conversation thread
- `front.send_new_message(channel_id, to, body_html, cc=None, bcc=None, subject=None, text=None, sender_name=None, tag_ids=None, attachments=None)` — Send a new outbound message (starts a new conversation)
- `front.update_conversation(conversation_id, status=None, assignee_id=None, inbox_id=None)` — Update conversation status, assignee, or inbox (archive / reopen / move / assign)
- `front.delete_conversation(conversation_id)` — Permanently delete a conversation
- `front.add_conversation_tags(conversation_id, tag_ids)` — Add tags to a conversation (additive)
- `front.remove_conversation_tags(conversation_id, tag_ids)` — Remove tags from a conversation
- `front.add_conversation_comment(conversation_id, body, attachments=None)` — Add an internal comment (note) to a conversation
- `front.snooze_conversation(conversation_id, scheduled_at, teammate_id=None)` — Snooze a conversation until a future timestamp
- `front.unsnooze_conversation(conversation_id, teammate_id=None)` — Cancel an active snooze on a conversation
- `front.add_conversation_followers(conversation_id, teammate_ids)` — Add teammates as followers of a conversation
- `front.remove_conversation_followers(conversation_id, teammate_ids)` — Remove teammates from the followers of a conversation
- `front.create_contact(handles, name=None, description=None, links=None, is_spammer=None)` — Create a new contact
- `front.update_contact(contact_id, name=None, description=None, is_spammer=None, links=None)` — Update an existing contact (PATCH semantics)
- `front.create_tag(name, highlight=None, is_visible_in_conversation_lists=True, parent_tag_id=None)` — Create a new company tag
- `front.update_tag(tag_id, name=None, highlight=None, parent_tag_id=None)` — Update a tag (rename / recolor / re-parent)
- `front.delete_tag(tag_id)` — Delete a tag (removes it from every conversation it was on)

## Data models

Read actions return Pydantic models — field names below are EXACT. Use the names as-is (`m.from_address`, NOT `m.sender` or `m.from_`). A trailing `?` marks an optional field.

- `Inbox` — `id: str`, `name: str`, `type?: str`, `is_private: bool`, `send_as?: str`
- `Teammate` — `id: str`, `email: str`, `username: str`, `first_name?: str`, `last_name?: str`, `is_available: bool`, `is_admin: bool`
- `Tag` — `id: str`, `name: str`, `highlight?: str`, `is_private: bool`, `is_visible_in_conversation_lists: bool`, `parent_tag_id?: str`
- `Handle` — `handle: str`, `source: str`
- `Contact` — `id: str`, `name?: str`, `description?: str`, `handles: list[dict]`, `links?: list[str]`, `updated_at?: str`
- `Conversation` — `id: str`, `subject?: str`, `status: str`, `assignee_id?: str`, `recipient_handle?: str`, `tag_ids: list[str]`, `inbox_ids: list[str]`, `last_message_preview?: str`, `last_message_at?: str`, `created_at?: str`, `merged_into_conversation_id?: str`
- `Message` — `id: str`, `type: str`, `is_inbound: bool`, `is_draft: bool`, `subject?: str`, `from_handle?: str`, `to: list[str]`, `cc: list[str]`, `body_html: str`, `text?: str`, `created_at?: str`
- `Comment` — `id: str`, `author_id?: str`, `body: str`, `created_at?: str`
- `ConversationEvent` — `id: str`, `type: str`, `emitted_at?: str`, `source_id?: str`, `target_id?: str`
- `Rule` — `id: str`, `name: str`, `is_private: bool`, `actions: list[str]`
- `WriteResult` — `id?: str`
- `InboxPage` — `items: list[Inbox]`, `page_token?: str` (pass back to the same action to fetch the next page)
- `TeammatePage` — `items: list[Teammate]`, `page_token?: str` (pass back to the same action to fetch the next page)
- `TagPage` — `items: list[Tag]`, `page_token?: str` (pass back to the same action to fetch the next page)
- `ConversationPage` — `items: list[Conversation]`, `page_token?: str` (pass back to the same action to fetch the next page)
- `MessagePage` — `items: list[Message]`, `page_token?: str` (pass back to the same action to fetch the next page)
- `CommentPage` — `items: list[Comment]`, `page_token?: str` (pass back to the same action to fetch the next page)
- `ConversationEventPage` — `items: list[ConversationEvent]`, `page_token?: str` (pass back to the same action to fetch the next page)
- `ContactPage` — `items: list[Contact]`, `page_token?: str` (pass back to the same action to fetch the next page)
- `RulePage` — `items: list[Rule]`, `page_token?: str` (pass back to the same action to fetch the next page)

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

- One write: `front.reply_to_conversation(conversation_id="…", body_html="…")`
- Many writes: `run_plan([ front.<action>.op(...), ... ])`

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
