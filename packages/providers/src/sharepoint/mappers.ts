import {
  arr,
  asNumber,
  asString,
  bool,
  isRecord,
  num,
  path,
  prop,
  str,
  strArray,
} from "@fretik/shared/external-apps/json-access";
import type {
  ProviderMappers,
  RequestMapper,
  ResponseMapper,
} from "@fretik/shared/external-apps/provider-types";

/**
 * Microsoft Graph request/response transformers for the SharePoint provider.
 *
 * Three things this file exists for:
 *
 *  1. **Path addressing.** Graph addresses a drive item either by id
 *     (`/drives/{d}/items/{id}`) or by path (`/drives/{d}/root:/A/B/c.pdf:`).
 *     The generic executor URL-encodes every path param, which turns the
 *     `/` of a folder path into `%2F` and breaks the second form — so every
 *     action that accepts a path builds its own endpoint here.
 *  2. **OData plumbing.** `$top`, `$expand=fields`, `$filter` on
 *     `fields/<InternalName>`, the `$skiptoken` cursor, and the `Prefer`
 *     header a filtered list read needs past 5 000 rows.
 *  3. **Shape.** Graph answers deep camelCase payloads with open maps
 *     (`fields`, `canvasLayout`) and `@`-prefixed specials
 *     (`@odata.nextLink`, `@microsoft.graph.downloadUrl`); the response
 *     mappers flatten them into the manifest `types`.
 */

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Fields every driveItem read needs. `sharepointIds` is the one that is not
 * obvious: it carries the item's identity AS A LIST ROW (`listId`,
 * `listItemId`), which is the only way to reach a document library's custom
 * columns — the "Contract type", "Client", "Status" metadata a team actually
 * files documents by. Without it the agent can see the file and not a single
 * thing SharePoint knows about it.
 */
const DRIVE_ITEM_SELECT =
  "id,name,size,webUrl,folder,file,createdDateTime,lastModifiedDateTime,lastModifiedBy,parentReference,sharepointIds";

/**
 * Graph pages collections with an absolute `@odata.nextLink`. The cursor
 * inside it is `$skiptoken`; re-sending it on the same endpoint resumes the
 * listing, which is cheaper and far less brittle than replaying the whole
 * URL through the proxy.
 */
const nextSkipToken = (raw: unknown): string | undefined => {
  const next = asString(prop(raw, "@odata.nextLink"));
  if (next === undefined) return undefined;
  try {
    const token = new URL(next).searchParams.get("$skiptoken");
    return token === null ? undefined : token;
  } catch {
    return undefined;
  }
};

/** `{ items, page_token? }` — the shape a `{ page: X }` return expects. */
const pageOf =
  (normalize: (raw: unknown) => Record<string, unknown>): ResponseMapper =>
  (raw) => {
    const items = arr(path(raw, "value")).map(normalize);
    const token = nextSkipToken(raw);
    return token !== undefined ? { items, page_token: token } : { items };
  };

const listOf =
  (normalize: (raw: unknown) => Record<string, unknown>): ResponseMapper =>
  (raw) =>
    arr(path(raw, "value")).map(normalize);

/**
 * Encode a library-relative path for Graph's `root:/A/B/c.pdf:` form:
 * every segment is percent-encoded, the separators stay literal. Leading
 * and trailing slashes are tolerated — agents write both.
 */
const encodePathSegments = (value: string): string =>
  value
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment) => encodeURIComponent(segment))
    .join("/");

/**
 * Address one drive item: `/items/{id}` when an id is known, the path form
 * `/root:/A/B` otherwise, and the library root when neither is given.
 *
 * `pathAddressed` travels with the address because the two forms diverge on
 * how a sub-resource attaches: `/items/{id}/children` but
 * `/root:/A/B:/children` — the colon CLOSES the path segment and is not
 * part of the address itself.
 */
interface ItemAddress {
  url: string;
  pathAddressed: boolean;
}

const itemAddress = (
  driveId: string,
  itemId: string | undefined,
  itemPath: string | undefined,
): ItemAddress => {
  const drive = `/v1.0/drives/${encodeURIComponent(driveId)}`;
  if (itemId !== undefined && itemId !== "") {
    return {
      url: `${drive}/items/${encodeURIComponent(itemId)}`,
      pathAddressed: false,
    };
  }
  const encoded = itemPath !== undefined ? encodePathSegments(itemPath) : "";
  return encoded === ""
    ? { url: `${drive}/root`, pathAddressed: false }
    : { url: `${drive}/root:/${encoded}`, pathAddressed: true };
};

/** `…/items/{id}` + `/children` → `…/items/{id}/children`; the path form
 *  closes with its colon first → `…/root:/A/B:/children`. */
const subResource = (address: ItemAddress, suffix: string): string =>
  `${address.url}${address.pathAddressed ? ":" : ""}${suffix}`;

/** Nango proxy query values are strings — `$top` and friends included. */
const topOf = (args: Record<string, unknown>): Record<string, string> => {
  const limit = asNumber(args.limit);
  return limit === undefined ? {} : { $top: limit.toString() };
};

/**
 * Base64url without padding, `u!`-prefixed — Graph's encoding for a sharing
 * URL passed to `/shares/{token}`.
 */
const shareToken = (url: string): string => {
  const base64 = Buffer.from(url, "utf8").toString("base64");
  return `u!${base64.replace(/=+$/, "").replace(/\//g, "_").replace(/\+/g, "-")}`;
};

/** `2026-03-31` → the end-of-day instant Graph expects for an expiry. */
const endOfDay = (value: unknown): string | undefined => {
  const day = asString(value);
  return day === undefined || day === "" ? undefined : `${day}T23:59:59Z`;
};

// ── Request mappers — reads ────────────────────────────────────────────

/** Any read whose only knob is `limit`. */
const listWithTop: RequestMapper = (args) => ({ query: topOf(args) });

const searchSites: RequestMapper = (args) => ({
  query: { search: str(args.query), ...topOf(args) },
});

/**
 * `https://contoso.sharepoint.com/sites/Legal/Shared%20Documents/x.pdf`
 * → `GET /v1.0/sites/contoso.sharepoint.com:/sites/Legal`.
 *
 * Graph resolves a site from its SERVER-RELATIVE path, so everything past
 * the site segment has to go: a user pastes the URL of a document far more
 * often than the URL of the site itself. Two site shapes exist —
 * `/sites/<name>` and `/teams/<name>` — plus the tenant root, which has no
 * prefix at all.
 */
const getSiteByUrl: RequestMapper = (args) => {
  const raw = str(args.site_url).trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      `site_url must be a full URL (got "${raw}"). Example: https://contoso.sharepoint.com/sites/Legal`,
    );
  }
  const segments = url.pathname.split("/").filter((s) => s !== "");
  const prefix = segments[0]?.toLowerCase();
  const sitePath =
    (prefix === "sites" || prefix === "teams") && segments.length >= 2
      ? `/${segments[0] ?? ""}/${segments[1] ?? ""}`
      : "";
  // The root site is addressed by hostname alone — a trailing `:/` 400s.
  return {
    endpoint:
      sitePath === ""
        ? `/v1.0/sites/${url.hostname}`
        : `/v1.0/sites/${url.hostname}:${sitePath}`,
  };
};

const listFolder: RequestMapper = (args) => {
  const address = itemAddress(
    str(args.drive_id),
    asString(args.folder_id),
    asString(args.folder_path),
  );
  const query: Record<string, string> = {
    ...topOf(args),
    $select: DRIVE_ITEM_SELECT,
  };
  const token = asString(args.page_token);
  if (token !== undefined && token !== "") query.$skiptoken = token;
  return { endpoint: subResource(address, "/children"), query };
};

const getItem: RequestMapper = (args) => ({
  endpoint: itemAddress(
    str(args.drive_id),
    asString(args.item_id),
    asString(args.item_path),
  ).url,
  query: { $select: DRIVE_ITEM_SELECT },
});

const searchLibrary: RequestMapper = (args) => {
  // `search(q='…')` is an OData FUNCTION: the term sits inside the path,
  // single-quoted, and a literal quote is escaped by doubling it. The
  // parentheses `encodeURIComponent` leaves alone would close the function
  // call early, so they are escaped by hand.
  const term = str(args.query).replace(/'/g, "''");
  const encoded = encodeURIComponent(term)
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29");
  return {
    endpoint: `/v1.0/drives/${encodeURIComponent(str(args.drive_id))}/root/search(q='${encoded}')`,
    query: { ...topOf(args), $select: DRIVE_ITEM_SELECT },
  };
};

const search: RequestMapper = (args) => {
  const types = strArray(args.entity_types);
  return {
    body: {
      requests: [
        {
          entityTypes: types.length > 0 ? types : ["driveItem"],
          query: { queryString: str(args.query) },
          from: num(args.offset, 0),
          size: num(args.limit, 25),
        },
      ],
    },
  };
};

const downloadFile: RequestMapper = () => ({
  // `@microsoft.graph.downloadUrl` is a computed property — it only comes
  // back when explicitly selected.
  query: {
    $select: "id,name,size,file,@microsoft.graph.downloadUrl",
  },
});

const resolveShareLink: RequestMapper = (args) => ({
  endpoint: `/v1.0/shares/${shareToken(str(args.share_url))}/driveItem`,
  query: { $select: DRIVE_ITEM_SELECT },
});

/** `$expand=fields` — without it a list row comes back with no values. */
const expandFields: RequestMapper = () => ({
  query: { $expand: "fields" },
});

const listListItems: RequestMapper = (args) => {
  const columns = strArray(args.columns);
  const query: Record<string, string> = {
    $expand:
      columns.length > 0 ? `fields(select=${columns.join(",")})` : "fields",
    ...topOf(args),
  };
  const filter = asString(args.filter);
  if (filter !== undefined && filter !== "") query.$filter = filter;
  const orderBy = asString(args.order_by);
  if (orderBy !== undefined && orderBy !== "") query.$orderby = orderBy;
  const token = asString(args.page_token);
  if (token !== undefined && token !== "") query.$skiptoken = token;

  // Past 5 000 rows SharePoint refuses to filter or sort on a column it has
  // not indexed — HTTP 400, "the request is unprocessable because it uses
  // too many resources". This header is the documented opt-in: the query is
  // attempted anyway and may fail on a big list, which beats never being
  // able to filter one at all.
  const needsNonIndexedOptIn =
    (filter !== undefined && filter !== "") ||
    (orderBy !== undefined && orderBy !== "");
  return needsNonIndexedOptIn
    ? {
        query,
        headers: { Prefer: "HonorNonIndexedQueriesWarningMayFailRandomly" },
      }
    : { query };
};

const getPage: RequestMapper = () => ({
  query: { $expand: "canvasLayout" },
});

// ── Request mappers — writes ───────────────────────────────────────────

const createFolder: RequestMapper = (args) => ({
  body: {
    name: str(args.name),
    folder: {},
    "@microsoft.graph.conflictBehavior": str(args.conflict_behavior, "rename"),
  },
});

const createUploadSession: RequestMapper = (args) => ({
  body: {
    item: {
      "@microsoft.graph.conflictBehavior": str(
        args.conflict_behavior,
        "rename",
      ),
    },
  },
});

const updateItem: RequestMapper = (args) => {
  const body: Record<string, unknown> = {};
  const newName = asString(args.new_name);
  if (newName !== undefined && newName !== "") body.name = newName;
  const newParent = asString(args.new_parent_folder_id);
  if (newParent !== undefined && newParent !== "") {
    body.parentReference = { id: newParent };
  }
  return { body };
};

const copyItem: RequestMapper = (args) => {
  const parentReference: Record<string, unknown> = {
    id: str(args.target_folder_id),
  };
  const targetDrive = asString(args.target_drive_id);
  if (targetDrive !== undefined && targetDrive !== "") {
    parentReference.driveId = targetDrive;
  }
  const body: Record<string, unknown> = { parentReference };
  const newName = asString(args.new_name);
  if (newName !== undefined && newName !== "") body.name = newName;
  return { body };
};

const createShareLink: RequestMapper = (args) => {
  const body: Record<string, unknown> = {
    type: str(args.link_type, "view"),
    scope: str(args.scope, "organization"),
  };
  const expires = endOfDay(args.expiration_date);
  if (expires !== undefined) body.expirationDateTime = expires;
  return { body };
};

const grantItemAccess: RequestMapper = (args) => {
  const body: Record<string, unknown> = {
    recipients: strArray(args.emails).map((email) => ({ email })),
    roles: [str(args.role, "read")],
    requireSignIn: bool(args.require_sign_in, true),
    sendInvitation: bool(args.send_invitation, true),
  };
  const message = asString(args.message);
  if (message !== undefined && message !== "") body.message = message;
  const expires = endOfDay(args.expiration_date);
  if (expires !== undefined) body.expirationDateTime = expires;
  return { body };
};

const createListItem: RequestMapper = (args) => ({
  body: { fields: isRecord(args.fields) ? args.fields : {} },
});

/** PATCH on `…/items/{id}/fields` takes the field map as the whole body. */
const updateListItem: RequestMapper = (args) => ({
  body: isRecord(args.fields) ? args.fields : {},
});

// ── Response mappers ───────────────────────────────────────────────────

/** Graph identity sets — `{ user: { displayName, email } }` and siblings. */
const identityName = (raw: unknown): string | undefined =>
  asString(path(raw, "user", "displayName")) ??
  asString(path(raw, "user", "email")) ??
  asString(path(raw, "application", "displayName"));

const normalizeSite = (raw: unknown): Record<string, unknown> => {
  const out: Record<string, unknown> = {
    id: str(path(raw, "id")),
    name: str(path(raw, "name")),
    display_name: str(path(raw, "displayName"), str(path(raw, "name"))),
    web_url: str(path(raw, "webUrl")),
  };
  const description = asString(path(raw, "description"));
  if (description !== undefined && description !== "") {
    out.description = description;
  }
  const createdAt = asString(path(raw, "createdDateTime"));
  if (createdAt !== undefined) out.created_at = createdAt;
  const modifiedAt = asString(path(raw, "lastModifiedDateTime"));
  if (modifiedAt !== undefined) out.last_modified_at = modifiedAt;
  return out;
};

const normalizeLibrary = (raw: unknown): Record<string, unknown> => {
  const out: Record<string, unknown> = {
    id: str(path(raw, "id")),
    name: str(path(raw, "name")),
    web_url: str(path(raw, "webUrl")),
    drive_type: str(path(raw, "driveType")),
  };
  const description = asString(path(raw, "description"));
  if (description !== undefined && description !== "") {
    out.description = description;
  }
  return out;
};

const normalizeDriveItem = (raw: unknown): Record<string, unknown> => {
  const folder = prop(raw, "folder");
  const out: Record<string, unknown> = {
    id: str(path(raw, "id")),
    name: str(path(raw, "name")),
    is_folder: isRecord(folder),
    size_bytes: num(path(raw, "size")),
    web_url: str(path(raw, "webUrl")),
    created_at: str(path(raw, "createdDateTime")),
    last_modified_at: str(path(raw, "lastModifiedDateTime")),
  };
  const mimeType = asString(path(raw, "file", "mimeType"));
  if (mimeType !== undefined) out.mime_type = mimeType;
  const childCount = asNumber(path(raw, "folder", "childCount"));
  if (childCount !== undefined) out.child_count = childCount;
  const parentId = asString(path(raw, "parentReference", "id"));
  if (parentId !== undefined) out.parent_folder_id = parentId;
  const parentPath = asString(path(raw, "parentReference", "path"));
  if (parentPath !== undefined) out.parent_path = parentPath;
  const driveId = asString(path(raw, "parentReference", "driveId"));
  if (driveId !== undefined) out.drive_id = driveId;
  // `sharepointIds` is the same item seen as a list row — the handle on the
  // library's custom columns. `listId` comes with it, so the pair is enough
  // to call the list actions with the site id the agent already holds.
  const listItemId =
    asString(path(raw, "sharepointIds", "listItemId")) ??
    asString(path(raw, "listItem", "id"));
  if (listItemId !== undefined) out.list_item_id = listItemId;
  const listId = asString(path(raw, "sharepointIds", "listId"));
  if (listId !== undefined) out.list_id = listId;
  const modifiedBy = identityName(path(raw, "lastModifiedBy"));
  if (modifiedBy !== undefined) out.last_modified_by = modifiedBy;
  return out;
};

/**
 * `@microsoft.graph.downloadUrl` is a short-lived pre-authenticated URL.
 * Surfacing it as `download_url` is what makes the sandbox runtime stream
 * the bytes to `sandbox_path` before the agent ever sees them — the same
 * contract Teams attachments use.
 */
const fileDownload: ResponseMapper = (raw) => {
  const out: Record<string, unknown> = {
    id: str(path(raw, "id")),
    name: str(path(raw, "name")),
    content_type: str(path(raw, "file", "mimeType")),
    size_bytes: num(path(raw, "size")),
  };
  const url = asString(prop(raw, "@microsoft.graph.downloadUrl"));
  if (url !== undefined) out.download_url = url;
  return out;
};

const normalizeVersion = (raw: unknown): Record<string, unknown> => {
  const out: Record<string, unknown> = {
    id: str(path(raw, "id")),
    last_modified_at: str(path(raw, "lastModifiedDateTime")),
  };
  const size = asNumber(path(raw, "size"));
  if (size !== undefined) out.size_bytes = size;
  const modifiedBy = identityName(path(raw, "lastModifiedBy"));
  if (modifiedBy !== undefined) out.last_modified_by = modifiedBy;
  return out;
};

/**
 * A Graph permission is one of three things wearing the same shape: a
 * sharing link (`link`), a direct grant (`grantedToV2`) or an inherited one
 * (`inheritedFrom`). Flatten all three so the agent reads one model.
 */
const normalizePermission = (raw: unknown): Record<string, unknown> => {
  const grantedTo: string[] = [];
  const single = identityName(prop(raw, "grantedToV2"));
  if (single !== undefined) grantedTo.push(single);
  for (const entry of arr(prop(raw, "grantedToIdentitiesV2"))) {
    const name = identityName(entry);
    if (name !== undefined) grantedTo.push(name);
  }
  const out: Record<string, unknown> = {
    id: str(path(raw, "id")),
    roles: strArray(path(raw, "roles")),
    granted_to: grantedTo,
    inherited: isRecord(prop(raw, "inheritedFrom")),
  };
  const linkType = asString(path(raw, "link", "type"));
  if (linkType !== undefined) out.link_type = linkType;
  const linkScope = asString(path(raw, "link", "scope"));
  if (linkScope !== undefined) out.link_scope = linkScope;
  const linkUrl = asString(path(raw, "link", "webUrl"));
  if (linkUrl !== undefined) out.link_url = linkUrl;
  const expires = asString(path(raw, "expirationDateTime"));
  if (expires !== undefined) out.expires_at = expires;
  return out;
};

const shareLink: ResponseMapper = (raw) => {
  const out: Record<string, unknown> = {
    id: str(path(raw, "id")),
    link_url: str(path(raw, "link", "webUrl")),
    link_type: str(path(raw, "link", "type")),
    link_scope: str(path(raw, "link", "scope")),
  };
  const expires = asString(path(raw, "expirationDateTime"));
  if (expires !== undefined) out.expires_at = expires;
  return out;
};

const normalizeList = (raw: unknown): Record<string, unknown> => {
  const out: Record<string, unknown> = {
    id: str(path(raw, "id")),
    name: str(path(raw, "name")),
    display_name: str(path(raw, "displayName"), str(path(raw, "name"))),
    web_url: str(path(raw, "webUrl")),
  };
  const description = asString(path(raw, "description"));
  if (description !== undefined && description !== "") {
    out.description = description;
  }
  const template = asString(path(raw, "list", "template"));
  if (template !== undefined) out.template = template;
  const createdAt = asString(path(raw, "createdDateTime"));
  if (createdAt !== undefined) out.created_at = createdAt;
  return out;
};

/**
 * A columnDefinition carries its type as the PRESENCE of a facet
 * (`text: {}`, `number: {}`, `dateTime: {}`, …) rather than as a value, so
 * the type is read by looking for which facet exists.
 */
const COLUMN_TYPE_FACETS = [
  "text",
  "number",
  "boolean",
  "dateTime",
  "choice",
  "lookup",
  "personOrGroup",
  "currency",
  "hyperlinkOrPicture",
  "calculated",
  "contentApprovalStatus",
  "geolocation",
  "term",
  "thumbnail",
] as const;

const normalizeColumn = (raw: unknown): Record<string, unknown> => {
  const type =
    COLUMN_TYPE_FACETS.find((facet) => isRecord(prop(raw, facet))) ?? "unknown";
  const out: Record<string, unknown> = {
    name: str(path(raw, "name")),
    display_name: str(path(raw, "displayName"), str(path(raw, "name"))),
    type,
    required: bool(path(raw, "required")),
    read_only: bool(path(raw, "readOnly")),
  };
  const choices = strArray(path(raw, "choice", "choices"));
  if (choices.length > 0) out.choices = choices;
  const description = asString(path(raw, "description"));
  if (description !== undefined && description !== "") {
    out.description = description;
  }
  return out;
};

/**
 * Drop the bookkeeping Graph mixes into `fields`: `@odata.etag`, the
 * `_ComplianceFlags`-style internals and the id echoes the agent already
 * has. What is left is the row as a person sees it in SharePoint.
 */
const NOISE_FIELDS = new Set([
  "@odata.etag",
  "id",
  "ContentType",
  "Attachments",
  "Edit",
  "LinkTitleNoMenu",
  "LinkTitle",
  "ItemChildCount",
  "FolderChildCount",
  "_ComplianceFlags",
  "_ComplianceTag",
  "_ComplianceTagWrittenTime",
  "_ComplianceTagUserId",
  "_UIVersionString",
  "AppAuthorLookupId",
  "AppEditorLookupId",
]);

const cleanFields = (raw: unknown): Record<string, unknown> => {
  if (!isRecord(raw)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (NOISE_FIELDS.has(key)) continue;
    if (value === null) continue;
    out[key] = value;
  }
  return out;
};

const normalizeListItem = (raw: unknown): Record<string, unknown> => {
  const out: Record<string, unknown> = {
    id: str(path(raw, "id")),
    fields: cleanFields(prop(raw, "fields")),
  };
  const webUrl = asString(path(raw, "webUrl"));
  if (webUrl !== undefined) out.web_url = webUrl;
  const createdAt = asString(path(raw, "createdDateTime"));
  if (createdAt !== undefined) out.created_at = createdAt;
  const modifiedAt = asString(path(raw, "lastModifiedDateTime"));
  if (modifiedAt !== undefined) out.last_modified_at = modifiedAt;
  const createdBy = identityName(path(raw, "createdBy"));
  if (createdBy !== undefined) out.created_by = createdBy;
  const modifiedBy = identityName(path(raw, "lastModifiedBy"));
  if (modifiedBy !== undefined) out.last_modified_by = modifiedBy;
  return out;
};

/**
 * `PATCH …/items/{id}/fields` answers the field map alone — no envelope, no
 * id. The row's identity comes back from the args the dispatcher validated,
 * so the agent still gets a whole `ListItem` and not a headless dict.
 */
const listItemFields: ResponseMapper = (raw, args) => ({
  id: str(args?.item_id),
  fields: cleanFields(raw),
});

const normalizePage = (raw: unknown): Record<string, unknown> => {
  const out: Record<string, unknown> = {
    id: str(path(raw, "id")),
    name: str(path(raw, "name")),
    title: str(path(raw, "title"), str(path(raw, "name"))),
    web_url: str(path(raw, "webUrl")),
  };
  const description = asString(path(raw, "description"));
  if (description !== undefined && description !== "") {
    out.description = description;
  }
  const layout = asString(path(raw, "pageLayout"));
  if (layout !== undefined) out.page_layout = layout;
  // A page has no "published on" field — `publishingState.level` says
  // whether the current version is live, and the last edit is when it went
  // live. A checked-out draft leaves `published_at` unset, which is the
  // honest answer: nobody outside the author has seen it.
  const level = asString(path(raw, "publishingState", "level"));
  const lastModified = asString(path(raw, "lastModifiedDateTime"));
  if (level === "published" && lastModified !== undefined) {
    out.published_at = lastModified;
  }
  return out;
};

/**
 * A page's readable content lives in the `innerHtml` of its TEXT web parts,
 * buried under `canvasLayout.horizontalSections[].columns[].webparts[]`
 * (plus a `verticalSection`). Walk both in reading order and concatenate —
 * every other web part kind (image, news feed, embed) has no prose to give.
 */
const pageContentHtml = (raw: unknown): string => {
  const chunks: string[] = [];
  const collect = (webparts: unknown): void => {
    for (const part of arr(webparts)) {
      const html = asString(prop(part, "innerHtml"));
      if (html !== undefined && html !== "") chunks.push(html);
    }
  };
  for (const section of arr(path(raw, "canvasLayout", "horizontalSections"))) {
    for (const column of arr(prop(section, "columns"))) {
      collect(prop(column, "webparts"));
    }
  }
  collect(path(raw, "canvasLayout", "verticalSection", "webparts"));
  return chunks.join("\n");
};

const page: ResponseMapper = (raw) => {
  const out = normalizePage(raw);
  const html = pageContentHtml(raw);
  if (html !== "") out.content_html = html;
  return out;
};

/**
 * `POST /search/query` nests its answer three levels deep:
 * `value[0].hitsContainers[0].hits[]`, each hit wrapping the real object in
 * `resource` with an `@odata.type` saying which kind it is.
 */
const KIND_BY_ODATA_TYPE: Record<string, string> = {
  "#microsoft.graph.driveItem": "driveItem",
  "#microsoft.graph.listItem": "listItem",
  "#microsoft.graph.list": "list",
  "#microsoft.graph.drive": "drive",
  "#microsoft.graph.site": "site",
};

const normalizeHit = (raw: unknown): Record<string, unknown> => {
  const resource = prop(raw, "resource");
  const odataType = str(prop(resource, "@odata.type"));
  const out: Record<string, unknown> = {
    kind: KIND_BY_ODATA_TYPE[odataType] ?? "driveItem",
    id: str(path(resource, "id")),
    // A driveItem/list has `name`; a listItem carries its label in
    // `fields.Title`; a site uses `displayName`.
    name: str(
      path(resource, "name"),
      str(
        path(resource, "displayName"),
        str(path(resource, "fields", "Title")),
      ),
    ),
    summary: str(prop(raw, "summary")),
  };
  const webUrl = asString(path(resource, "webUrl"));
  if (webUrl !== undefined) out.web_url = webUrl;
  const driveId = asString(path(resource, "parentReference", "driveId"));
  if (driveId !== undefined) out.drive_id = driveId;
  const siteId = asString(path(resource, "parentReference", "siteId"));
  if (siteId !== undefined) out.site_id = siteId;
  const listId = asString(path(resource, "parentReference", "listId"));
  if (listId !== undefined) out.list_id = listId;
  const size = asNumber(path(resource, "size"));
  if (size !== undefined) out.size_bytes = size;
  const modified = asString(path(resource, "lastModifiedDateTime"));
  if (modified !== undefined) out.last_modified_at = modified;
  return out;
};

const searchHits: ResponseMapper = (raw) => {
  const hits: Record<string, unknown>[] = [];
  for (const response of arr(path(raw, "value"))) {
    for (const container of arr(prop(response, "hitsContainers"))) {
      for (const hit of arr(prop(container, "hits"))) {
        hits.push(normalizeHit(hit));
      }
    }
  }
  return hits;
};

const uploadSession: ResponseMapper = (raw) => {
  const out: Record<string, unknown> = {
    upload_url: str(path(raw, "uploadUrl")),
  };
  const expires = asString(path(raw, "expirationDateTime"));
  if (expires !== undefined) out.expires_at = expires;
  return out;
};

/** 204 / 202 with no body — the agent gets `None`, not a raw envelope. */
const empty: ResponseMapper = () => ({});

export const sharepointMappers: ProviderMappers = {
  request: {
    listWithTop,
    searchSites,
    getSiteByUrl,
    listFolder,
    getItem,
    searchLibrary,
    search,
    downloadFile,
    resolveShareLink,
    expandFields,
    listListItems,
    getPage,
    createFolder,
    createUploadSession,
    updateItem,
    copyItem,
    createShareLink,
    grantItemAccess,
    createListItem,
    updateListItem,
  },
  response: {
    site: normalizeSite,
    siteList: listOf(normalizeSite),
    libraryList: listOf(normalizeLibrary),
    driveItem: normalizeDriveItem,
    driveItemList: listOf(normalizeDriveItem),
    driveItemPage: pageOf(normalizeDriveItem),
    fileDownload,
    versionList: listOf(normalizeVersion),
    permissionList: listOf(normalizePermission),
    shareLink,
    listEntry: normalizeList,
    listCollection: listOf(normalizeList),
    columnList: listOf(normalizeColumn),
    listItem: normalizeListItem,
    listItemPage: pageOf(normalizeListItem),
    listItemFields,
    pageList: listOf(normalizePage),
    page,
    searchHits,
    uploadSession,
    empty,
  },
};
