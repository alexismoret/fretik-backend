# AUTO-GENERATED from manifest.ts — do not edit by hand. Regenerate: bun run gen:sdk

"""Microsoft Outlook provider — 28 actions.

All calls go through fretik-backend → Nango Proxy. Write actions return
an Operation when called as `.op(...)` (use with run_plan(...));
when called directly they are sugar for run_plan([op]).
"""

from typing import Any, Literal
from pydantic import BaseModel
from ._runtime import FretikActionError, Operation, _call_read, run_plan


# ── Types ─────────────────────────────────────────────────────────

class EmailAddress(BaseModel):
    address: str
    name: str | None = None


class Message(BaseModel):
    id: str
    subject: str
    from_address: str
    to: list[str]
    received_at: str
    is_read: bool
    has_attachments: bool
    body_preview: str
    web_link: str | None = None


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
    web_link: str | None = None


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
    web_link: str | None = None


class Contact(BaseModel):
    id: str
    display_name: str
    email_addresses: list[str]
    company_name: str | None = None
    job_title: str | None = None
    mobile_phone: str | None = None


class WriteResult(BaseModel):
    id: str | None = None


class Attachment(BaseModel):
    id: str
    name: str
    content_type: str
    size_bytes: int
    content_base64: str | None = None


# ── Per-action argument models (Pydantic validation in-sandbox) ──

class ListMessagesArgs(BaseModel):
    folder: Literal["inbox", "sentitems", "drafts", "deleteditems", "archive", "junkemail"] | None = "inbox"
    unread_only: bool | None = None
    limit: int | None = 25


class GetMessageArgs(BaseModel):
    message_id: str


class SearchMessagesArgs(BaseModel):
    query: str
    limit: int | None = 25


class ListMessagesInFolderArgs(BaseModel):
    folder_id: str
    unread_only: bool | None = None
    limit: int | None = 25


class ListFoldersArgs(BaseModel):
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
    attachments: list[dict[str, Any]] | None = None


class ReplyAllEmailArgs(BaseModel):
    message_id: str
    body_html: str
    attachments: list[dict[str, Any]] | None = None


class ForwardEmailArgs(BaseModel):
    message_id: str
    to: list[str]
    comment: str | None = None
    attachments: list[dict[str, Any]] | None = None


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


class MarkReadArgs(BaseModel):
    message_id: str


class MarkUnreadArgs(BaseModel):
    message_id: str


class FlagMessageArgs(BaseModel):
    message_id: str


class CreateFolderArgs(BaseModel):
    display_name: str
    parent_folder_id: str | None = None


class ListMessageAttachmentsArgs(BaseModel):
    message_id: str


class DownloadMessageAttachmentArgs(BaseModel):
    message_id: str
    attachment_id: str


class ListCalendarEventsArgs(BaseModel):
    start: str
    end: str
    limit: int | None = 50


class GetCalendarEventArgs(BaseModel):
    event_id: str


class CreateCalendarEventArgs(BaseModel):
    subject: str
    start: str
    end: str
    time_zone: str | None = "UTC"
    location: str | None = None
    attendees: list[str] | None = None
    body_html: str | None = None
    is_online_meeting: bool | None = None


class UpdateCalendarEventArgs(BaseModel):
    event_id: str
    subject: str | None = None
    start: str | None = None
    end: str | None = None
    time_zone: str | None = "UTC"
    location: str | None = None
    body_html: str | None = None


class DeleteCalendarEventArgs(BaseModel):
    event_id: str


class RespondToEventArgs(BaseModel):
    event_id: str
    response: Literal["accept", "decline", "tentativelyAccept"]
    comment: str | None = None


class ListContactsArgs(BaseModel):
    limit: int | None = 50


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
    connection_id: str | None = None,
) -> list[Message]:
    """List emails from a well-known mail folder

    folder: Well-known folder name

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = ListMessagesArgs(folder=folder, unread_only=unread_only, limit=limit).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("outlook.list_messages", _args)
    return [Message(**item) for item in data]


def get_message(
    message_id: str,
    connection_id: str | None = None,
) -> MessageFull:
    """Fetch one email by ID, with its full HTML body

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = GetMessageArgs(message_id=message_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("outlook.get_message", _args)
    return MessageFull(**data)


def search_messages(
    query: str,
    limit: int | None = 25,
    connection_id: str | None = None,
) -> list[Message]:
    """Full-text search across the mailbox

    query: Free-text search query

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = SearchMessagesArgs(query=query, limit=limit).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("outlook.search_messages", _args)
    return [Message(**item) for item in data]


def list_messages_in_folder(
    folder_id: str,
    unread_only: bool | None = None,
    limit: int | None = 25,
    connection_id: str | None = None,
) -> list[Message]:
    """List emails from a custom folder by its folder ID

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = ListMessagesInFolderArgs(folder_id=folder_id, unread_only=unread_only, limit=limit).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("outlook.list_messages_in_folder", _args)
    return [Message(**item) for item in data]


def list_folders(
    connection_id: str | None = None,
) -> list[MailFolder]:
    """List the top-level mail folders of the mailbox

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = ListFoldersArgs().model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("outlook.list_folders", _args)
    return [MailFolder(**item) for item in data]


def list_message_attachments(
    message_id: str,
    connection_id: str | None = None,
) -> list[Attachment]:
    """List attachments on a message (metadata only — no content)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = ListMessageAttachmentsArgs(message_id=message_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("outlook.list_message_attachments", _args)
    return [Attachment(**item) for item in data]


def download_message_attachment(
    message_id: str,
    attachment_id: str,
    connection_id: str | None = None,
) -> Attachment:
    """Download one attachment in base64 (file attachments only)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = DownloadMessageAttachmentArgs(message_id=message_id, attachment_id=attachment_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("outlook.download_message_attachment", _args)
    return Attachment(**data)


def list_calendar_events(
    start: str,
    end: str,
    limit: int | None = 50,
    connection_id: str | None = None,
) -> list[CalendarEvent]:
    """List calendar events within a date window

    start: Window start (ISO 8601)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = ListCalendarEventsArgs(start=start, end=end, limit=limit).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("outlook.list_calendar_events", _args)
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
    data = _call_read("outlook.get_calendar_event", _args)
    return CalendarEvent(**data)


def list_contacts(
    limit: int | None = 50,
    connection_id: str | None = None,
) -> list[Contact]:
    """List contacts from the mailbox

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = ListContactsArgs(limit=limit).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("outlook.list_contacts", _args)
    return [Contact(**item) for item in data]


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
    return Operation(action="outlook.send_email", args=_args)

def send_email(
    to: list[str],
    subject: str,
    body_html: str,
    cc: list[str] | None = None,
    bcc: list[str] | None = None,
    attachments: list[dict[str, Any]] | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Send a new email immediately (with optional inline attachments < 3MB)

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    body_html: HTML body

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _send_email_op(
        to=to,
        subject=subject,
        body_html=body_html,
        cc=cc,
        bcc=bcc,
        attachments=attachments,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "send_email failed"))
    return result[0].get("data", {})

send_email.op = _send_email_op


def _reply_email_op(
    message_id: str,
    body_html: str,
    attachments: list[dict[str, Any]] | None = None,
    connection_id: str | None = None,
) -> Operation:
    """Build a reply_email Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = ReplyEmailArgs(message_id=message_id, body_html=body_html, attachments=attachments).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="outlook.reply_email", args=_args)

def reply_email(
    message_id: str,
    body_html: str,
    attachments: list[dict[str, Any]] | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Reply to the sender of a message (with optional attachments)

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _reply_email_op(
        message_id=message_id,
        body_html=body_html,
        attachments=attachments,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "reply_email failed"))
    return result[0].get("data", {})

reply_email.op = _reply_email_op


def _reply_all_email_op(
    message_id: str,
    body_html: str,
    attachments: list[dict[str, Any]] | None = None,
    connection_id: str | None = None,
) -> Operation:
    """Build a reply_all_email Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = ReplyAllEmailArgs(message_id=message_id, body_html=body_html, attachments=attachments).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="outlook.reply_all_email", args=_args)

def reply_all_email(
    message_id: str,
    body_html: str,
    attachments: list[dict[str, Any]] | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Reply to all recipients of a message (with optional attachments)

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _reply_all_email_op(
        message_id=message_id,
        body_html=body_html,
        attachments=attachments,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "reply_all_email failed"))
    return result[0].get("data", {})

reply_all_email.op = _reply_all_email_op


def _forward_email_op(
    message_id: str,
    to: list[str],
    comment: str | None = None,
    attachments: list[dict[str, Any]] | None = None,
    connection_id: str | None = None,
) -> Operation:
    """Build a forward_email Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = ForwardEmailArgs(message_id=message_id, to=to, comment=comment, attachments=attachments).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="outlook.forward_email", args=_args)

def forward_email(
    message_id: str,
    to: list[str],
    comment: str | None = None,
    attachments: list[dict[str, Any]] | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Forward a message to new recipients (with optional attachments)

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _forward_email_op(
        message_id=message_id,
        to=to,
        comment=comment,
        attachments=attachments,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "forward_email failed"))
    return result[0].get("data", {})

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
    return Operation(action="outlook.create_draft", args=_args)

def create_draft(
    to: list[str],
    subject: str,
    body_html: str,
    cc: list[str] | None = None,
    attachments: list[dict[str, Any]] | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Create a draft email (not sent), with optional attachments

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _create_draft_op(
        to=to,
        subject=subject,
        body_html=body_html,
        cc=cc,
        attachments=attachments,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "create_draft failed"))
    return result[0].get("data", {})

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
    return Operation(action="outlook.update_draft", args=_args)

def update_draft(
    message_id: str,
    subject: str | None = None,
    body_html: str | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Update the subject or body of an existing draft

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _update_draft_op(
        message_id=message_id,
        subject=subject,
        body_html=body_html,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "update_draft failed"))
    return result[0].get("data", {})

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
    return Operation(action="outlook.delete_message", args=_args)

def delete_message(
    message_id: str,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Delete a message (moves it to Deleted Items)

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _delete_message_op(
        message_id=message_id,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "delete_message failed"))
    return result[0].get("data", {})

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
    return Operation(action="outlook.move_message", args=_args)

def move_message(
    message_id: str,
    destination_folder_id: str,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Move a message to another mail folder

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _move_message_op(
        message_id=message_id,
        destination_folder_id=destination_folder_id,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "move_message failed"))
    return result[0].get("data", {})

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
    return Operation(action="outlook.copy_message", args=_args)

def copy_message(
    message_id: str,
    destination_folder_id: str,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Copy a message into another mail folder

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _copy_message_op(
        message_id=message_id,
        destination_folder_id=destination_folder_id,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "copy_message failed"))
    return result[0].get("data", {})

copy_message.op = _copy_message_op


def _mark_read_op(
    message_id: str,
    connection_id: str | None = None,
) -> Operation:
    """Build a mark_read Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = MarkReadArgs(message_id=message_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="outlook.mark_read", args=_args)

def mark_read(
    message_id: str,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Mark a message as read

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _mark_read_op(
        message_id=message_id,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "mark_read failed"))
    return result[0].get("data", {})

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
    return Operation(action="outlook.mark_unread", args=_args)

def mark_unread(
    message_id: str,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Mark a message as unread

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _mark_unread_op(
        message_id=message_id,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "mark_unread failed"))
    return result[0].get("data", {})

mark_unread.op = _mark_unread_op


def _flag_message_op(
    message_id: str,
    connection_id: str | None = None,
) -> Operation:
    """Build a flag_message Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = FlagMessageArgs(message_id=message_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="outlook.flag_message", args=_args)

def flag_message(
    message_id: str,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Flag a message for follow-up

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _flag_message_op(
        message_id=message_id,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "flag_message failed"))
    return result[0].get("data", {})

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
    return Operation(action="outlook.create_folder", args=_args)

def create_folder(
    display_name: str,
    parent_folder_id: str | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Create a new mail folder

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    parent_folder_id: Parent folder ID (top-level if omitted)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _create_folder_op(
        display_name=display_name,
        parent_folder_id=parent_folder_id,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "create_folder failed"))
    return result[0].get("data", {})

create_folder.op = _create_folder_op


def _create_calendar_event_op(
    subject: str,
    start: str,
    end: str,
    time_zone: str | None = "UTC",
    location: str | None = None,
    attendees: list[str] | None = None,
    body_html: str | None = None,
    is_online_meeting: bool | None = None,
    connection_id: str | None = None,
) -> Operation:
    """Build a create_calendar_event Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = CreateCalendarEventArgs(subject=subject, start=start, end=end, time_zone=time_zone, location=location, attendees=attendees, body_html=body_html, is_online_meeting=is_online_meeting).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="outlook.create_calendar_event", args=_args)

def create_calendar_event(
    subject: str,
    start: str,
    end: str,
    time_zone: str | None = "UTC",
    location: str | None = None,
    attendees: list[str] | None = None,
    body_html: str | None = None,
    is_online_meeting: bool | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Create a calendar event

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _create_calendar_event_op(
        subject=subject,
        start=start,
        end=end,
        time_zone=time_zone,
        location=location,
        attendees=attendees,
        body_html=body_html,
        is_online_meeting=is_online_meeting,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "create_calendar_event failed"))
    return result[0].get("data", {})

create_calendar_event.op = _create_calendar_event_op


def _update_calendar_event_op(
    event_id: str,
    subject: str | None = None,
    start: str | None = None,
    end: str | None = None,
    time_zone: str | None = "UTC",
    location: str | None = None,
    body_html: str | None = None,
    connection_id: str | None = None,
) -> Operation:
    """Build a update_calendar_event Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = UpdateCalendarEventArgs(event_id=event_id, subject=subject, start=start, end=end, time_zone=time_zone, location=location, body_html=body_html).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="outlook.update_calendar_event", args=_args)

def update_calendar_event(
    event_id: str,
    subject: str | None = None,
    start: str | None = None,
    end: str | None = None,
    time_zone: str | None = "UTC",
    location: str | None = None,
    body_html: str | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Update fields of an existing calendar event

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _update_calendar_event_op(
        event_id=event_id,
        subject=subject,
        start=start,
        end=end,
        time_zone=time_zone,
        location=location,
        body_html=body_html,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "update_calendar_event failed"))
    return result[0].get("data", {})

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
    return Operation(action="outlook.delete_calendar_event", args=_args)

def delete_calendar_event(
    event_id: str,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Delete a calendar event

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _delete_calendar_event_op(
        event_id=event_id,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "delete_calendar_event failed"))
    return result[0].get("data", {})

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
    return Operation(action="outlook.respond_to_event", args=_args)

def respond_to_event(
    event_id: str,
    response: Literal["accept", "decline", "tentativelyAccept"],
    comment: str | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Accept, decline or tentatively accept a meeting invite

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _respond_to_event_op(
        event_id=event_id,
        response=response,
        comment=comment,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "respond_to_event failed"))
    return result[0].get("data", {})

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
    return Operation(action="outlook.create_contact", args=_args)

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

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _create_contact_op(
        given_name=given_name,
        surname=surname,
        email=email,
        company_name=company_name,
        job_title=job_title,
        mobile_phone=mobile_phone,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "create_contact failed"))
    return result[0].get("data", {})

create_contact.op = _create_contact_op
