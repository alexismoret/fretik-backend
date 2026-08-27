# AUTO-GENERATED from manifest.ts — do not edit by hand. Regenerate: bun run gen:sdk

"""Microsoft Exchange provider — 33 actions.

All calls go through fretik-backend, which dispatches them to the
provider (Nango Proxy or a custom handler). Write actions return an
Operation via `.op(...)`; submit them with run_plan([...]).
Calling a write action directly raises — it never executes.
"""

from typing import Any, Literal, Optional
from pydantic import BaseModel
from ._runtime import FretikActionError, Operation, _call_read


# ── Types ─────────────────────────────────────────────────────────

class Message(BaseModel):
    id: str
    subject: str
    from_address: str
    to: list[str]
    received_at: str
    is_read: bool
    has_attachments: bool
    body_preview: str


class MessageFull(BaseModel):
    id: str
    subject: str
    from_address: str
    to: list[str]
    cc: list[str]
    received_at: str
    is_read: bool
    has_attachments: bool
    body_html: str


class MailFolder(BaseModel):
    id: str
    display_name: str
    total_item_count: int
    unread_item_count: int
    parent_folder_id: str | None = None


class CalendarEvent(BaseModel):
    id: str
    subject: str
    start: str
    end: str
    attendees: list[str]
    is_online_meeting: bool
    location: str | None = None
    organizer: str | None = None
    body_preview: str | None = None


class Contact(BaseModel):
    id: str
    display_name: str
    email_addresses: list[str]
    company_name: str | None = None
    job_title: str | None = None
    mobile_phone: str | None = None


class InboxRule(BaseModel):
    id: str
    display_name: str
    sequence: int
    is_enabled: bool
    has_error: bool | None = None


class WriteResult(BaseModel):
    id: str | None = None


class Attachment(BaseModel):
    id: str
    name: str
    content_type: str
    size_bytes: int
    sandbox_path: str | None = None
    content_base64: str | None = None


# ── Per-action argument models (Pydantic validation in-sandbox) ──

class ListMessagesArgs(BaseModel):
    folder: Literal["inbox", "sentitems", "drafts", "deleteditems", "archive", "junkemail"] | None = "inbox"
    unread_only: bool | None = None
    limit: int | None = 25
    offset: int | None = 0


class GetMessageArgs(BaseModel):
    message_id: str


class SearchMessagesArgs(BaseModel):
    query: str
    limit: int | None = 25
    offset: int | None = 0


class ListMessagesInFolderArgs(BaseModel):
    folder_id: str
    unread_only: bool | None = None
    limit: int | None = 25
    offset: int | None = 0


class ListFoldersArgs(BaseModel):
    pass


class ListMessageAttachmentsArgs(BaseModel):
    message_id: str


class DownloadMessageAttachmentArgs(BaseModel):
    message_id: str
    attachment_id: str


class ListCalendarEventsArgs(BaseModel):
    start: str
    end: str
    limit: int | None = 50
    offset: int | None = 0


class GetCalendarEventArgs(BaseModel):
    event_id: str


class ListContactsArgs(BaseModel):
    limit: int | None = 50
    offset: int | None = 0


class ListInboxRulesArgs(BaseModel):
    pass


class SendEmailArgs(BaseModel):
    to: list[str]
    subject: str
    body_html: str
    cc: list[str] | None = None
    bcc: list[str] | None = None
    attachments: list[dict[str, Any]] | None = None


class ReplyEmailArgs(BaseModel):
    message_id: str
    body_html: str


class ReplyAllEmailArgs(BaseModel):
    message_id: str
    body_html: str


class ForwardEmailArgs(BaseModel):
    message_id: str
    to: list[str]
    comment: str | None = None


class CreateDraftArgs(BaseModel):
    to: list[str]
    subject: str
    body_html: str
    cc: list[str] | None = None
    attachments: list[dict[str, Any]] | None = None


class UpdateDraftArgs(BaseModel):
    message_id: str
    subject: str | None = None
    body_html: str | None = None


class DeleteMessageArgs(BaseModel):
    message_id: str


class MoveMessageArgs(BaseModel):
    message_id: str
    destination_folder_id: str


class CopyMessageArgs(BaseModel):
    message_id: str
    destination_folder_id: str


class DeleteMessagesArgs(BaseModel):
    message_ids: list[str]


class MoveMessagesArgs(BaseModel):
    message_ids: list[str]
    destination_folder_id: str


class MarkMessagesReadArgs(BaseModel):
    message_ids: list[str]


class MarkMessagesUnreadArgs(BaseModel):
    message_ids: list[str]


class MarkReadArgs(BaseModel):
    message_id: str


class MarkUnreadArgs(BaseModel):
    message_id: str


class FlagMessageArgs(BaseModel):
    message_id: str
    status: Literal["flagged", "complete", "notFlagged"] | None = "flagged"
    due_date: str | None = None


class CreateFolderArgs(BaseModel):
    display_name: str
    parent_folder_id: str | None = None


class CreateCalendarEventArgs(BaseModel):
    subject: str
    start: str
    end: str
    location: str | None = None
    attendees: list[str] | None = None
    body_html: str | None = None
    is_online_meeting: bool | None = None


class UpdateCalendarEventArgs(BaseModel):
    event_id: str
    subject: str | None = None
    start: str | None = None
    end: str | None = None
    location: str | None = None
    body_html: str | None = None


class DeleteCalendarEventArgs(BaseModel):
    event_id: str


class RespondToEventArgs(BaseModel):
    event_id: str
    response: Literal["accept", "decline", "tentativelyAccept"]
    comment: str | None = None


class CreateContactArgs(BaseModel):
    given_name: str
    surname: str | None = None
    email: str | None = None
    company_name: str | None = None
    job_title: str | None = None
    mobile_phone: str | None = None


# ── Read actions (eager — execute immediately) ─────────

def list_messages(
    folder: Literal["inbox", "sentitems", "drafts", "deleteditems", "archive", "junkemail"] | None = "inbox",
    unread_only: bool | None = None,
    limit: int | None = 25,
    offset: int | None = 0,
    connection_id: str | None = None,
) -> list[Message]:
    """List emails from a well-known mail folder

    folder: Well-known folder name

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = ListMessagesArgs(folder=folder, unread_only=unread_only, limit=limit, offset=offset).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("exchange.list_messages", _args)
    return [Message(**item) for item in data]


def get_message(
    message_id: str,
    connection_id: str | None = None,
) -> MessageFull:
    """Fetch one email by ID, with its full HTML body

    message_id: Message ID from list_messages / search_messages

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = GetMessageArgs(message_id=message_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("exchange.get_message", _args)
    return MessageFull(**data)


def search_messages(
    query: str,
    limit: int | None = 25,
    offset: int | None = 0,
    connection_id: str | None = None,
) -> list[Message]:
    """Search the Inbox with an Exchange AQS query

    query: AQS query, e.g. `from:alice@example.com` (see guidance)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = SearchMessagesArgs(query=query, limit=limit, offset=offset).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("exchange.search_messages", _args)
    return [Message(**item) for item in data]


def list_messages_in_folder(
    folder_id: str,
    unread_only: bool | None = None,
    limit: int | None = 25,
    offset: int | None = 0,
    connection_id: str | None = None,
) -> list[Message]:
    """List emails from a custom folder by its folder ID

    folder_id: Folder ID returned by list_folders

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = ListMessagesInFolderArgs(folder_id=folder_id, unread_only=unread_only, limit=limit, offset=offset).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("exchange.list_messages_in_folder", _args)
    return [Message(**item) for item in data]


def list_folders(
    connection_id: str | None = None,
) -> list[MailFolder]:
    """List every mail folder of the mailbox

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = ListFoldersArgs().model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("exchange.list_folders", _args)
    return [MailFolder(**item) for item in data]


def list_message_attachments(
    message_id: str,
    connection_id: str | None = None,
) -> list[Attachment]:
    """List attachments on a message (metadata only — no content)

    message_id: Message ID from list_messages / search_messages

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = ListMessageAttachmentsArgs(message_id=message_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("exchange.list_message_attachments", _args)
    return [Attachment(**item) for item in data]


def download_message_attachment(
    message_id: str,
    attachment_id: str,
    connection_id: str | None = None,
) -> Attachment:
    """Download one attachment — binary is spilled to `sandbox_path`

    attachment_id: Attachment ID from list_message_attachments

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = DownloadMessageAttachmentArgs(message_id=message_id, attachment_id=attachment_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("exchange.download_message_attachment", _args)
    return Attachment(**data)


def list_calendar_events(
    start: str,
    end: str,
    limit: int | None = 50,
    offset: int | None = 0,
    connection_id: str | None = None,
) -> list[CalendarEvent]:
    """List calendar events in a date window (recurring series expanded)

    start: Window start (ISO 8601)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = ListCalendarEventsArgs(start=start, end=end, limit=limit, offset=offset).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("exchange.list_calendar_events", _args)
    return [CalendarEvent(**item) for item in data]


def get_calendar_event(
    event_id: str,
    connection_id: str | None = None,
) -> CalendarEvent:
    """Fetch one calendar event by ID

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = GetCalendarEventArgs(event_id=event_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("exchange.get_calendar_event", _args)
    return CalendarEvent(**data)


def list_contacts(
    limit: int | None = 50,
    offset: int | None = 0,
    connection_id: str | None = None,
) -> list[Contact]:
    """List contacts from the mailbox

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = ListContactsArgs(limit=limit, offset=offset).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("exchange.list_contacts", _args)
    return [Contact(**item) for item in data]


def list_inbox_rules(
    connection_id: str | None = None,
) -> list[InboxRule]:
    """List the inbox rules configured on the mailbox (read-only)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = ListInboxRulesArgs().model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("exchange.list_inbox_rules", _args)
    return [InboxRule(**item) for item in data]


# ── Write actions (use `.op(...)` inside run_plan([...])) ───

def _send_email_op(
    to: list[str],
    subject: str,
    body_html: str,
    cc: list[str] | None = None,
    bcc: list[str] | None = None,
    attachments: list[dict[str, Any]] | None = None,
    connection_id: str | None = None,
) -> Operation:
    """Build a send_email Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = SendEmailArgs(to=to, subject=subject, body_html=body_html, cc=cc, bcc=bcc, attachments=attachments).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="exchange.send_email", args=_args)

def send_email(
    to: list[str],
    subject: str,
    body_html: str,
    cc: list[str] | None = None,
    bcc: list[str] | None = None,
    attachments: list[dict[str, Any]] | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Send a new email immediately (with optional attachments)

    (WRITE — build it with `send_email.op(...)` and submit
    it with `run_plan([...])`. Calling this directly raises.)

    body_html: HTML body

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    raise FretikActionError(
        "send_email is a WRITE action and does not execute on its own. "
        "Build it with .op(...) and submit it with run_plan([...]): "
        "run_plan([exchange.send_email.op(...)])"
    )

send_email.op = _send_email_op


def _reply_email_op(
    message_id: str,
    body_html: str,
    connection_id: str | None = None,
) -> Operation:
    """Build a reply_email Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = ReplyEmailArgs(message_id=message_id, body_html=body_html).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="exchange.reply_email", args=_args)

def reply_email(
    message_id: str,
    body_html: str,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Reply to the sender of a message

    (WRITE — build it with `reply_email.op(...)` and submit
    it with `run_plan([...])`. Calling this directly raises.)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    raise FretikActionError(
        "reply_email is a WRITE action and does not execute on its own. "
        "Build it with .op(...) and submit it with run_plan([...]): "
        "run_plan([exchange.reply_email.op(...)])"
    )

reply_email.op = _reply_email_op


def _reply_all_email_op(
    message_id: str,
    body_html: str,
    connection_id: str | None = None,
) -> Operation:
    """Build a reply_all_email Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = ReplyAllEmailArgs(message_id=message_id, body_html=body_html).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="exchange.reply_all_email", args=_args)

def reply_all_email(
    message_id: str,
    body_html: str,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Reply to all recipients of a message

    (WRITE — build it with `reply_all_email.op(...)` and submit
    it with `run_plan([...])`. Calling this directly raises.)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    raise FretikActionError(
        "reply_all_email is a WRITE action and does not execute on its own. "
        "Build it with .op(...) and submit it with run_plan([...]): "
        "run_plan([exchange.reply_all_email.op(...)])"
    )

reply_all_email.op = _reply_all_email_op


def _forward_email_op(
    message_id: str,
    to: list[str],
    comment: str | None = None,
    connection_id: str | None = None,
) -> Operation:
    """Build a forward_email Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = ForwardEmailArgs(message_id=message_id, to=to, comment=comment).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="exchange.forward_email", args=_args)

def forward_email(
    message_id: str,
    to: list[str],
    comment: str | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Forward a message to new recipients (with optional comment)

    (WRITE — build it with `forward_email.op(...)` and submit
    it with `run_plan([...])`. Calling this directly raises.)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    raise FretikActionError(
        "forward_email is a WRITE action and does not execute on its own. "
        "Build it with .op(...) and submit it with run_plan([...]): "
        "run_plan([exchange.forward_email.op(...)])"
    )

forward_email.op = _forward_email_op


def _create_draft_op(
    to: list[str],
    subject: str,
    body_html: str,
    cc: list[str] | None = None,
    attachments: list[dict[str, Any]] | None = None,
    connection_id: str | None = None,
) -> Operation:
    """Build a create_draft Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = CreateDraftArgs(to=to, subject=subject, body_html=body_html, cc=cc, attachments=attachments).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="exchange.create_draft", args=_args)

def create_draft(
    to: list[str],
    subject: str,
    body_html: str,
    cc: list[str] | None = None,
    attachments: list[dict[str, Any]] | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Create a draft email (not sent)

    (WRITE — build it with `create_draft.op(...)` and submit
    it with `run_plan([...])`. Calling this directly raises.)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    raise FretikActionError(
        "create_draft is a WRITE action and does not execute on its own. "
        "Build it with .op(...) and submit it with run_plan([...]): "
        "run_plan([exchange.create_draft.op(...)])"
    )

create_draft.op = _create_draft_op


def _update_draft_op(
    message_id: str,
    subject: str | None = None,
    body_html: str | None = None,
    connection_id: str | None = None,
) -> Operation:
    """Build a update_draft Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = UpdateDraftArgs(message_id=message_id, subject=subject, body_html=body_html).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="exchange.update_draft", args=_args)

def update_draft(
    message_id: str,
    subject: str | None = None,
    body_html: str | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Update the subject or body of an existing draft

    (WRITE — build it with `update_draft.op(...)` and submit
    it with `run_plan([...])`. Calling this directly raises.)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    raise FretikActionError(
        "update_draft is a WRITE action and does not execute on its own. "
        "Build it with .op(...) and submit it with run_plan([...]): "
        "run_plan([exchange.update_draft.op(...)])"
    )

update_draft.op = _update_draft_op


def _delete_message_op(
    message_id: str,
    connection_id: str | None = None,
) -> Operation:
    """Build a delete_message Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = DeleteMessageArgs(message_id=message_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="exchange.delete_message", args=_args)

def delete_message(
    message_id: str,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Delete a message (moves it to Deleted Items)

    (WRITE — build it with `delete_message.op(...)` and submit
    it with `run_plan([...])`. Calling this directly raises.)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    raise FretikActionError(
        "delete_message is a WRITE action and does not execute on its own. "
        "Build it with .op(...) and submit it with run_plan([...]): "
        "run_plan([exchange.delete_message.op(...)])"
    )

delete_message.op = _delete_message_op


def _move_message_op(
    message_id: str,
    destination_folder_id: str,
    connection_id: str | None = None,
) -> Operation:
    """Build a move_message Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = MoveMessageArgs(message_id=message_id, destination_folder_id=destination_folder_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="exchange.move_message", args=_args)

def move_message(
    message_id: str,
    destination_folder_id: str,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Move a message to another folder

    (WRITE — build it with `move_message.op(...)` and submit
    it with `run_plan([...])`. Calling this directly raises.)

    destination_folder_id: Destination folder ID from list_folders

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    raise FretikActionError(
        "move_message is a WRITE action and does not execute on its own. "
        "Build it with .op(...) and submit it with run_plan([...]): "
        "run_plan([exchange.move_message.op(...)])"
    )

move_message.op = _move_message_op


def _copy_message_op(
    message_id: str,
    destination_folder_id: str,
    connection_id: str | None = None,
) -> Operation:
    """Build a copy_message Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = CopyMessageArgs(message_id=message_id, destination_folder_id=destination_folder_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="exchange.copy_message", args=_args)

def copy_message(
    message_id: str,
    destination_folder_id: str,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Copy a message into another folder

    (WRITE — build it with `copy_message.op(...)` and submit
    it with `run_plan([...])`. Calling this directly raises.)

    destination_folder_id: Destination folder ID from list_folders

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    raise FretikActionError(
        "copy_message is a WRITE action and does not execute on its own. "
        "Build it with .op(...) and submit it with run_plan([...]): "
        "run_plan([exchange.copy_message.op(...)])"
    )

copy_message.op = _copy_message_op


def _delete_messages_op(
    message_ids: list[str],
    connection_id: str | None = None,
) -> Operation:
    """Build a delete_messages Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = DeleteMessagesArgs(message_ids=message_ids).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="exchange.delete_messages", args=_args)

def delete_messages(
    message_ids: list[str],
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Delete multiple messages in one batch (move to Deleted Items)

    (WRITE — build it with `delete_messages.op(...)` and submit
    it with `run_plan([...])`. Calling this directly raises.)

    message_ids: Message IDs from list_messages / search_messages

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    raise FretikActionError(
        "delete_messages is a WRITE action and does not execute on its own. "
        "Build it with .op(...) and submit it with run_plan([...]): "
        "run_plan([exchange.delete_messages.op(...)])"
    )

delete_messages.op = _delete_messages_op


def _move_messages_op(
    message_ids: list[str],
    destination_folder_id: str,
    connection_id: str | None = None,
) -> Operation:
    """Build a move_messages Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = MoveMessagesArgs(message_ids=message_ids, destination_folder_id=destination_folder_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="exchange.move_messages", args=_args)

def move_messages(
    message_ids: list[str],
    destination_folder_id: str,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Move multiple messages to another folder in one batch

    (WRITE — build it with `move_messages.op(...)` and submit
    it with `run_plan([...])`. Calling this directly raises.)

    destination_folder_id: Destination folder ID from list_folders

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    raise FretikActionError(
        "move_messages is a WRITE action and does not execute on its own. "
        "Build it with .op(...) and submit it with run_plan([...]): "
        "run_plan([exchange.move_messages.op(...)])"
    )

move_messages.op = _move_messages_op


def _mark_messages_read_op(
    message_ids: list[str],
    connection_id: str | None = None,
) -> Operation:
    """Build a mark_messages_read Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = MarkMessagesReadArgs(message_ids=message_ids).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="exchange.mark_messages_read", args=_args)

def mark_messages_read(
    message_ids: list[str],
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Mark multiple messages as read

    (WRITE — build it with `mark_messages_read.op(...)` and submit
    it with `run_plan([...])`. Calling this directly raises.)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    raise FretikActionError(
        "mark_messages_read is a WRITE action and does not execute on its own. "
        "Build it with .op(...) and submit it with run_plan([...]): "
        "run_plan([exchange.mark_messages_read.op(...)])"
    )

mark_messages_read.op = _mark_messages_read_op


def _mark_messages_unread_op(
    message_ids: list[str],
    connection_id: str | None = None,
) -> Operation:
    """Build a mark_messages_unread Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = MarkMessagesUnreadArgs(message_ids=message_ids).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="exchange.mark_messages_unread", args=_args)

def mark_messages_unread(
    message_ids: list[str],
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Mark multiple messages as unread

    (WRITE — build it with `mark_messages_unread.op(...)` and submit
    it with `run_plan([...])`. Calling this directly raises.)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    raise FretikActionError(
        "mark_messages_unread is a WRITE action and does not execute on its own. "
        "Build it with .op(...) and submit it with run_plan([...]): "
        "run_plan([exchange.mark_messages_unread.op(...)])"
    )

mark_messages_unread.op = _mark_messages_unread_op


def _mark_read_op(
    message_id: str,
    connection_id: str | None = None,
) -> Operation:
    """Build a mark_read Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = MarkReadArgs(message_id=message_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="exchange.mark_read", args=_args)

def mark_read(
    message_id: str,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Mark a message as read

    (WRITE — build it with `mark_read.op(...)` and submit
    it with `run_plan([...])`. Calling this directly raises.)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    raise FretikActionError(
        "mark_read is a WRITE action and does not execute on its own. "
        "Build it with .op(...) and submit it with run_plan([...]): "
        "run_plan([exchange.mark_read.op(...)])"
    )

mark_read.op = _mark_read_op


def _mark_unread_op(
    message_id: str,
    connection_id: str | None = None,
) -> Operation:
    """Build a mark_unread Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = MarkUnreadArgs(message_id=message_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="exchange.mark_unread", args=_args)

def mark_unread(
    message_id: str,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Mark a message as unread

    (WRITE — build it with `mark_unread.op(...)` and submit
    it with `run_plan([...])`. Calling this directly raises.)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    raise FretikActionError(
        "mark_unread is a WRITE action and does not execute on its own. "
        "Build it with .op(...) and submit it with run_plan([...]): "
        "run_plan([exchange.mark_unread.op(...)])"
    )

mark_unread.op = _mark_unread_op


def _flag_message_op(
    message_id: str,
    status: Literal["flagged", "complete", "notFlagged"] | None = "flagged",
    due_date: str | None = None,
    connection_id: str | None = None,
) -> Operation:
    """Build a flag_message Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = FlagMessageArgs(message_id=message_id, status=status, due_date=due_date).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="exchange.flag_message", args=_args)

def flag_message(
    message_id: str,
    status: Literal["flagged", "complete", "notFlagged"] | None = "flagged",
    due_date: str | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Set the follow-up flag on a message (flag / mark complete / clear)

    (WRITE — build it with `flag_message.op(...)` and submit
    it with `run_plan([...])`. Calling this directly raises.)

    status: Flag state: `flagged`=mark for follow-up, `complete`=mark done, `notFlagged`=clear. Requires Exchange 2013+.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    raise FretikActionError(
        "flag_message is a WRITE action and does not execute on its own. "
        "Build it with .op(...) and submit it with run_plan([...]): "
        "run_plan([exchange.flag_message.op(...)])"
    )

flag_message.op = _flag_message_op


def _create_folder_op(
    display_name: str,
    parent_folder_id: str | None = None,
    connection_id: str | None = None,
) -> Operation:
    """Build a create_folder Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = CreateFolderArgs(display_name=display_name, parent_folder_id=parent_folder_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="exchange.create_folder", args=_args)

def create_folder(
    display_name: str,
    parent_folder_id: str | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Create a new mail folder

    (WRITE — build it with `create_folder.op(...)` and submit
    it with `run_plan([...])`. Calling this directly raises.)

    display_name: Folder name to create

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    raise FretikActionError(
        "create_folder is a WRITE action and does not execute on its own. "
        "Build it with .op(...) and submit it with run_plan([...]): "
        "run_plan([exchange.create_folder.op(...)])"
    )

create_folder.op = _create_folder_op


def _create_calendar_event_op(
    subject: str,
    start: str,
    end: str,
    location: str | None = None,
    attendees: list[str] | None = None,
    body_html: str | None = None,
    is_online_meeting: bool | None = None,
    connection_id: str | None = None,
) -> Operation:
    """Build a create_calendar_event Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = CreateCalendarEventArgs(subject=subject, start=start, end=end, location=location, attendees=attendees, body_html=body_html, is_online_meeting=is_online_meeting).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="exchange.create_calendar_event", args=_args)

def create_calendar_event(
    subject: str,
    start: str,
    end: str,
    location: str | None = None,
    attendees: list[str] | None = None,
    body_html: str | None = None,
    is_online_meeting: bool | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Create a calendar event

    (WRITE — build it with `create_calendar_event.op(...)` and submit
    it with `run_plan([...])`. Calling this directly raises.)

    start: Start (ISO 8601, include a timezone offset e.g. Z)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    raise FretikActionError(
        "create_calendar_event is a WRITE action and does not execute on its own. "
        "Build it with .op(...) and submit it with run_plan([...]): "
        "run_plan([exchange.create_calendar_event.op(...)])"
    )

create_calendar_event.op = _create_calendar_event_op


def _update_calendar_event_op(
    event_id: str,
    subject: str | None = None,
    start: str | None = None,
    end: str | None = None,
    location: str | None = None,
    body_html: str | None = None,
    connection_id: str | None = None,
) -> Operation:
    """Build a update_calendar_event Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = UpdateCalendarEventArgs(event_id=event_id, subject=subject, start=start, end=end, location=location, body_html=body_html).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="exchange.update_calendar_event", args=_args)

def update_calendar_event(
    event_id: str,
    subject: str | None = None,
    start: str | None = None,
    end: str | None = None,
    location: str | None = None,
    body_html: str | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Update fields of an existing calendar event

    (WRITE — build it with `update_calendar_event.op(...)` and submit
    it with `run_plan([...])`. Calling this directly raises.)

    start: New start (ISO 8601 with timezone offset)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    raise FretikActionError(
        "update_calendar_event is a WRITE action and does not execute on its own. "
        "Build it with .op(...) and submit it with run_plan([...]): "
        "run_plan([exchange.update_calendar_event.op(...)])"
    )

update_calendar_event.op = _update_calendar_event_op


def _delete_calendar_event_op(
    event_id: str,
    connection_id: str | None = None,
) -> Operation:
    """Build a delete_calendar_event Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = DeleteCalendarEventArgs(event_id=event_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="exchange.delete_calendar_event", args=_args)

def delete_calendar_event(
    event_id: str,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Delete a calendar event (cancels for attendees)

    (WRITE — build it with `delete_calendar_event.op(...)` and submit
    it with `run_plan([...])`. Calling this directly raises.)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    raise FretikActionError(
        "delete_calendar_event is a WRITE action and does not execute on its own. "
        "Build it with .op(...) and submit it with run_plan([...]): "
        "run_plan([exchange.delete_calendar_event.op(...)])"
    )

delete_calendar_event.op = _delete_calendar_event_op


def _respond_to_event_op(
    event_id: str,
    response: Literal["accept", "decline", "tentativelyAccept"],
    comment: str | None = None,
    connection_id: str | None = None,
) -> Operation:
    """Build a respond_to_event Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = RespondToEventArgs(event_id=event_id, response=response, comment=comment).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="exchange.respond_to_event", args=_args)

def respond_to_event(
    event_id: str,
    response: Literal["accept", "decline", "tentativelyAccept"],
    comment: str | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Accept, decline or tentatively accept a meeting invite

    (WRITE — build it with `respond_to_event.op(...)` and submit
    it with `run_plan([...])`. Calling this directly raises.)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    raise FretikActionError(
        "respond_to_event is a WRITE action and does not execute on its own. "
        "Build it with .op(...) and submit it with run_plan([...]): "
        "run_plan([exchange.respond_to_event.op(...)])"
    )

respond_to_event.op = _respond_to_event_op


def _create_contact_op(
    given_name: str,
    surname: str | None = None,
    email: str | None = None,
    company_name: str | None = None,
    job_title: str | None = None,
    mobile_phone: str | None = None,
    connection_id: str | None = None,
) -> Operation:
    """Build a create_contact Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = CreateContactArgs(given_name=given_name, surname=surname, email=email, company_name=company_name, job_title=job_title, mobile_phone=mobile_phone).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="exchange.create_contact", args=_args)

def create_contact(
    given_name: str,
    surname: str | None = None,
    email: str | None = None,
    company_name: str | None = None,
    job_title: str | None = None,
    mobile_phone: str | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Create a new contact

    (WRITE — build it with `create_contact.op(...)` and submit
    it with `run_plan([...])`. Calling this directly raises.)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    raise FretikActionError(
        "create_contact is a WRITE action and does not execute on its own. "
        "Build it with .op(...) and submit it with run_plan([...]): "
        "run_plan([exchange.create_contact.op(...)])"
    )

create_contact.op = _create_contact_op
