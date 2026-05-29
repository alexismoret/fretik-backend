# AUTO-GENERATED from manifest.ts — do not edit by hand. Regenerate: bun run gen:sdk

"""Email (IMAP/SMTP) provider — 19 actions.

All calls go through fretik-backend, which dispatches them to the
provider (Nango Proxy or a custom handler). Write actions return an
Operation when called as `.op(...)` (use with run_plan(...));
when called directly they are sugar for run_plan([op]).
"""

from typing import Any, Literal, Optional
from pydantic import BaseModel
from ._runtime import FretikActionError, Operation, _call_read, run_plan


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


class Attachment(BaseModel):
    id: str
    name: str
    content_type: str
    size_bytes: int
    sandbox_path: str | None = None
    content_base64: str | None = None


class WriteResult(BaseModel):
    id: str | None = None


# ── Per-action argument models (Pydantic validation in-sandbox) ──

class ListMessagesArgs(BaseModel):
    folder: Literal["inbox", "sentitems", "drafts", "deleteditems", "archive", "junkemail", "flagged", "important", "allmail"] | None = "inbox"
    unread_only: bool | None = None
    limit: int | None = 25
    offset: int | None = 0


class GetMessageArgs(BaseModel):
    message_id: str


class SearchMessagesArgs(BaseModel):
    query: str | None = None
    query_or: list[str] | None = None
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


class ForwardEmailArgs(BaseModel):
    message_id: str
    to: list[str]
    comment: str | None = None
    attachments: list[dict[str, Any]] | None = None


class MarkReadArgs(BaseModel):
    message_id: str


class MarkUnreadArgs(BaseModel):
    message_id: str


class DeleteMessageArgs(BaseModel):
    message_id: str


class MoveMessageArgs(BaseModel):
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


class CreateFolderArgs(BaseModel):
    display_name: str
    parent_folder_id: str | None = None


# ── Read actions (eager — execute immediately) ─────────

def list_messages(
    folder: Literal["inbox", "sentitems", "drafts", "deleteditems", "archive", "junkemail", "flagged", "important", "allmail"] | None = "inbox",
    unread_only: bool | None = None,
    limit: int | None = 25,
    offset: int | None = 0,
    connection_id: str | None = None,
) -> list[Message]:
    """List emails from a well-known mail folder

    folder: Well-known folder (RFC 6154 SPECIAL-USE + Gmail's \\Important extension)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = ListMessagesArgs(folder=folder, unread_only=unread_only, limit=limit, offset=offset).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("imap-smtp.list_messages", _args)
    return [Message(**item) for item in data]


def get_message(
    message_id: str,
    connection_id: str | None = None,
) -> MessageFull:
    """Fetch one email by ID, with its full HTML body

    message_id: Opaque message ID from list_messages / search_messages

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = GetMessageArgs(message_id=message_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("imap-smtp.get_message", _args)
    return MessageFull(**data)


def search_messages(
    query: str | None = None,
    query_or: list[str] | None = None,
    limit: int | None = 25,
    offset: int | None = 0,
    connection_id: str | None = None,
) -> list[Message]:
    """Full-text search across the INBOX

    query: Free-text search query. IMAP SEARCH does NOT parse the 'OR' keyword — use `query_or` for alternatives instead.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = SearchMessagesArgs(query=query, query_or=query_or, limit=limit, offset=offset).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("imap-smtp.search_messages", _args)
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
    data = _call_read("imap-smtp.list_messages_in_folder", _args)
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
    data = _call_read("imap-smtp.list_folders", _args)
    return [MailFolder(**item) for item in data]


def list_message_attachments(
    message_id: str,
    connection_id: str | None = None,
) -> list[Attachment]:
    """List attachments on a message (metadata only — no content)

    message_id: Opaque message ID from list_messages / search_messages

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = ListMessageAttachmentsArgs(message_id=message_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("imap-smtp.list_message_attachments", _args)
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
    data = _call_read("imap-smtp.download_message_attachment", _args)
    return Attachment(**data)


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
    return Operation(action="imap-smtp.send_email", args=_args)

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
    return Operation(action="imap-smtp.reply_email", args=_args)

def reply_email(
    message_id: str,
    body_html: str,
    attachments: list[dict[str, Any]] | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Reply to the sender of a message (preserves In-Reply-To threading)

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
    return Operation(action="imap-smtp.forward_email", args=_args)

def forward_email(
    message_id: str,
    to: list[str],
    comment: str | None = None,
    attachments: list[dict[str, Any]] | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Forward a message to new recipients (with optional comment)

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


def _mark_read_op(
    message_id: str,
    connection_id: str | None = None,
) -> Operation:
    """Build a mark_read Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = MarkReadArgs(message_id=message_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="imap-smtp.mark_read", args=_args)

def mark_read(
    message_id: str,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Mark a message as read (sets the \\Seen flag)

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
    return Operation(action="imap-smtp.mark_unread", args=_args)

def mark_unread(
    message_id: str,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Mark a message as unread (clears the \\Seen flag)

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


def _delete_message_op(
    message_id: str,
    connection_id: str | None = None,
) -> Operation:
    """Build a delete_message Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = DeleteMessageArgs(message_id=message_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="imap-smtp.delete_message", args=_args)

def delete_message(
    message_id: str,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Move a message to Trash (or expunge if no Trash folder exists)

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
    return Operation(action="imap-smtp.move_message", args=_args)

def move_message(
    message_id: str,
    destination_folder_id: str,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Move a message to another folder

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    destination_folder_id: Destination folder ID from list_folders (or a folder path)

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


def _delete_messages_op(
    message_ids: list[str],
    connection_id: str | None = None,
) -> Operation:
    """Build a delete_messages Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = DeleteMessagesArgs(message_ids=message_ids).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="imap-smtp.delete_messages", args=_args)

def delete_messages(
    message_ids: list[str],
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Delete multiple messages in a single IMAP batch (move to Trash, or expunge if no Trash exists)

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    message_ids: Opaque message IDs from list_messages / search_messages. Mixed-folder IDs are grouped server-side — one IMAP command per source folder.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _delete_messages_op(
        message_ids=message_ids,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "delete_messages failed"))
    return result[0].get("data", {})

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
    return Operation(action="imap-smtp.move_messages", args=_args)

def move_messages(
    message_ids: list[str],
    destination_folder_id: str,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Move multiple messages to another folder in a single IMAP batch

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    destination_folder_id: Destination folder ID from list_folders

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _move_messages_op(
        message_ids=message_ids,
        destination_folder_id=destination_folder_id,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "move_messages failed"))
    return result[0].get("data", {})

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
    return Operation(action="imap-smtp.mark_messages_read", args=_args)

def mark_messages_read(
    message_ids: list[str],
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Mark multiple messages as read (single IMAP STORE per source folder)

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _mark_messages_read_op(
        message_ids=message_ids,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "mark_messages_read failed"))
    return result[0].get("data", {})

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
    return Operation(action="imap-smtp.mark_messages_unread", args=_args)

def mark_messages_unread(
    message_ids: list[str],
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Mark multiple messages as unread (single IMAP STORE per source folder)

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    op = _mark_messages_unread_op(
        message_ids=message_ids,
        connection_id=connection_id,
    )
    result = run_plan([op])
    if not result or not result[0].get("ok"):
        raise FretikActionError(result[0].get("error", "mark_messages_unread failed"))
    return result[0].get("data", {})

mark_messages_unread.op = _mark_messages_unread_op


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
    return Operation(action="imap-smtp.create_folder", args=_args)

def create_folder(
    display_name: str,
    parent_folder_id: str | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Create a new mail folder

    (WRITE — requires user approval. Raises ApprovalPending
    until the user grants the plan.)

    display_name: Folder name to create

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
