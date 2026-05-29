# AUTO-GENERATED from manifest.ts — do not edit by hand. Regenerate: bun run gen:sdk

"""Front provider — 30 actions.

All calls go through fretik-backend, which dispatches them to the
provider (Nango Proxy or a custom handler). Write actions return an
Operation when called as `.op(...)` (use with run_plan(...));
when called directly they are sugar for run_plan([op]).
"""

from typing import Any, Literal, Optional
from pydantic import BaseModel
from ._runtime import FretikActionError, Operation, _call_read, run_plan


# ── Types ─────────────────────────────────────────────────────────

class Inbox(BaseModel):
    id: str
    name: str
    is_private: bool
    type: str | None = None
    send_as: str | None = None


class Teammate(BaseModel):
    id: str
    email: str
    username: str
    is_available: bool
    is_admin: bool
    first_name: str | None = None
    last_name: str | None = None


class Tag(BaseModel):
    id: str
    name: str
    is_private: bool
    is_visible_in_conversation_lists: bool
    highlight: str | None = None
    parent_tag_id: str | None = None


class Handle(BaseModel):
    handle: str
    source: str


class Contact(BaseModel):
    id: str
    handles: list[dict[str, Any]]
    name: str | None = None
    description: str | None = None
    links: list[str] | None = None
    updated_at: str | None = None


class Conversation(BaseModel):
    id: str
    status: str
    tag_ids: list[str]
    inbox_ids: list[str]
    subject: str | None = None
    assignee_id: str | None = None
    recipient_handle: str | None = None
    last_message_preview: str | None = None
    last_message_at: str | None = None
    created_at: str | None = None
    merged_into_conversation_id: str | None = None


class Message(BaseModel):
    id: str
    type: str
    is_inbound: bool
    is_draft: bool
    to: list[str]
    cc: list[str]
    body_html: str
    subject: str | None = None
    from_handle: str | None = None
    text: str | None = None
    created_at: str | None = None


class Comment(BaseModel):
    id: str
    body: str
    author_id: str | None = None
    created_at: str | None = None


class ConversationEvent(BaseModel):
    id: str
    type: str
    emitted_at: str | None = None
    source_id: str | None = None
    target_id: str | None = None


class Rule(BaseModel):
    id: str
    name: str
    is_private: bool
    actions: list[str]


class WriteResult(BaseModel):
    id: str | None = None


class InboxPage(BaseModel):
    items: list[Inbox]
    page_token: Optional[str] = None


class TeammatePage(BaseModel):
    items: list[Teammate]
    page_token: Optional[str] = None


class TagPage(BaseModel):
    items: list[Tag]
    page_token: Optional[str] = None


class ConversationPage(BaseModel):
    items: list[Conversation]
    page_token: Optional[str] = None


class MessagePage(BaseModel):
    items: list[Message]
    page_token: Optional[str] = None


class CommentPage(BaseModel):
    items: list[Comment]
    page_token: Optional[str] = None


class ConversationEventPage(BaseModel):
    items: list[ConversationEvent]
    page_token: Optional[str] = None


class ContactPage(BaseModel):
    items: list[Contact]
    page_token: Optional[str] = None


class RulePage(BaseModel):
    items: list[Rule]
    page_token: Optional[str] = None


# ── Per-action argument models (Pydantic validation in-sandbox) ──

class ListInboxesArgs(BaseModel):
    limit: int | None = 50
    page_token: str | None = None


class ListTeammatesArgs(BaseModel):
    limit: int | None = 50
    page_token: str | None = None


class ListTagsArgs(BaseModel):
    limit: int | None = 50
    page_token: str | None = None


class ListConversationsArgs(BaseModel):
    inbox_id: str | None = None
    status: Literal["open", "archived", "deleted", "spam", "assigned", "unassigned", "all"] | None = None
    limit: int | None = 25
    page_token: str | None = None


class SearchConversationsArgs(BaseModel):
    query: str
    limit: int | None = 25
    page_token: str | None = None


class GetConversationArgs(BaseModel):
    conversation_id: str


class ListConversationMessagesArgs(BaseModel):
    conversation_id: str
    limit: int | None = 20
    page_token: str | None = None


class ListConversationCommentsArgs(BaseModel):
    conversation_id: str
    limit: int | None = 25
    page_token: str | None = None


class ListConversationEventsArgs(BaseModel):
    conversation_id: str
    limit: int | None = 25
    page_token: str | None = None


class ListContactsArgs(BaseModel):
    updated_after: int | None = None
    updated_before: int | None = None
    limit: int | None = 50
    page_token: str | None = None


class GetContactArgs(BaseModel):
    contact_id: str


class FindContactArgs(BaseModel):
    handle: str
    limit: int | None = 25
    page_token: str | None = None


class ListRulesArgs(BaseModel):
    limit: int | None = 50
    page_token: str | None = None


class GetRuleArgs(BaseModel):
    rule_id: str


class ReplyToConversationArgs(BaseModel):
    conversation_id: str
    body_html: str
    text: str | None = None
    channel_id: str | None = None
    to: list[str] | None = None
    cc: list[str] | None = None
    bcc: list[str] | None = None
    archive_after: bool | None = None
    tag_ids_after: list[str] | None = None
    attachments: list[dict[str, Any]] | None = None


class SendNewMessageArgs(BaseModel):
    channel_id: str
    to: list[str]
    body_html: str
    cc: list[str] | None = None
    bcc: list[str] | None = None
    subject: str | None = None
    text: str | None = None
    sender_name: str | None = None
    tag_ids: list[str] | None = None
    attachments: list[dict[str, Any]] | None = None


class UpdateConversationArgs(BaseModel):
    conversation_id: str
    status: Literal["open", "archived", "deleted", "spam"] | None = None
    assignee_id: str | None = None
    inbox_id: str | None = None


class DeleteConversationArgs(BaseModel):
    conversation_id: str


class AddConversationTagsArgs(BaseModel):
    conversation_id: str
    tag_ids: list[str]


class RemoveConversationTagsArgs(BaseModel):
    conversation_id: str
    tag_ids: list[str]


class AddConversationCommentArgs(BaseModel):
    conversation_id: str
    body: str
    attachments: list[dict[str, Any]] | None = None


class SnoozeConversationArgs(BaseModel):
    conversation_id: str
    scheduled_at: int
    teammate_id: str | None = None


class UnsnoozeConversationArgs(BaseModel):
    conversation_id: str
    teammate_id: str | None = None


class AddConversationFollowersArgs(BaseModel):
    conversation_id: str
    teammate_ids: list[str]


class RemoveConversationFollowersArgs(BaseModel):
    conversation_id: str
    teammate_ids: list[str]


class CreateContactArgs(BaseModel):
    handles: list[dict[str, Any]]
    name: str | None = None
    description: str | None = None
    links: list[str] | None = None
    is_spammer: bool | None = None


class UpdateContactArgs(BaseModel):
    contact_id: str
    name: str | None = None
    description: str | None = None
    is_spammer: bool | None = None
    links: list[str] | None = None


class CreateTagArgs(BaseModel):
    name: str
    highlight: Literal["grey", "pink", "red", "orange", "yellow", "green", "light-blue", "blue", "purple"] | None = None
    is_visible_in_conversation_lists: bool | None = True
    parent_tag_id: str | None = None


class UpdateTagArgs(BaseModel):
    tag_id: str
    name: str | None = None
    highlight: Literal["grey", "pink", "red", "orange", "yellow", "green", "light-blue", "blue", "purple"] | None = None
    parent_tag_id: str | None = None


class DeleteTagArgs(BaseModel):
    tag_id: str


# ── Read actions (eager — execute immediately) ─────────

def list_inboxes(
    limit: int | None = 50,
    page_token: str | None = None,
    connection_id: str | None = None,
) -> InboxPage:
    """List the Front inboxes the connection can access

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = ListInboxesArgs(limit=limit, page_token=page_token).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("front.list_inboxes", _args)
    return InboxPage(items=[Inbox(**item) for item in data.get("items", [])], page_token=data.get("page_token"))


def list_teammates(
    limit: int | None = 50,
    page_token: str | None = None,
    connection_id: str | None = None,
) -> TeammatePage:
    """List teammates in the Front company

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = ListTeammatesArgs(limit=limit, page_token=page_token).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("front.list_teammates", _args)
    return TeammatePage(items=[Teammate(**item) for item in data.get("items", [])], page_token=data.get("page_token"))


def list_tags(
    limit: int | None = 50,
    page_token: str | None = None,
    connection_id: str | None = None,
) -> TagPage:
    """List company tags (used to resolve names to tag IDs)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = ListTagsArgs(limit=limit, page_token=page_token).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("front.list_tags", _args)
    return TagPage(items=[Tag(**item) for item in data.get("items", [])], page_token=data.get("page_token"))


def list_conversations(
    inbox_id: str | None = None,
    status: Literal["open", "archived", "deleted", "spam", "assigned", "unassigned", "all"] | None = None,
    limit: int | None = 25,
    page_token: str | None = None,
    connection_id: str | None = None,
) -> ConversationPage:
    """List conversations, optionally scoped to one inbox

    inbox_id: Scope the listing to one inbox

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = ListConversationsArgs(inbox_id=inbox_id, status=status, limit=limit, page_token=page_token).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("front.list_conversations", _args)
    return ConversationPage(items=[Conversation(**item) for item in data.get("items", [])], page_token=data.get("page_token"))


def search_conversations(
    query: str,
    limit: int | None = 25,
    page_token: str | None = None,
    connection_id: str | None = None,
) -> ConversationPage:
    """Full-text search using Front search syntax

    query: Front search expression — supports `is:`, `inbox:`, `tag:`, `assignee:`, `from:`, `to:`, `before:`, `after:`, `during:`, `custom_field:name=value`, and free-text terms

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = SearchConversationsArgs(query=query, limit=limit, page_token=page_token).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("front.search_conversations", _args)
    return ConversationPage(items=[Conversation(**item) for item in data.get("items", [])], page_token=data.get("page_token"))


def get_conversation(
    conversation_id: str,
    connection_id: str | None = None,
) -> Conversation:
    """Fetch conversation metadata (status, assignee, tags, …)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = GetConversationArgs(conversation_id=conversation_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("front.get_conversation", _args)
    return Conversation(**data)


def list_conversation_messages(
    conversation_id: str,
    limit: int | None = 20,
    page_token: str | None = None,
    connection_id: str | None = None,
) -> MessagePage:
    """List messages in a conversation thread (paginated)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = ListConversationMessagesArgs(conversation_id=conversation_id, limit=limit, page_token=page_token).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("front.list_conversation_messages", _args)
    return MessagePage(items=[Message(**item) for item in data.get("items", [])], page_token=data.get("page_token"))


def list_conversation_comments(
    conversation_id: str,
    limit: int | None = 25,
    page_token: str | None = None,
    connection_id: str | None = None,
) -> CommentPage:
    """List internal comments (notes) on a conversation

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = ListConversationCommentsArgs(conversation_id=conversation_id, limit=limit, page_token=page_token).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("front.list_conversation_comments", _args)
    return CommentPage(items=[Comment(**item) for item in data.get("items", [])], page_token=data.get("page_token"))


def list_conversation_events(
    conversation_id: str,
    limit: int | None = 25,
    page_token: str | None = None,
    connection_id: str | None = None,
) -> ConversationEventPage:
    """List the event history of a conversation (audit log)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = ListConversationEventsArgs(conversation_id=conversation_id, limit=limit, page_token=page_token).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("front.list_conversation_events", _args)
    return ConversationEventPage(items=[ConversationEvent(**item) for item in data.get("items", [])], page_token=data.get("page_token"))


def list_contacts(
    updated_after: int | None = None,
    updated_before: int | None = None,
    limit: int | None = 50,
    page_token: str | None = None,
    connection_id: str | None = None,
) -> ContactPage:
    """List contacts in the Front company

    updated_after: Filter contacts updated after this Unix epoch (seconds)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = ListContactsArgs(updated_after=updated_after, updated_before=updated_before, limit=limit, page_token=page_token).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("front.list_contacts", _args)
    return ContactPage(items=[Contact(**item) for item in data.get("items", [])], page_token=data.get("page_token"))


def get_contact(
    contact_id: str,
    connection_id: str | None = None,
) -> Contact:
    """Fetch one contact by ID

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = GetContactArgs(contact_id=contact_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("front.get_contact", _args)
    return Contact(**data)


def find_contact(
    handle: str,
    limit: int | None = 25,
    page_token: str | None = None,
    connection_id: str | None = None,
) -> ContactPage:
    """Find contacts by handle (email / phone) via conversation search

    handle: Email, phone, twitter handle, etc. to search for

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = FindContactArgs(handle=handle, limit=limit, page_token=page_token).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("front.find_contact", _args)
    return ContactPage(items=[Contact(**item) for item in data.get("items", [])], page_token=data.get("page_token"))


def list_rules(
    limit: int | None = 50,
    page_token: str | None = None,
    connection_id: str | None = None,
) -> RulePage:
    """List Front automation rules (read-only)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = ListRulesArgs(limit=limit, page_token=page_token).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("front.list_rules", _args)
    return RulePage(items=[Rule(**item) for item in data.get("items", [])], page_token=data.get("page_token"))


def get_rule(
    rule_id: str,
    connection_id: str | None = None,
) -> Rule:
    """Fetch one automation rule by ID

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = GetRuleArgs(rule_id=rule_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("front.get_rule", _args)
    return Rule(**data)


# ── Write actions (use `.op(...)` inside run_plan([...])) ───

def _reply_to_conversation_op(
    conversation_id: str,
    body_html: str,
    text: str | None = None,
    channel_id: str | None = None,
    to: list[str] | None = None,
    cc: list[str] | None = None,
    bcc: list[str] | None = None,
    archive_after: bool | None = None,
    tag_ids_after: list[str] | None = None,
    attachments: list[dict[str, Any]] | None = None,
    connection_id: str | None = None,
) -> Operation:
    """Build a reply_to_conversation Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = ReplyToConversationArgs(conversation_id=conversation_id, body_html=body_html, text=text, channel_id=channel_id, to=to, cc=cc, bcc=bcc, archive_after=archive_after, tag_ids_after=tag_ids_after, attachments=attachments).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="front.reply_to_conversation", args=_args)

def reply_to_conversation(
    conversation_id: str,
    body_html: str,
    text: str | None = None,
    channel_id: str | None = None,
    to: list[str] | None = None,
    cc: list[str] | None = None,
    bcc: list[str] | None = None,
    archive_after: bool | None = None,
    tag_ids_after: list[str] | None = None,
    attachments: list[dict[str, Any]] | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Reply to a conversation thread

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    text: Plain-text alternative (Front falls back to a stripped body when omitted)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _reply_to_conversation_op(
        conversation_id=conversation_id,
        body_html=body_html,
        text=text,
        channel_id=channel_id,
        to=to,
        cc=cc,
        bcc=bcc,
        archive_after=archive_after,
        tag_ids_after=tag_ids_after,
        attachments=attachments,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "reply_to_conversation failed"))
    return result[0].get("data", {})

reply_to_conversation.op = _reply_to_conversation_op


def _send_new_message_op(
    channel_id: str,
    to: list[str],
    body_html: str,
    cc: list[str] | None = None,
    bcc: list[str] | None = None,
    subject: str | None = None,
    text: str | None = None,
    sender_name: str | None = None,
    tag_ids: list[str] | None = None,
    attachments: list[dict[str, Any]] | None = None,
    connection_id: str | None = None,
) -> Operation:
    """Build a send_new_message Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = SendNewMessageArgs(channel_id=channel_id, to=to, body_html=body_html, cc=cc, bcc=bcc, subject=subject, text=text, sender_name=sender_name, tag_ids=tag_ids, attachments=attachments).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="front.send_new_message", args=_args)

def send_new_message(
    channel_id: str,
    to: list[str],
    body_html: str,
    cc: list[str] | None = None,
    bcc: list[str] | None = None,
    subject: str | None = None,
    text: str | None = None,
    sender_name: str | None = None,
    tag_ids: list[str] | None = None,
    attachments: list[dict[str, Any]] | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Send a new outbound message (starts a new conversation)

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    channel_id: ID of the channel to send from

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _send_new_message_op(
        channel_id=channel_id,
        to=to,
        body_html=body_html,
        cc=cc,
        bcc=bcc,
        subject=subject,
        text=text,
        sender_name=sender_name,
        tag_ids=tag_ids,
        attachments=attachments,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "send_new_message failed"))
    return result[0].get("data", {})

send_new_message.op = _send_new_message_op


def _update_conversation_op(
    conversation_id: str,
    status: Literal["open", "archived", "deleted", "spam"] | None = None,
    assignee_id: str | None = None,
    inbox_id: str | None = None,
    connection_id: str | None = None,
) -> Operation:
    """Build a update_conversation Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = UpdateConversationArgs(conversation_id=conversation_id, status=status, assignee_id=assignee_id, inbox_id=inbox_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="front.update_conversation", args=_args)

def update_conversation(
    conversation_id: str,
    status: Literal["open", "archived", "deleted", "spam"] | None = None,
    assignee_id: str | None = None,
    inbox_id: str | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Update conversation status, assignee, or inbox (archive / reopen / move / assign)

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    assignee_id: Teammate ID to assign. Pass an empty string to unassign

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _update_conversation_op(
        conversation_id=conversation_id,
        status=status,
        assignee_id=assignee_id,
        inbox_id=inbox_id,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "update_conversation failed"))
    return result[0].get("data", {})

update_conversation.op = _update_conversation_op


def _delete_conversation_op(
    conversation_id: str,
    connection_id: str | None = None,
) -> Operation:
    """Build a delete_conversation Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = DeleteConversationArgs(conversation_id=conversation_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="front.delete_conversation", args=_args)

def delete_conversation(
    conversation_id: str,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Permanently delete a conversation

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _delete_conversation_op(
        conversation_id=conversation_id,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "delete_conversation failed"))
    return result[0].get("data", {})

delete_conversation.op = _delete_conversation_op


def _add_conversation_tags_op(
    conversation_id: str,
    tag_ids: list[str],
    connection_id: str | None = None,
) -> Operation:
    """Build a add_conversation_tags Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = AddConversationTagsArgs(conversation_id=conversation_id, tag_ids=tag_ids).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="front.add_conversation_tags", args=_args)

def add_conversation_tags(
    conversation_id: str,
    tag_ids: list[str],
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Add tags to a conversation (additive)

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _add_conversation_tags_op(
        conversation_id=conversation_id,
        tag_ids=tag_ids,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "add_conversation_tags failed"))
    return result[0].get("data", {})

add_conversation_tags.op = _add_conversation_tags_op


def _remove_conversation_tags_op(
    conversation_id: str,
    tag_ids: list[str],
    connection_id: str | None = None,
) -> Operation:
    """Build a remove_conversation_tags Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = RemoveConversationTagsArgs(conversation_id=conversation_id, tag_ids=tag_ids).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="front.remove_conversation_tags", args=_args)

def remove_conversation_tags(
    conversation_id: str,
    tag_ids: list[str],
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Remove tags from a conversation

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _remove_conversation_tags_op(
        conversation_id=conversation_id,
        tag_ids=tag_ids,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "remove_conversation_tags failed"))
    return result[0].get("data", {})

remove_conversation_tags.op = _remove_conversation_tags_op


def _add_conversation_comment_op(
    conversation_id: str,
    body: str,
    attachments: list[dict[str, Any]] | None = None,
    connection_id: str | None = None,
) -> Operation:
    """Build a add_conversation_comment Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = AddConversationCommentArgs(conversation_id=conversation_id, body=body, attachments=attachments).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="front.add_conversation_comment", args=_args)

def add_conversation_comment(
    conversation_id: str,
    body: str,
    attachments: list[dict[str, Any]] | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Add an internal comment (note) to a conversation

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    body: Comment body — markdown, supports `@username` mentions resolved by Front

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _add_conversation_comment_op(
        conversation_id=conversation_id,
        body=body,
        attachments=attachments,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "add_conversation_comment failed"))
    return result[0].get("data", {})

add_conversation_comment.op = _add_conversation_comment_op


def _snooze_conversation_op(
    conversation_id: str,
    scheduled_at: int,
    teammate_id: str | None = None,
    connection_id: str | None = None,
) -> Operation:
    """Build a snooze_conversation Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = SnoozeConversationArgs(conversation_id=conversation_id, scheduled_at=scheduled_at, teammate_id=teammate_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="front.snooze_conversation", args=_args)

def snooze_conversation(
    conversation_id: str,
    scheduled_at: int,
    teammate_id: str | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Snooze a conversation until a future timestamp

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    scheduled_at: Unix epoch (seconds) when the snooze should end

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _snooze_conversation_op(
        conversation_id=conversation_id,
        scheduled_at=scheduled_at,
        teammate_id=teammate_id,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "snooze_conversation failed"))
    return result[0].get("data", {})

snooze_conversation.op = _snooze_conversation_op


def _unsnooze_conversation_op(
    conversation_id: str,
    teammate_id: str | None = None,
    connection_id: str | None = None,
) -> Operation:
    """Build a unsnooze_conversation Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = UnsnoozeConversationArgs(conversation_id=conversation_id, teammate_id=teammate_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="front.unsnooze_conversation", args=_args)

def unsnooze_conversation(
    conversation_id: str,
    teammate_id: str | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Cancel an active snooze on a conversation

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    teammate_id: Teammate whose snooze should be cleared (defaults to the bot teammate)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _unsnooze_conversation_op(
        conversation_id=conversation_id,
        teammate_id=teammate_id,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "unsnooze_conversation failed"))
    return result[0].get("data", {})

unsnooze_conversation.op = _unsnooze_conversation_op


def _add_conversation_followers_op(
    conversation_id: str,
    teammate_ids: list[str],
    connection_id: str | None = None,
) -> Operation:
    """Build a add_conversation_followers Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = AddConversationFollowersArgs(conversation_id=conversation_id, teammate_ids=teammate_ids).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="front.add_conversation_followers", args=_args)

def add_conversation_followers(
    conversation_id: str,
    teammate_ids: list[str],
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Add teammates as followers of a conversation

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _add_conversation_followers_op(
        conversation_id=conversation_id,
        teammate_ids=teammate_ids,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "add_conversation_followers failed"))
    return result[0].get("data", {})

add_conversation_followers.op = _add_conversation_followers_op


def _remove_conversation_followers_op(
    conversation_id: str,
    teammate_ids: list[str],
    connection_id: str | None = None,
) -> Operation:
    """Build a remove_conversation_followers Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = RemoveConversationFollowersArgs(conversation_id=conversation_id, teammate_ids=teammate_ids).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="front.remove_conversation_followers", args=_args)

def remove_conversation_followers(
    conversation_id: str,
    teammate_ids: list[str],
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Remove teammates from the followers of a conversation

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _remove_conversation_followers_op(
        conversation_id=conversation_id,
        teammate_ids=teammate_ids,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "remove_conversation_followers failed"))
    return result[0].get("data", {})

remove_conversation_followers.op = _remove_conversation_followers_op


def _create_contact_op(
    handles: list[dict[str, Any]],
    name: str | None = None,
    description: str | None = None,
    links: list[str] | None = None,
    is_spammer: bool | None = None,
    connection_id: str | None = None,
) -> Operation:
    """Build a create_contact Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = CreateContactArgs(handles=handles, name=name, description=description, links=links, is_spammer=is_spammer).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="front.create_contact", args=_args)

def create_contact(
    handles: list[dict[str, Any]],
    name: str | None = None,
    description: str | None = None,
    links: list[str] | None = None,
    is_spammer: bool | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Create a new contact

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    handles: At least one handle is required

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _create_contact_op(
        handles=handles,
        name=name,
        description=description,
        links=links,
        is_spammer=is_spammer,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "create_contact failed"))
    return result[0].get("data", {})

create_contact.op = _create_contact_op


def _update_contact_op(
    contact_id: str,
    name: str | None = None,
    description: str | None = None,
    is_spammer: bool | None = None,
    links: list[str] | None = None,
    connection_id: str | None = None,
) -> Operation:
    """Build a update_contact Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = UpdateContactArgs(contact_id=contact_id, name=name, description=description, is_spammer=is_spammer, links=links).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="front.update_contact", args=_args)

def update_contact(
    contact_id: str,
    name: str | None = None,
    description: str | None = None,
    is_spammer: bool | None = None,
    links: list[str] | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Update an existing contact (PATCH semantics)

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _update_contact_op(
        contact_id=contact_id,
        name=name,
        description=description,
        is_spammer=is_spammer,
        links=links,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "update_contact failed"))
    return result[0].get("data", {})

update_contact.op = _update_contact_op


def _create_tag_op(
    name: str,
    highlight: Literal["grey", "pink", "red", "orange", "yellow", "green", "light-blue", "blue", "purple"] | None = None,
    is_visible_in_conversation_lists: bool | None = True,
    parent_tag_id: str | None = None,
    connection_id: str | None = None,
) -> Operation:
    """Build a create_tag Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = CreateTagArgs(name=name, highlight=highlight, is_visible_in_conversation_lists=is_visible_in_conversation_lists, parent_tag_id=parent_tag_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="front.create_tag", args=_args)

def create_tag(
    name: str,
    highlight: Literal["grey", "pink", "red", "orange", "yellow", "green", "light-blue", "blue", "purple"] | None = None,
    is_visible_in_conversation_lists: bool | None = True,
    parent_tag_id: str | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Create a new company tag

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _create_tag_op(
        name=name,
        highlight=highlight,
        is_visible_in_conversation_lists=is_visible_in_conversation_lists,
        parent_tag_id=parent_tag_id,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "create_tag failed"))
    return result[0].get("data", {})

create_tag.op = _create_tag_op


def _update_tag_op(
    tag_id: str,
    name: str | None = None,
    highlight: Literal["grey", "pink", "red", "orange", "yellow", "green", "light-blue", "blue", "purple"] | None = None,
    parent_tag_id: str | None = None,
    connection_id: str | None = None,
) -> Operation:
    """Build a update_tag Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = UpdateTagArgs(tag_id=tag_id, name=name, highlight=highlight, parent_tag_id=parent_tag_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="front.update_tag", args=_args)

def update_tag(
    tag_id: str,
    name: str | None = None,
    highlight: Literal["grey", "pink", "red", "orange", "yellow", "green", "light-blue", "blue", "purple"] | None = None,
    parent_tag_id: str | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Update a tag (rename / recolor / re-parent)

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _update_tag_op(
        tag_id=tag_id,
        name=name,
        highlight=highlight,
        parent_tag_id=parent_tag_id,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "update_tag failed"))
    return result[0].get("data", {})

update_tag.op = _update_tag_op


def _delete_tag_op(
    tag_id: str,
    connection_id: str | None = None,
) -> Operation:
    """Build a delete_tag Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = DeleteTagArgs(tag_id=tag_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="front.delete_tag", args=_args)

def delete_tag(
    tag_id: str,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Delete a tag (removes it from every conversation it was on)

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _delete_tag_op(
        tag_id=tag_id,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "delete_tag failed"))
    return result[0].get("data", {})

delete_tag.op = _delete_tag_op
