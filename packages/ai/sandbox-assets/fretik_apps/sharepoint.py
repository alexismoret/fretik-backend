# AUTO-GENERATED from manifest.ts — do not edit by hand. Regenerate: bun run gen:sdk

"""Microsoft SharePoint provider — 32 actions.

All calls go through fretik-backend, which dispatches them to the
provider (Nango Proxy or a custom handler). Write actions return an
Operation via `.op(...)`; submit them with run_plan([...]).
Calling a write action directly raises — it never executes.
"""

from typing import Any, Literal, Optional
from pydantic import BaseModel
from ._runtime import FretikActionError, Operation, _call_read


# ── Types ─────────────────────────────────────────────────────────

class Site(BaseModel):
    id: str
    name: str
    display_name: str
    web_url: str
    description: str | None = None
    created_at: str | None = None
    last_modified_at: str | None = None


class Library(BaseModel):
    id: str
    name: str
    web_url: str
    drive_type: str
    description: str | None = None


class DriveItem(BaseModel):
    id: str
    name: str
    is_folder: bool
    size_bytes: int
    web_url: str
    created_at: str
    last_modified_at: str
    mime_type: str | None = None
    child_count: int | None = None
    parent_folder_id: str | None = None
    parent_path: str | None = None
    drive_id: str | None = None
    list_item_id: str | None = None
    list_id: str | None = None
    last_modified_by: str | None = None


class FileDownload(BaseModel):
    id: str
    name: str
    content_type: str
    size_bytes: int
    sandbox_path: str | None = None
    download_url: str | None = None


class ItemVersion(BaseModel):
    id: str
    last_modified_at: str
    size_bytes: int | None = None
    last_modified_by: str | None = None


class Permission(BaseModel):
    id: str
    roles: list[str]
    granted_to: list[str]
    inherited: bool
    link_type: str | None = None
    link_scope: str | None = None
    link_url: str | None = None
    expires_at: str | None = None


class ShareLink(BaseModel):
    id: str
    link_url: str
    link_type: str
    link_scope: str
    expires_at: str | None = None


class SharePointList(BaseModel):
    id: str
    name: str
    display_name: str
    web_url: str
    description: str | None = None
    template: str | None = None
    created_at: str | None = None


class ListColumn(BaseModel):
    name: str
    display_name: str
    type: str
    required: bool
    read_only: bool
    choices: list[str] | None = None
    description: str | None = None


class ListItem(BaseModel):
    id: str
    fields: dict[str, Any]
    web_url: str | None = None
    created_at: str | None = None
    last_modified_at: str | None = None
    created_by: str | None = None
    last_modified_by: str | None = None


class SitePage(BaseModel):
    id: str
    name: str
    title: str
    web_url: str
    description: str | None = None
    page_layout: str | None = None
    published_at: str | None = None
    content_html: str | None = None


class SearchHit(BaseModel):
    kind: Literal["driveItem", "listItem", "list", "drive", "site"]
    id: str
    name: str
    summary: str
    web_url: str | None = None
    drive_id: str | None = None
    site_id: str | None = None
    list_id: str | None = None
    size_bytes: int | None = None
    last_modified_at: str | None = None


class UploadSession(BaseModel):
    upload_url: str
    expires_at: str | None = None


class DriveItemPage(BaseModel):
    items: list[DriveItem]
    page_token: Optional[str] = None


class ListItemPage(BaseModel):
    items: list[ListItem]
    page_token: Optional[str] = None


# ── Per-action argument models (Pydantic validation in-sandbox) ──

class SearchSitesArgs(BaseModel):
    query: str
    limit: int | None = 25


class GetSiteArgs(BaseModel):
    site_id: str


class GetSiteByUrlArgs(BaseModel):
    site_url: str


class ListFollowedSitesArgs(BaseModel):
    limit: int | None = 50


class ListLibrariesArgs(BaseModel):
    site_id: str


class ListFolderArgs(BaseModel):
    drive_id: str
    folder_id: str | None = None
    folder_path: str | None = None
    limit: int | None = 100
    page_token: str | None = None


class GetItemArgs(BaseModel):
    drive_id: str
    item_id: str | None = None
    item_path: str | None = None


class SearchLibraryArgs(BaseModel):
    drive_id: str
    query: str
    limit: int | None = 25


class SearchArgs(BaseModel):
    query: str
    entity_types: list[Literal["driveItem", "listItem", "list", "drive", "site"]] | None = ["driveItem"]
    limit: int | None = 25
    offset: int | None = 0


class DownloadFileArgs(BaseModel):
    drive_id: str
    item_id: str


class ResolveShareLinkArgs(BaseModel):
    share_url: str


class ListVersionsArgs(BaseModel):
    drive_id: str
    item_id: str
    limit: int | None = 20


class ListPermissionsArgs(BaseModel):
    drive_id: str
    item_id: str


class CreateFolderArgs(BaseModel):
    drive_id: str
    name: str
    parent_folder_id: str | None = "root"
    conflict_behavior: Literal["rename", "replace", "fail"] | None = "rename"


class CreateUploadSessionArgs(BaseModel):
    drive_id: str
    file_name: str
    parent_folder_id: str | None = "root"
    conflict_behavior: Literal["rename", "replace", "fail"] | None = "rename"


class UpdateItemArgs(BaseModel):
    drive_id: str
    item_id: str
    new_name: str | None = None
    new_parent_folder_id: str | None = None


class DeleteItemArgs(BaseModel):
    drive_id: str
    item_id: str


class CopyItemArgs(BaseModel):
    drive_id: str
    item_id: str
    target_folder_id: str
    target_drive_id: str | None = None
    new_name: str | None = None


class RestoreVersionArgs(BaseModel):
    drive_id: str
    item_id: str
    version_id: str


class CreateShareLinkArgs(BaseModel):
    drive_id: str
    item_id: str
    link_type: Literal["view", "edit", "embed"] | None = "view"
    scope: Literal["organization", "anonymous", "users"] | None = "organization"
    expiration_date: str | None = None


class GrantItemAccessArgs(BaseModel):
    drive_id: str
    item_id: str
    emails: list[str]
    role: Literal["read", "write"] | None = "read"
    message: str | None = None
    send_invitation: bool | None = True
    require_sign_in: bool | None = True
    expiration_date: str | None = None


class RevokeItemAccessArgs(BaseModel):
    drive_id: str
    item_id: str
    permission_id: str


class ListListsArgs(BaseModel):
    site_id: str


class GetListArgs(BaseModel):
    site_id: str
    list_id: str


class ListColumnsArgs(BaseModel):
    site_id: str
    list_id: str


class ListListItemsArgs(BaseModel):
    site_id: str
    list_id: str
    filter: str | None = None
    order_by: str | None = None
    columns: list[str] | None = None
    limit: int | None = 50
    page_token: str | None = None


class GetListItemArgs(BaseModel):
    site_id: str
    list_id: str
    item_id: str


class CreateListItemArgs(BaseModel):
    site_id: str
    list_id: str
    fields: dict[str, Any]


class UpdateListItemArgs(BaseModel):
    site_id: str
    list_id: str
    item_id: str
    fields: dict[str, Any]


class DeleteListItemArgs(BaseModel):
    site_id: str
    list_id: str
    item_id: str


class ListPagesArgs(BaseModel):
    site_id: str
    limit: int | None = 50


class GetPageArgs(BaseModel):
    site_id: str
    page_id: str


# ── Read actions (eager — execute immediately) ─────────

def search_sites(
    query: str,
    limit: int | None = 25,
    connection_id: str | None = None,
) -> list[Site]:
    """Find SharePoint sites by name across the tenant

    query: Matches the site title and URL. `*` returns every site the account can see.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = SearchSitesArgs(query=query, limit=limit).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("sharepoint.search_sites", _args)
    return [Site(**item) for item in data]


def get_site(
    site_id: str,
    connection_id: str | None = None,
) -> Site:
    """Fetch one site by ID

    site_id: Composite site id, or `root` for the tenant root site

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = GetSiteArgs(site_id=site_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("sharepoint.get_site", _args)
    return Site(**data)


def get_site_by_url(
    site_url: str,
    connection_id: str | None = None,
) -> Site:
    """Resolve a SharePoint URL the user pasted into its site

    site_url: Any URL inside the site, e.g. `https://contoso.sharepoint.com/sites/Legal` or a deep link to a document. Everything past the site segment is ignored.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = GetSiteByUrlArgs(site_url=site_url).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("sharepoint.get_site_by_url", _args)
    return Site(**data)


def list_followed_sites(
    limit: int | None = 50,
    connection_id: str | None = None,
) -> list[Site]:
    """List the sites the connected account follows

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = ListFollowedSitesArgs(limit=limit).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("sharepoint.list_followed_sites", _args)
    return [Site(**item) for item in data]


def list_libraries(
    site_id: str,
    connection_id: str | None = None,
) -> list[Library]:
    """List a site's document libraries

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = ListLibrariesArgs(site_id=site_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("sharepoint.list_libraries", _args)
    return [Library(**item) for item in data]


def list_folder(
    drive_id: str,
    folder_id: str | None = None,
    folder_path: str | None = None,
    limit: int | None = 100,
    page_token: str | None = None,
    connection_id: str | None = None,
) -> DriveItemPage:
    """List the files and folders directly inside a folder

    folder_id: Defaults to the library root

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = ListFolderArgs(drive_id=drive_id, folder_id=folder_id, folder_path=folder_path, limit=limit, page_token=page_token).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("sharepoint.list_folder", _args)
    return DriveItemPage(items=[DriveItem(**item) for item in data.get("items", [])], page_token=data.get("page_token"))


def get_item(
    drive_id: str,
    item_id: str | None = None,
    item_path: str | None = None,
    connection_id: str | None = None,
) -> DriveItem:
    """Fetch one file or folder's metadata by ID or by path

    item_path: Library-relative path instead of an id, e.g. `Contracts/2026/acme.pdf`. Ignored when `item_id` is set.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = GetItemArgs(drive_id=drive_id, item_id=item_id, item_path=item_path).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("sharepoint.get_item", _args)
    return DriveItem(**data)


def search_library(
    drive_id: str,
    query: str,
    limit: int | None = 25,
    connection_id: str | None = None,
) -> list[DriveItem]:
    """Search file and folder names + contents inside ONE library

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = SearchLibraryArgs(drive_id=drive_id, query=query, limit=limit).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("sharepoint.search_library", _args)
    return [DriveItem(**item) for item in data]


def search(
    query: str,
    entity_types: list[Literal["driveItem", "listItem", "list", "drive", "site"]] | None = ["driveItem"],
    limit: int | None = 25,
    offset: int | None = 0,
    connection_id: str | None = None,
) -> list[SearchHit]:
    """Search files, list rows and sites across the WHOLE tenant (Microsoft Search)

    query: Keywords, or KQL — `filetype:pdf`, `path:"https://…/Contracts"`, `LastModifiedTime>=2026-01-01`, `author:"Marie"`.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = SearchArgs(query=query, entity_types=entity_types, limit=limit, offset=offset).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("sharepoint.search", _args)
    return [SearchHit(**item) for item in data]


def download_file(
    drive_id: str,
    item_id: str,
    connection_id: str | None = None,
) -> FileDownload:
    """Download a file's content into the sandbox

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = DownloadFileArgs(drive_id=drive_id, item_id=item_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("sharepoint.download_file", _args)
    return FileDownload(**data)


def resolve_share_link(
    share_url: str,
    connection_id: str | None = None,
) -> DriveItem:
    """Turn a SharePoint/OneDrive sharing link into the file it points at

    share_url: The link as the user pasted it, including any `?e=…` suffix

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = ResolveShareLinkArgs(share_url=share_url).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("sharepoint.resolve_share_link", _args)
    return DriveItem(**data)


def list_versions(
    drive_id: str,
    item_id: str,
    limit: int | None = 20,
    connection_id: str | None = None,
) -> list[ItemVersion]:
    """List a file's version history

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = ListVersionsArgs(drive_id=drive_id, item_id=item_id, limit=limit).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("sharepoint.list_versions", _args)
    return [ItemVersion(**item) for item in data]


def list_permissions(
    drive_id: str,
    item_id: str,
    connection_id: str | None = None,
) -> list[Permission]:
    """List who has access to a file or folder, and how

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = ListPermissionsArgs(drive_id=drive_id, item_id=item_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("sharepoint.list_permissions", _args)
    return [Permission(**item) for item in data]


def list_lists(
    site_id: str,
    connection_id: str | None = None,
) -> list[SharePointList]:
    """List a site's lists (and its libraries seen as lists)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = ListListsArgs(site_id=site_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("sharepoint.list_lists", _args)
    return [SharePointList(**item) for item in data]


def get_list(
    site_id: str,
    list_id: str,
    connection_id: str | None = None,
) -> SharePointList:
    """Fetch one list by ID or by its URL slug

    list_id: List id, or the list's URL slug (its `name`)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = GetListArgs(site_id=site_id, list_id=list_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("sharepoint.get_list", _args)
    return SharePointList(**data)


def list_columns(
    site_id: str,
    list_id: str,
    connection_id: str | None = None,
) -> list[ListColumn]:
    """List a list's columns — READ THIS before filtering or writing rows

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = ListColumnsArgs(site_id=site_id, list_id=list_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("sharepoint.list_columns", _args)
    return [ListColumn(**item) for item in data]


def list_list_items(
    site_id: str,
    list_id: str,
    filter: str | None = None,
    order_by: str | None = None,
    columns: list[str] | None = None,
    limit: int | None = 50,
    page_token: str | None = None,
    connection_id: str | None = None,
) -> ListItemPage:
    """List the rows of a list, optionally filtered and sorted

    filter: OData filter on INTERNAL column names, prefixed with `fields/`: `fields/Status eq 'Open'`, `fields/Amount gt 1000`, `startswith(fields/Title,'ACME')`.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = ListListItemsArgs(site_id=site_id, list_id=list_id, filter=filter, order_by=order_by, columns=columns, limit=limit, page_token=page_token).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("sharepoint.list_list_items", _args)
    return ListItemPage(items=[ListItem(**item) for item in data.get("items", [])], page_token=data.get("page_token"))


def get_list_item(
    site_id: str,
    list_id: str,
    item_id: str,
    connection_id: str | None = None,
) -> ListItem:
    """Fetch one list row with all its column values

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = GetListItemArgs(site_id=site_id, list_id=list_id, item_id=item_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("sharepoint.get_list_item", _args)
    return ListItem(**data)


def list_pages(
    site_id: str,
    limit: int | None = 50,
    connection_id: str | None = None,
) -> list[SitePage]:
    """List a site's pages (intranet news, wiki, home page)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = ListPagesArgs(site_id=site_id, limit=limit).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("sharepoint.list_pages", _args)
    return [SitePage(**item) for item in data]


def get_page(
    site_id: str,
    page_id: str,
    connection_id: str | None = None,
) -> SitePage:
    """Read a site page's text content

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    _args = GetPageArgs(site_id=site_id, page_id=page_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    data = _call_read("sharepoint.get_page", _args)
    return SitePage(**data)


# ── Write actions (use `.op(...)` inside run_plan([...])) ───

def _create_folder_op(
    drive_id: str,
    name: str,
    parent_folder_id: str | None = "root",
    conflict_behavior: Literal["rename", "replace", "fail"] | None = "rename",
    connection_id: str | None = None,
) -> Operation:
    """Build a create_folder Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = CreateFolderArgs(drive_id=drive_id, name=name, parent_folder_id=parent_folder_id, conflict_behavior=conflict_behavior).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="sharepoint.create_folder", args=_args)

def create_folder(
    drive_id: str,
    name: str,
    parent_folder_id: str | None = "root",
    conflict_behavior: Literal["rename", "replace", "fail"] | None = "rename",
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Create a folder inside a library

    (WRITE — build it with `create_folder.op(...)` and submit
    it with `run_plan([...])`. Calling this directly raises.)

    parent_folder_id: `root` for the top level of the library

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    raise FretikActionError(
        "create_folder is a WRITE action and does not execute on its own. "
        "Build it with .op(...) and submit it with run_plan([...]): "
        "run_plan([sharepoint.create_folder.op(...)])"
    )

create_folder.op = _create_folder_op


def _create_upload_session_op(
    drive_id: str,
    file_name: str,
    parent_folder_id: str | None = "root",
    conflict_behavior: Literal["rename", "replace", "fail"] | None = "rename",
    connection_id: str | None = None,
) -> Operation:
    """Build a create_upload_session Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = CreateUploadSessionArgs(drive_id=drive_id, file_name=file_name, parent_folder_id=parent_folder_id, conflict_behavior=conflict_behavior).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="sharepoint.create_upload_session", args=_args)

def create_upload_session(
    drive_id: str,
    file_name: str,
    parent_folder_id: str | None = "root",
    conflict_behavior: Literal["rename", "replace", "fail"] | None = "rename",
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Open an upload slot for a file — send the bytes to the returned URL

    (WRITE — build it with `create_upload_session.op(...)` and submit
    it with `run_plan([...])`. Calling this directly raises.)

    file_name: File name WITH its extension, e.g. `Q1-report.pdf`

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    raise FretikActionError(
        "create_upload_session is a WRITE action and does not execute on its own. "
        "Build it with .op(...) and submit it with run_plan([...]): "
        "run_plan([sharepoint.create_upload_session.op(...)])"
    )

create_upload_session.op = _create_upload_session_op


def _update_item_op(
    drive_id: str,
    item_id: str,
    new_name: str | None = None,
    new_parent_folder_id: str | None = None,
    connection_id: str | None = None,
) -> Operation:
    """Build a update_item Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = UpdateItemArgs(drive_id=drive_id, item_id=item_id, new_name=new_name, new_parent_folder_id=new_parent_folder_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="sharepoint.update_item", args=_args)

def update_item(
    drive_id: str,
    item_id: str,
    new_name: str | None = None,
    new_parent_folder_id: str | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Rename a file or folder and/or move it to another folder

    (WRITE — build it with `update_item.op(...)` and submit
    it with `run_plan([...])`. Calling this directly raises.)

    new_parent_folder_id: Move target, in the SAME library

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    raise FretikActionError(
        "update_item is a WRITE action and does not execute on its own. "
        "Build it with .op(...) and submit it with run_plan([...]): "
        "run_plan([sharepoint.update_item.op(...)])"
    )

update_item.op = _update_item_op


def _delete_item_op(
    drive_id: str,
    item_id: str,
    connection_id: str | None = None,
) -> Operation:
    """Build a delete_item Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = DeleteItemArgs(drive_id=drive_id, item_id=item_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="sharepoint.delete_item", args=_args)

def delete_item(
    drive_id: str,
    item_id: str,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Delete a file or folder (goes to the site's recycle bin)

    (WRITE — build it with `delete_item.op(...)` and submit
    it with `run_plan([...])`. Calling this directly raises.)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    raise FretikActionError(
        "delete_item is a WRITE action and does not execute on its own. "
        "Build it with .op(...) and submit it with run_plan([...]): "
        "run_plan([sharepoint.delete_item.op(...)])"
    )

delete_item.op = _delete_item_op


def _copy_item_op(
    drive_id: str,
    item_id: str,
    target_folder_id: str,
    target_drive_id: str | None = None,
    new_name: str | None = None,
    connection_id: str | None = None,
) -> Operation:
    """Build a copy_item Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = CopyItemArgs(drive_id=drive_id, item_id=item_id, target_folder_id=target_folder_id, target_drive_id=target_drive_id, new_name=new_name).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="sharepoint.copy_item", args=_args)

def copy_item(
    drive_id: str,
    item_id: str,
    target_folder_id: str,
    target_drive_id: str | None = None,
    new_name: str | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Copy a file or folder into another folder, possibly another library

    (WRITE — build it with `copy_item.op(...)` and submit
    it with `run_plan([...])`. Calling this directly raises.)

    target_folder_id: Destination folder id

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    raise FretikActionError(
        "copy_item is a WRITE action and does not execute on its own. "
        "Build it with .op(...) and submit it with run_plan([...]): "
        "run_plan([sharepoint.copy_item.op(...)])"
    )

copy_item.op = _copy_item_op


def _restore_version_op(
    drive_id: str,
    item_id: str,
    version_id: str,
    connection_id: str | None = None,
) -> Operation:
    """Build a restore_version Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = RestoreVersionArgs(drive_id=drive_id, item_id=item_id, version_id=version_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="sharepoint.restore_version", args=_args)

def restore_version(
    drive_id: str,
    item_id: str,
    version_id: str,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Restore a previous version of a file as the current one

    (WRITE — build it with `restore_version.op(...)` and submit
    it with `run_plan([...])`. Calling this directly raises.)

    version_id: Version label from list_versions, e.g. `3.0`

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    raise FretikActionError(
        "restore_version is a WRITE action and does not execute on its own. "
        "Build it with .op(...) and submit it with run_plan([...]): "
        "run_plan([sharepoint.restore_version.op(...)])"
    )

restore_version.op = _restore_version_op


def _create_share_link_op(
    drive_id: str,
    item_id: str,
    link_type: Literal["view", "edit", "embed"] | None = "view",
    scope: Literal["organization", "anonymous", "users"] | None = "organization",
    expiration_date: str | None = None,
    connection_id: str | None = None,
) -> Operation:
    """Build a create_share_link Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = CreateShareLinkArgs(drive_id=drive_id, item_id=item_id, link_type=link_type, scope=scope, expiration_date=expiration_date).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="sharepoint.create_share_link", args=_args)

def create_share_link(
    drive_id: str,
    item_id: str,
    link_type: Literal["view", "edit", "embed"] | None = "view",
    scope: Literal["organization", "anonymous", "users"] | None = "organization",
    expiration_date: str | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Create a sharing link to a file or folder

    (WRITE — build it with `create_share_link.op(...)` and submit
    it with `run_plan([...])`. Calling this directly raises.)

    scope: `organization` = anyone signed into the tenant. `anonymous` = anyone with the link, and many tenants block it outright — only use it when the user asked for a public link.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    raise FretikActionError(
        "create_share_link is a WRITE action and does not execute on its own. "
        "Build it with .op(...) and submit it with run_plan([...]): "
        "run_plan([sharepoint.create_share_link.op(...)])"
    )

create_share_link.op = _create_share_link_op


def _grant_item_access_op(
    drive_id: str,
    item_id: str,
    emails: list[str],
    role: Literal["read", "write"] | None = "read",
    message: str | None = None,
    send_invitation: bool | None = True,
    require_sign_in: bool | None = True,
    expiration_date: str | None = None,
    connection_id: str | None = None,
) -> Operation:
    """Build a grant_item_access Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = GrantItemAccessArgs(drive_id=drive_id, item_id=item_id, emails=emails, role=role, message=message, send_invitation=send_invitation, require_sign_in=require_sign_in, expiration_date=expiration_date).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="sharepoint.grant_item_access", args=_args)

def grant_item_access(
    drive_id: str,
    item_id: str,
    emails: list[str],
    role: Literal["read", "write"] | None = "read",
    message: str | None = None,
    send_invitation: bool | None = True,
    require_sign_in: bool | None = True,
    expiration_date: str | None = None,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Give named people access to a file or folder

    (WRITE — build it with `grant_item_access.op(...)` and submit
    it with `run_plan([...])`. Calling this directly raises.)

    message: Sent to the recipients when `send_invitation` is on. Keep it short and factual — it is an email from the connected account.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    raise FretikActionError(
        "grant_item_access is a WRITE action and does not execute on its own. "
        "Build it with .op(...) and submit it with run_plan([...]): "
        "run_plan([sharepoint.grant_item_access.op(...)])"
    )

grant_item_access.op = _grant_item_access_op


def _revoke_item_access_op(
    drive_id: str,
    item_id: str,
    permission_id: str,
    connection_id: str | None = None,
) -> Operation:
    """Build a revoke_item_access Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = RevokeItemAccessArgs(drive_id=drive_id, item_id=item_id, permission_id=permission_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="sharepoint.revoke_item_access", args=_args)

def revoke_item_access(
    drive_id: str,
    item_id: str,
    permission_id: str,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Revoke one permission or sharing link on a file or folder

    (WRITE — build it with `revoke_item_access.op(...)` and submit
    it with `run_plan([...])`. Calling this directly raises.)

    permission_id: From list_permissions. An `inherited` permission cannot be revoked here.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    raise FretikActionError(
        "revoke_item_access is a WRITE action and does not execute on its own. "
        "Build it with .op(...) and submit it with run_plan([...]): "
        "run_plan([sharepoint.revoke_item_access.op(...)])"
    )

revoke_item_access.op = _revoke_item_access_op


def _create_list_item_op(
    site_id: str,
    list_id: str,
    fields: dict[str, Any],
    connection_id: str | None = None,
) -> Operation:
    """Build a create_list_item Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = CreateListItemArgs(site_id=site_id, list_id=list_id, fields=fields).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="sharepoint.create_list_item", args=_args)

def create_list_item(
    site_id: str,
    list_id: str,
    fields: dict[str, Any],
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Add a row to a list

    (WRITE — build it with `create_list_item.op(...)` and submit
    it with `run_plan([...])`. Calling this directly raises.)

    fields: Column values keyed by INTERNAL name from list_columns, e.g. `{"Title": "ACME", "Status": "Open", "Amount": 1200}`. Never send a read-only column.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    raise FretikActionError(
        "create_list_item is a WRITE action and does not execute on its own. "
        "Build it with .op(...) and submit it with run_plan([...]): "
        "run_plan([sharepoint.create_list_item.op(...)])"
    )

create_list_item.op = _create_list_item_op


def _update_list_item_op(
    site_id: str,
    list_id: str,
    item_id: str,
    fields: dict[str, Any],
    connection_id: str | None = None,
) -> Operation:
    """Build a update_list_item Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = UpdateListItemArgs(site_id=site_id, list_id=list_id, item_id=item_id, fields=fields).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="sharepoint.update_list_item", args=_args)

def update_list_item(
    site_id: str,
    list_id: str,
    item_id: str,
    fields: dict[str, Any],
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Update column values on an existing list row

    (WRITE — build it with `update_list_item.op(...)` and submit
    it with `run_plan([...])`. Calling this directly raises.)

    fields: Only the columns to change, keyed by INTERNAL name. Columns left out keep their value.

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    raise FretikActionError(
        "update_list_item is a WRITE action and does not execute on its own. "
        "Build it with .op(...) and submit it with run_plan([...]): "
        "run_plan([sharepoint.update_list_item.op(...)])"
    )

update_list_item.op = _update_list_item_op


def _delete_list_item_op(
    site_id: str,
    list_id: str,
    item_id: str,
    connection_id: str | None = None,
) -> Operation:
    """Build a delete_list_item Operation (does NOT execute).
    Use inside run_plan([...])."""
    _args = DeleteListItemArgs(site_id=site_id, list_id=list_id, item_id=item_id).model_dump(exclude_none=True)
    if connection_id is not None:
        _args["connection_id"] = connection_id
    return Operation(action="sharepoint.delete_list_item", args=_args)

def delete_list_item(
    site_id: str,
    list_id: str,
    item_id: str,
    connection_id: str | None = None,
) -> dict[str, Any]:
    """Delete a row from a list

    (WRITE — build it with `delete_list_item.op(...)` and submit
    it with `run_plan([...])`. Calling this directly raises.)

    connection_id: pick a specific connection when several exist for this
    provider. Pass the ID surfaced in the agent context.
    """
    raise FretikActionError(
        "delete_list_item is a WRITE action and does not execute on its own. "
        "Build it with .op(...) and submit it with run_plan([...]): "
        "run_plan([sharepoint.delete_list_item.op(...)])"
    )

delete_list_item.op = _delete_list_item_op
