# AUTO-GENERATED from manifest.ts — do not edit by hand. Regenerate: bun run gen:sdk

"""File transfer (FTP/SFTP) provider — 10 actions.

All calls go through fretik-backend, which dispatches them to the
provider (Nango Proxy or a custom handler). Write actions return an
Operation via `.op(...)`; submit them with run_plan([...]).
Calling a write action directly raises — it never executes.
"""

from typing import Any, Literal, Optional
from pydantic import BaseModel
from ._runtime import FretikActionError, Operation, _call_read


# ── Types ─────────────────────────────────────────────────────────

class RemoteEntry(BaseModel):
    name: str
    path: str
    type: Literal["file", "directory", "symlink"]
    size_bytes: int | None = None
    modified_at: str | None = None
    mode: str | None = None
    owner: str | None = None
    group: str | None = None


class EntryLookup(BaseModel):
    path: str
    exists: bool
    type: Literal["file", "directory", "symlink"] | None = None
    size_bytes: int | None = None
    modified_at: str | None = None
    mode: str | None = None
    error: str | None = None


class RemoteFile(BaseModel):
    path: str
    name: str
    size_bytes: int
    content_type: str
    sandbox_path: str | None = None
    content_base64: str | None = None
    error: str | None = None


class ServerInfo(BaseModel):
    protocol: Literal["sftp", "ftp", "ftps", "ftps-implicit"]
    host: str
    working_directory: str
    supports_modified_time: bool
    supports_size: bool
    supports_permissions: bool
    root_path: str | None = None
    server_software: str | None = None


class WriteResult(BaseModel):
    path: str
    ok: bool
    error: str | None = None


# ── Per-action argument models (Pydantic validation in-sandbox) ──

class GetServerInfoArgs(BaseModel):
    pass


class ListDirectoryArgs(BaseModel):
    path: str | None = ""
    pattern: str | None = None
    include_directories: bool | None = True
    sort: Literal["name", "modified_desc", "size_desc"] | None = "name"
    limit: int | None = 200


class FindFilesArgs(BaseModel):
    pattern: str
    path: str | None = ""
    max_depth: int | None = 3
    modified_after: str | None = None
    limit: int | None = 200


class GetEntriesArgs(BaseModel):
    paths: list[str]


class DownloadFilesArgs(BaseModel):
    paths: list[str]


class UploadFilesArgs(BaseModel):
    files: list[dict[str, Any]]
    on_conflict: Literal["replace", "rename", "fail"] | None = "replace"
    create_directories: bool | None = True


class MoveEntriesArgs(BaseModel):
    moves: list[dict[str, Any]]
    create_directories: bool | None = True


class DeleteFilesArgs(BaseModel):
    paths: list[str]


class CreateDirectoryArgs(BaseModel):
    path: str
    mode: str | None = None


class DeleteDirectoryArgs(BaseModel):
    path: str
    recursive: bool | None = False


# ── Read actions (eager — execute immediately) ─────────

def get_server_info(
    connection_id: str | None = None,
) -> ServerInfo:
    """Show the connection's protocol, starting folder and capabilities

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = GetServerInfoArgs().model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("ftp-sftp.get_server_info", _args)
    return ServerInfo(**data)


def list_directory(
    path: str | None = "",
    pattern: str | None = None,
    include_directories: bool | None = True,
    sort: Literal["name", "modified_desc", "size_desc"] | None = "name",
    limit: int | None = 200,
    connection_id: str | None = None,
) -> list[RemoteEntry]:
    """List the files and folders directly inside one folder

    path: Folder to list. Omit for the connection's starting folder.

    pattern: Glob on the NAME, case-insensitive, e.g. `*.csv` or `ORDER_??.xml`. Omit for everything.

    include_directories: Set false to return files only

    sort: `modified_desc` needs a server that reports times — see get_server_info

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = ListDirectoryArgs(path=path, pattern=pattern, include_directories=include_directories, sort=sort, limit=limit).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("ftp-sftp.list_directory", _args)
    return [RemoteEntry(**item) for item in data]


def find_files(
    pattern: str,
    path: str | None = "",
    max_depth: int | None = 3,
    modified_after: str | None = None,
    limit: int | None = 200,
    connection_id: str | None = None,
) -> list[RemoteEntry]:
    """Search a folder tree for files matching a name pattern

    pattern: Glob on the file NAME, case-insensitive, e.g. `*.edi`. Use `*` for every file.

    path: Folder to search from. Omit for the starting folder.

    max_depth: 1 = the folder itself, no subfolders

    modified_after: Keep files modified strictly after this instant. Ignored on a server that reports no times.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = FindFilesArgs(pattern=pattern, path=path, max_depth=max_depth, modified_after=modified_after, limit=limit).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("ftp-sftp.find_files", _args)
    return [RemoteEntry(**item) for item in data]


def get_entries(
    paths: list[str],
    connection_id: str | None = None,
) -> list[EntryLookup]:
    """Check whether paths exist and read their metadata

    paths: Files or folders to look up, in one round-trip

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = GetEntriesArgs(paths=paths).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("ftp-sftp.get_entries", _args)
    return [EntryLookup(**item) for item in data]


def download_files(
    paths: list[str],
    connection_id: str | None = None,
) -> list[RemoteFile]:
    """Download files into the sandbox — bytes land at `sandbox_path`

    paths: Remote files to fetch. Up to 20 per call, 25 MB total — a file that fails comes back with `error` set while the rest still arrive.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = DownloadFilesArgs(paths=paths).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("ftp-sftp.download_files", _args)
    return [RemoteFile(**item) for item in data]


# ── Write actions (use `.op(...)` inside run_plan([...])) ───

def _upload_files_op(
    files: list[dict[str, Any]],
    on_conflict: Literal["replace", "rename", "fail"] | None = "replace",
    create_directories: bool | None = True,
    connection_id: str | None = None,
) -> Operation:
    """Build a upload_files Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = UploadFilesArgs(files=files, on_conflict=on_conflict, create_directories=create_directories).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="ftp-sftp.upload_files", args=_args)

def upload_files(
    files: list[dict[str, Any]],
    on_conflict: Literal["replace", "rename", "fail"] | None = "replace",
    create_directories: bool | None = True,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Upload files to the server (creates missing folders)

    (WRITE — build it with `upload_files.op(...)` and submit
    it with `run_plan([...])`. Calling this directly raises.)

    files: Files to send. Up to 20 per call, 20 MB total.

    on_conflict: `rename` appends a numeric suffix; `fail` leaves the existing file alone and reports it

    create_directories: Create missing parent folders

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    raise FretikActionError(
        "upload_files is a WRITE action and does not execute on its own. "
        "Build it with .op(...) and submit it with run_plan([...]): "
        "run_plan([ftp_sftp.upload_files.op(...)])"
    )

upload_files.op = _upload_files_op


def _move_entries_op(
    moves: list[dict[str, Any]],
    create_directories: bool | None = True,
    connection_id: str | None = None,
) -> Operation:
    """Build a move_entries Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = MoveEntriesArgs(moves=moves, create_directories=create_directories).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="ftp-sftp.move_entries", args=_args)

def move_entries(
    moves: list[dict[str, Any]],
    create_directories: bool | None = True,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Move or rename files and folders

    (WRITE — build it with `move_entries.op(...)` and submit
    it with `run_plan([...])`. Calling this directly raises.)

    moves: Each entry moves one path to another

    create_directories: Create the destination's parent folders if missing

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    raise FretikActionError(
        "move_entries is a WRITE action and does not execute on its own. "
        "Build it with .op(...) and submit it with run_plan([...]): "
        "run_plan([ftp_sftp.move_entries.op(...)])"
    )

move_entries.op = _move_entries_op


def _delete_files_op(
    paths: list[str],
    connection_id: str | None = None,
) -> Operation:
    """Build a delete_files Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = DeleteFilesArgs(paths=paths).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="ftp-sftp.delete_files", args=_args)

def delete_files(
    paths: list[str],
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Delete files (not folders)

    (WRITE — build it with `delete_files.op(...)` and submit
    it with `run_plan([...])`. Calling this directly raises.)

    paths: Files to delete. A path that is a folder is refused.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    raise FretikActionError(
        "delete_files is a WRITE action and does not execute on its own. "
        "Build it with .op(...) and submit it with run_plan([...]): "
        "run_plan([ftp_sftp.delete_files.op(...)])"
    )

delete_files.op = _delete_files_op


def _create_directory_op(
    path: str,
    mode: str | None = None,
    connection_id: str | None = None,
) -> Operation:
    """Build a create_directory Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = CreateDirectoryArgs(path=path, mode=mode).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="ftp-sftp.create_directory", args=_args)

def create_directory(
    path: str,
    mode: str | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Create a folder, with any missing parents

    (WRITE — build it with `create_directory.op(...)` and submit
    it with `run_plan([...])`. Calling this directly raises.)

    mode: POSIX permissions, e.g. `0755`. SFTP only.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    raise FretikActionError(
        "create_directory is a WRITE action and does not execute on its own. "
        "Build it with .op(...) and submit it with run_plan([...]): "
        "run_plan([ftp_sftp.create_directory.op(...)])"
    )

create_directory.op = _create_directory_op


def _delete_directory_op(
    path: str,
    recursive: bool | None = False,
    connection_id: str | None = None,
) -> Operation:
    """Build a delete_directory Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = DeleteDirectoryArgs(path=path, recursive=recursive).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="ftp-sftp.delete_directory", args=_args)

def delete_directory(
    path: str,
    recursive: bool | None = False,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Delete a folder — empty by default, with its contents on request

    (WRITE — build it with `delete_directory.op(...)` and submit
    it with `run_plan([...])`. Calling this directly raises.)

    recursive: true deletes everything inside it. Left false, a non-empty folder is refused.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    raise FretikActionError(
        "delete_directory is a WRITE action and does not execute on its own. "
        "Build it with .op(...) and submit it with run_plan([...]): "
        "run_plan([ftp_sftp.delete_directory.op(...)])"
    )

delete_directory.op = _delete_directory_op
