# AUTO-GENERATED from manifest.ts — do not edit by hand. Regenerate: bun run gen:sdk

"""Microsoft Teams provider — 20 actions.

All calls go through fretik-backend, which dispatches them to the
provider (Nango Proxy or a custom handler). Write actions return an
Operation via `.op(...)`; submit them with run_plan([...]).
Calling a write action directly raises — it never executes.
"""

from typing import Any, Literal, Optional
from pydantic import BaseModel
from ._runtime import FretikActionError, Operation, _call_read


# ── Types ─────────────────────────────────────────────────────────

class Chat(BaseModel):
    id: str
    chat_type: Literal["oneOnOne", "group", "meeting", "unknownFutureValue"]
    last_updated_at: str
    topic: str | None = None
    web_url: str | None = None


class ChatMember(BaseModel):
    id: str
    display_name: str
    roles: list[str]
    email: str | None = None
    user_id: str | None = None


class ChatMessage(BaseModel):
    id: str
    body_html: str
    from_user: str
    created_at: str
    from_user_id: str | None = None
    importance: str | None = None
    attachments: list[dict[str, Any]] | None = None


class Team(BaseModel):
    id: str
    display_name: str
    visibility: Literal["private", "public", "hiddenMembership", "unknownFutureValue"]
    description: str | None = None
    web_url: str | None = None


class Channel(BaseModel):
    id: str
    display_name: str
    membership_type: Literal["standard", "private", "shared", "unknownFutureValue"]
    description: str | None = None
    web_url: str | None = None


class ChannelMessage(BaseModel):
    id: str
    body_html: str
    from_user: str
    created_at: str
    subject: str | None = None
    from_user_id: str | None = None
    web_url: str | None = None
    attachments: list[dict[str, Any]] | None = None


class TeamMember(BaseModel):
    id: str
    display_name: str
    roles: list[str]
    email: str | None = None
    user_id: str | None = None


class Presence(BaseModel):
    id: str
    availability: str
    activity: str


class User(BaseModel):
    id: str
    display_name: str
    email: str | None = None
    user_principal_name: str | None = None


class Attachment(BaseModel):
    id: str
    name: str
    content_type: str
    size_bytes: int | None = None
    content_url: str | None = None
    download_url: str | None = None
    sandbox_path: str | None = None
    content_base64: str | None = None


class SearchHit(BaseModel):
    kind: Literal["chat", "channel"]
    message_id: str
    body_preview: str
    from_user: str
    created_at: str
    chat_id: str | None = None
    team_id: str | None = None
    channel_id: str | None = None
    web_url: str | None = None


class WriteResult(BaseModel):
    id: str | None = None


# ── Per-action argument models (Pydantic validation in-sandbox) ──

class ListChatsArgs(BaseModel):
    limit: int | None = 20


class GetChatArgs(BaseModel):
    chat_id: str


class ListChatMembersArgs(BaseModel):
    chat_id: str


class ListChatMessagesArgs(BaseModel):
    chat_id: str
    limit: int | None = 20


class GetChatMessageArgs(BaseModel):
    chat_id: str
    message_id: str


class SendChatMessageArgs(BaseModel):
    chat_id: str
    body_html: str
    inline_images: list[dict[str, Any]] | None = None


class CreateChatArgs(BaseModel):
    member_user_ids: list[str]
    topic: str | None = None


class ListJoinedTeamsArgs(BaseModel):
    pass


class GetTeamArgs(BaseModel):
    team_id: str


class ListTeamMembersArgs(BaseModel):
    team_id: str


class ListChannelsArgs(BaseModel):
    team_id: str


class ListChannelMessagesArgs(BaseModel):
    team_id: str
    channel_id: str
    limit: int | None = 20


class GetChannelMessageArgs(BaseModel):
    team_id: str
    channel_id: str
    message_id: str


class ListChannelMessageRepliesArgs(BaseModel):
    team_id: str
    channel_id: str
    message_id: str
    limit: int | None = 20


class SendChannelMessageArgs(BaseModel):
    team_id: str
    channel_id: str
    body_html: str
    subject: str | None = None
    inline_images: list[dict[str, Any]] | None = None


class ReplyToChannelMessageArgs(BaseModel):
    team_id: str
    channel_id: str
    message_id: str
    body_html: str
    inline_images: list[dict[str, Any]] | None = None


class SearchMessagesArgs(BaseModel):
    query: str
    limit: int | None = 10


class FindUserArgs(BaseModel):
    query: str
    limit: int | None = 10


class GetUserPresenceArgs(BaseModel):
    user_id: str | None = None


class DownloadMessageAttachmentArgs(BaseModel):
    content_url: str


# ── Read actions (eager — execute immediately) ─────────

def list_chats(
    limit: int | None = 20,
    connection_id: str | None = None,
) -> list[Chat]:
    """List the user's recent 1:1, group, and meeting chats

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = ListChatsArgs(limit=limit).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("teams.list_chats", _args)
    return [Chat(**item) for item in data]


def get_chat(
    chat_id: str,
    connection_id: str | None = None,
) -> Chat:
    """Fetch one chat by ID

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = GetChatArgs(chat_id=chat_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("teams.get_chat", _args)
    return Chat(**data)


def list_chat_members(
    chat_id: str,
    connection_id: str | None = None,
) -> list[ChatMember]:
    """List the members of a chat

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = ListChatMembersArgs(chat_id=chat_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("teams.list_chat_members", _args)
    return [ChatMember(**item) for item in data]


def list_chat_messages(
    chat_id: str,
    limit: int | None = 20,
    connection_id: str | None = None,
) -> list[ChatMessage]:
    """List recent messages in a chat (newest first)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = ListChatMessagesArgs(chat_id=chat_id, limit=limit).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("teams.list_chat_messages", _args)
    return [ChatMessage(**item) for item in data]


def get_chat_message(
    chat_id: str,
    message_id: str,
    connection_id: str | None = None,
) -> ChatMessage:
    """Fetch one chat message by ID

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = GetChatMessageArgs(chat_id=chat_id, message_id=message_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("teams.get_chat_message", _args)
    return ChatMessage(**data)


def list_joined_teams(
    connection_id: str | None = None,
) -> list[Team]:
    """List every team the user belongs to

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = ListJoinedTeamsArgs().model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("teams.list_joined_teams", _args)
    return [Team(**item) for item in data]


def get_team(
    team_id: str,
    connection_id: str | None = None,
) -> Team:
    """Fetch one team by ID

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = GetTeamArgs(team_id=team_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("teams.get_team", _args)
    return Team(**data)


def list_team_members(
    team_id: str,
    connection_id: str | None = None,
) -> list[TeamMember]:
    """List the members of a team

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = ListTeamMembersArgs(team_id=team_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("teams.list_team_members", _args)
    return [TeamMember(**item) for item in data]


def list_channels(
    team_id: str,
    connection_id: str | None = None,
) -> list[Channel]:
    """List the channels inside a team

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = ListChannelsArgs(team_id=team_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("teams.list_channels", _args)
    return [Channel(**item) for item in data]


def list_channel_messages(
    team_id: str,
    channel_id: str,
    limit: int | None = 20,
    connection_id: str | None = None,
) -> list[ChannelMessage]:
    """List recent top-level messages in a channel (newest first)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = ListChannelMessagesArgs(team_id=team_id, channel_id=channel_id, limit=limit).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("teams.list_channel_messages", _args)
    return [ChannelMessage(**item) for item in data]


def get_channel_message(
    team_id: str,
    channel_id: str,
    message_id: str,
    connection_id: str | None = None,
) -> ChannelMessage:
    """Fetch one channel message by ID

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = GetChannelMessageArgs(team_id=team_id, channel_id=channel_id, message_id=message_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("teams.get_channel_message", _args)
    return ChannelMessage(**data)


def list_channel_message_replies(
    team_id: str,
    channel_id: str,
    message_id: str,
    limit: int | None = 20,
    connection_id: str | None = None,
) -> list[ChannelMessage]:
    """List the replies of a channel thread (oldest first)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = ListChannelMessageRepliesArgs(team_id=team_id, channel_id=channel_id, message_id=message_id, limit=limit).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("teams.list_channel_message_replies", _args)
    return [ChannelMessage(**item) for item in data]


def search_messages(
    query: str,
    limit: int | None = 10,
    connection_id: str | None = None,
) -> list[SearchHit]:
    """Full-text search across chat AND channel messages (single Graph call)

    query: Free-text query — KQL syntax supported. MUST be non-empty; Microsoft Graph rejects empty queries with HTTP 400. To browse without a search, use `list_chats` / `list_channel_messages` instead.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = SearchMessagesArgs(query=query, limit=limit).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("teams.search_messages", _args)
    return [SearchHit(**item) for item in data]


def find_user(
    query: str,
    limit: int | None = 10,
    connection_id: str | None = None,
) -> list[User]:
    """Look up users in the tenant by name or email prefix

    query: Name fragment or email prefix

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = FindUserArgs(query=query, limit=limit).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("teams.find_user", _args)
    return [User(**item) for item in data]


def get_user_presence(
    user_id: str | None = None,
    connection_id: str | None = None,
) -> Presence:
    """Get the availability of a user (defaults to the signed-in user)

    user_id: Azure AD user ID from `find_user`. Omit for the signed-in user.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = GetUserPresenceArgs(user_id=user_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("teams.get_user_presence", _args)
    return Presence(**data)


def download_message_attachment(
    content_url: str,
    connection_id: str | None = None,
) -> Attachment:
    """Resolve a Teams attachment sharing link to a direct download URL

    content_url: Sharing URL from `ChatMessage.attachments[].content_url` / `ChannelMessage.attachments[].content_url`

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = DownloadMessageAttachmentArgs(content_url=content_url).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("teams.download_message_attachment", _args)
    return Attachment(**data)


# ── Write actions (use `.op(...)` inside run_plan([...])) ───

def _send_chat_message_op(
    chat_id: str,
    body_html: str,
    inline_images: list[dict[str, Any]] | None = None,
    connection_id: str | None = None,
) -> Operation:
    """Build a send_chat_message Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = SendChatMessageArgs(chat_id=chat_id, body_html=body_html, inline_images=inline_images).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="teams.send_chat_message", args=_args)

def send_chat_message(
    chat_id: str,
    body_html: str,
    inline_images: list[dict[str, Any]] | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Post a message to a 1:1, group, or meeting chat

    (WRITE — build it with `send_chat_message.op(...)` and submit
    it with `run_plan([...])`. Calling this directly raises.)

    body_html: Message body — HTML or plain text

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    raise FretikActionError(
        "send_chat_message is a WRITE action and does not execute on its own. "
        "Build it with .op(...) and submit it with run_plan([...]): "
        "run_plan([teams.send_chat_message.op(...)])"
    )

send_chat_message.op = _send_chat_message_op


def _create_chat_op(
    member_user_ids: list[str],
    topic: str | None = None,
    connection_id: str | None = None,
) -> Operation:
    """Build a create_chat Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = CreateChatArgs(member_user_ids=member_user_ids, topic=topic).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="teams.create_chat", args=_args)

def create_chat(
    member_user_ids: list[str],
    topic: str | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Create a 1:1 or group chat with one or more users

    (WRITE — build it with `create_chat.op(...)` and submit
    it with `run_plan([...])`. Calling this directly raises.)

    member_user_ids: Azure AD user IDs to add (NOT emails — use `find_user` first). The signed-in user is included implicitly.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    raise FretikActionError(
        "create_chat is a WRITE action and does not execute on its own. "
        "Build it with .op(...) and submit it with run_plan([...]): "
        "run_plan([teams.create_chat.op(...)])"
    )

create_chat.op = _create_chat_op


def _send_channel_message_op(
    team_id: str,
    channel_id: str,
    body_html: str,
    subject: str | None = None,
    inline_images: list[dict[str, Any]] | None = None,
    connection_id: str | None = None,
) -> Operation:
    """Build a send_channel_message Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = SendChannelMessageArgs(team_id=team_id, channel_id=channel_id, body_html=body_html, subject=subject, inline_images=inline_images).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="teams.send_channel_message", args=_args)

def send_channel_message(
    team_id: str,
    channel_id: str,
    body_html: str,
    subject: str | None = None,
    inline_images: list[dict[str, Any]] | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Post a new top-level message in a channel

    (WRITE — build it with `send_channel_message.op(...)` and submit
    it with `run_plan([...])`. Calling this directly raises.)

    subject: Optional thread title — shown in bold above the message body

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    raise FretikActionError(
        "send_channel_message is a WRITE action and does not execute on its own. "
        "Build it with .op(...) and submit it with run_plan([...]): "
        "run_plan([teams.send_channel_message.op(...)])"
    )

send_channel_message.op = _send_channel_message_op


def _reply_to_channel_message_op(
    team_id: str,
    channel_id: str,
    message_id: str,
    body_html: str,
    inline_images: list[dict[str, Any]] | None = None,
    connection_id: str | None = None,
) -> Operation:
    """Build a reply_to_channel_message Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = ReplyToChannelMessageArgs(team_id=team_id, channel_id=channel_id, message_id=message_id, body_html=body_html, inline_images=inline_images).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="teams.reply_to_channel_message", args=_args)

def reply_to_channel_message(
    team_id: str,
    channel_id: str,
    message_id: str,
    body_html: str,
    inline_images: list[dict[str, Any]] | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Reply inside an existing channel thread (preserves the thread)

    (WRITE — build it with `reply_to_channel_message.op(...)` and submit
    it with `run_plan([...])`. Calling this directly raises.)

    inline_images: Inline images (image/png, image/jpeg, image/gif, max ~4MB each) embedded as base64. Appended after body_html as <img> tags. Non-image files cannot be sent.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    raise FretikActionError(
        "reply_to_channel_message is a WRITE action and does not execute on its own. "
        "Build it with .op(...) and submit it with run_plan([...]): "
        "run_plan([teams.reply_to_channel_message.op(...)])"
    )

reply_to_channel_message.op = _reply_to_channel_message_op
