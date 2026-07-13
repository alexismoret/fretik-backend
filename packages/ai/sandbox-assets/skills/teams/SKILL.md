---
name: teams
description: Microsoft Teams — read and send chat messages, and manage meetings and calls on the user's connected Teams account.
version: 968ed00ba1e1
---

# Microsoft Teams — 20 actions

You can interact with the user's Microsoft Teams account via the `fretik_apps.teams` Python module.

## Read actions (auto-approved, eager)

- `teams.list_chats(limit=20)` — List the user's recent 1:1, group, and meeting chats
- `teams.get_chat(chat_id)` — Fetch one chat by ID
- `teams.list_chat_members(chat_id)` — List the members of a chat
- `teams.list_chat_messages(chat_id, limit=20)` — List recent messages in a chat (newest first)
- `teams.get_chat_message(chat_id, message_id)` — Fetch one chat message by ID
- `teams.list_joined_teams()` — List every team the user belongs to
- `teams.get_team(team_id)` — Fetch one team by ID
- `teams.list_team_members(team_id)` — List the members of a team
- `teams.list_channels(team_id)` — List the channels inside a team
- `teams.list_channel_messages(team_id, channel_id, limit=20)` — List recent top-level messages in a channel (newest first)
- `teams.get_channel_message(team_id, channel_id, message_id)` — Fetch one channel message by ID
- `teams.list_channel_message_replies(team_id, channel_id, message_id, limit=20)` — List the replies of a channel thread (oldest first)
- `teams.search_messages(query, limit=10)` — Full-text search across chat AND channel messages (single Graph call)
- `teams.find_user(query, limit=10)` — Look up users in the tenant by name or email prefix
- `teams.get_user_presence(user_id=None)` — Get the availability of a user (defaults to the signed-in user)
- `teams.download_message_attachment(content_url)` — Resolve a Teams attachment sharing link to a direct download URL

## Write actions (require user approval — build with `.op()`)

- `teams.send_chat_message(chat_id, body_html, inline_images=None)` — Post a message to a 1:1, group, or meeting chat
- `teams.create_chat(member_user_ids, topic=None)` — Create a 1:1 or group chat with one or more users
- `teams.send_channel_message(team_id, channel_id, body_html, subject=None, inline_images=None)` — Post a new top-level message in a channel
- `teams.reply_to_channel_message(team_id, channel_id, message_id, body_html, inline_images=None)` — Reply inside an existing channel thread (preserves the thread)

## Data models

Read actions return Pydantic models — field names below are EXACT. Use the names as-is (`m.from_address`, NOT `m.sender` or `m.from_`). A trailing `?` marks an optional field.

- `Chat` — `id: str`, `topic?: str`, `chat_type: Literal["oneOnOne", "group", "meeting", "unknownFutureValue"]`, `last_updated_at: str`, `web_url?: str`
- `ChatMember` — `id: str`, `display_name: str`, `email?: str`, `user_id?: str`, `roles: list[str]`
- `ChatMessage` — `id: str`, `body_html: str`, `from_user: str`, `from_user_id?: str`, `created_at: str`, `importance?: str`, `attachments?: list[dict]`
- `Team` — `id: str`, `display_name: str`, `description?: str`, `visibility: Literal["private", "public", "hiddenMembership", "unknownFutureValue"]`, `web_url?: str`
- `Channel` — `id: str`, `display_name: str`, `description?: str`, `membership_type: Literal["standard", "private", "shared", "unknownFutureValue"]`, `web_url?: str`
- `ChannelMessage` — `id: str`, `subject?: str`, `body_html: str`, `from_user: str`, `from_user_id?: str`, `created_at: str`, `web_url?: str`, `attachments?: list[dict]`
- `TeamMember` — `id: str`, `display_name: str`, `email?: str`, `user_id?: str`, `roles: list[str]`
- `Presence` — `id: str`, `availability: str`, `activity: str`
- `User` — `id: str`, `display_name: str`, `email?: str`, `user_principal_name?: str`
- `Attachment` — `id: str`, `name: str`, `content_type: str`, `size_bytes?: int`, `content_url?: str`, `download_url?: str`, `sandbox_path?: str`, `content_base64?: str`
- `SearchHit` — `kind: Literal["chat", "channel"]`, `chat_id?: str`, `team_id?: str`, `channel_id?: str`, `message_id: str`, `body_preview: str`, `from_user: str`, `created_at: str`, `web_url?: str`
- `WriteResult` — `id?: str`

## Patterns

### Find a conversation, then act on it

`search_messages` covers chats AND channels in one Graph call — Teams is too
noisy to enumerate by hand. Each hit's `kind: "chat" | "channel"` tells you
which read action to follow up with.

```python
from fretik_apps import teams
for h in teams.search_messages(query="Q3 roadmap", limit=10):
    if h.kind == "channel":
        teams.list_channel_message_replies(
            team_id=h.team_id, channel_id=h.channel_id,
            message_id=h.message_id, limit=5,
        )
    else:
        teams.list_chat_messages(chat_id=h.chat_id, limit=5)
```

### Reply in a thread vs start a new one

`reply_to_channel_message` posts inside the existing thread.
`send_channel_message` starts a NEW thread — only use it when there is no
parent to attach to.

### Start a chat with someone new

`create_chat` takes Azure AD user IDs (NOT emails). Resolve a name with
`find_user`, then submit one approval:

```python
from fretik_apps import teams, run_plan
matches = teams.find_user(query="alice")
# pick one based on display_name / email, then:
run_plan([teams.create_chat.op(member_user_ids=["<aad-user-id-from-matches>"])])
```

### Receiving file attachments

Messages with file attachments expose `attachments[].content_url` (OneDrive /
SharePoint sharing link). Pass it to `download_message_attachment` — the
binary is auto-spilled to `Attachment.sandbox_path`, ready for `vision`,
`pypdf`, `pillow`, etc.

```python
msg = teams.get_chat_message(chat_id="19:…", message_id="170…")
if msg.attachments:
    att = teams.download_message_attachment(content_url=msg.attachments[0]["content_url"])
    # att.sandbox_path → "/workspace/attachments/abc12345_report.pdf"
```

Only file-reference attachments (OneDrive / SharePoint) are supported.
Inline `hostedContents` images on incoming messages and adaptive cards are
not exposed.

### Sending inline images

`send_chat_message`, `send_channel_message`, and `reply_to_channel_message`
accept an optional `inline_images: [{name, content_type, content_base64}]`.
Each image rides inline (Graph `hostedContents`), embedded as a base64
payload — max ~4 MB per image, `image/png`/`image/jpeg`/`image/gif` only.
The mapper appends `<img>` tags to `body_html` automatically.

```python
import base64
from fretik_apps import teams, run_plan

with open("/workspace/outputs/chart.png", "rb") as f:
    encoded = base64.b64encode(f.read()).decode()

run_plan([
    teams.send_chat_message.op(
        chat_id="19:…",
        body_html="<p>Voici le graphe de la semaine.</p>",
        inline_images=[{
            "name": "chart.png",
            "content_type": "image/png",
            "content_base64": encoded,
        }],
    ),
])
```

### Sending non-image files

Not supported — Microsoft Graph requires uploading the file to OneDrive
first, which is not part of v1. If the user really needs to share a PDF /
Excel, embed a clickable URL in `body_html` (any URL they already have).

### Multiple connected Teams tenants

When several Teams connections exist — or other communication connections
(`outlook`, `imap-smtp`, …) — the system prompt's `<external_apps>` block
handles disambiguation. Pass the chosen `connection_id` explicitly:

```python
teams.send_chat_message(
    connection_id="3f1a…-contoso",
    chat_id="19:…",
    body_html="<p>Hi.</p>",
)
```

Calling a write without `connection_id` while several Teams tenants are
connected raises `EXTERNAL_APP_AMBIGUOUS_CONNECTION` — recover per the
upstream rule.

### Admin consent failures

`ADMIN_CONSENT_REQUIRED` on a write means the user's tenant has not
authorised Fretik. Stop, tell the user their IT admin must install the app
for the organization (the connect modal has an "Install for the entire
organization" toggle). Do not retry.

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

- One write: `teams.send_chat_message(chat_id="…", body_html="…")`
- Many writes: `run_plan([ teams.<action>.op(...), ... ])`

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
