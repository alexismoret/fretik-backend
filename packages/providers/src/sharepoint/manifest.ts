import type { ProviderManifest } from "@fretik/shared/external-apps/manifest-schema";

/**
 * Microsoft SharePoint provider manifest — 32 Microsoft Graph v1.0 actions
 * over the three things a SharePoint tenant actually holds: SITES (where
 * content lives), DOCUMENT LIBRARIES (files) and LISTS (structured rows).
 * Site pages are read-only.
 *
 * Source of truth for the generated Python SDK, the generated SKILL.md and
 * backend argument validation. Authored by hand against the Microsoft Graph
 * v1.0 reference; every endpoint and every delegated permission below was
 * verified against `microsoftgraph/microsoft-graph-docs-contrib` before
 * merge.
 *
 * Nango integration: `sharepoint-online` — "SharePoint Online (v2)" in the
 * catalogue, which is an ALIAS of Nango's `microsoft` provider (OAuth2
 * authorization-code, delegated user permissions, proxy base
 * `https://graph.microsoft.com`). Exactly the shape `outlook`,
 * `microsoft-teams` and `microsoft-planner` already use here, so the
 * Connect UI, the admin-consent toggle and the one-click OAuth reconnect
 * all work with no new frontend code.
 *
 * WHY NOT `sharepoint-online-oauth2-cc` (client credentials). It is the
 * other integration Nango ships, and it looks like the answer to "we want a
 * global, team-wide SharePoint account". It is not:
 *  - App-only SharePoint permissions are all-or-nothing. `Sites.Read.All` /
 *    `Sites.ReadWrite.All` as APPLICATION permissions reach EVERY site
 *    collection in the tenant — HR, Finance, every private site. Microsoft's
 *    own guidance is `Sites.Selected` plus a per-site grant, which needs an
 *    admin-run `POST /sites/{id}/permissions` per site: an operator workflow
 *    Fretik does not have.
 *  - There is no user. Every write is attributed to "the app": no author on
 *    file versions, nothing meaningful in the audit log, and SharePoint's own
 *    per-user permissions stop bounding what the agent can touch.
 *  - `/me` disappears — `list_followed_sites` and the whole "what can this
 *    account actually see" discovery path go with it, and `/search/query`
 *    additionally requires a `region` under application permissions.
 *  - It buys nothing our model lacks: a Fretik connection is ALREADY
 *    `scope: team`. A team-scoped delegated connection is shared by the whole
 *    team by construction.
 * The team-wide account is therefore a delegated SERVICE ACCOUNT (see
 * SETUP.md): one Entra user, member of the sites the team should reach,
 * connected once with `scope: team`. SharePoint keeps enforcing its
 * permission model, and the blast radius is exactly the sites that account
 * was invited to.
 *
 * SCOPES. Everything below is covered by `Sites.ReadWrite.All` except
 * `/search/query`, whose permission list names `Sites.Read.All` and NOT
 * `Sites.ReadWrite.All` — Graph matches search scopes literally, so both are
 * requested. `Sites.Manage.All` (creating a list) and `Files.*` (the
 * connected user's own OneDrive) are deliberately NOT requested.
 *
 * NOT SHIPPED, and why:
 *  - `POST /sites/{id}/lists` (create a list) — needs `Sites.Manage.All`,
 *    a broader consent on every connection, for a one-off structural act a
 *    human does once in SharePoint's own UI. Not worth the scope.
 *  - Creating / publishing site pages — a page is a create-draft-then-publish
 *    pair, and operations inside one `run_plan` must be INDEPENDENT, so it
 *    cannot be one approval. The `canvasLayout` payload is also deep enough
 *    that a wrong guess produces a broken page. Reading pages (where the
 *    knowledge is) is what the agent needs.
 *  - `GET /sites` and `GET /sites/getAllSites` (enumerate the tenant) —
 *    application permissions only, "Not supported" for delegated.
 *  - Site-level permission grants (`/sites/{id}/permissions`) — `Sites.
 *    FullControl.All` + app-only. An agent must not be able to re-grant
 *    itself.
 *  - Content types, site columns, the term store — tenant governance
 *    surfaces. An agent reading `list_columns` gets everything it needs to
 *    write a row; the rest is an admin's job.
 *  - `checkout` / `checkin` — only meaningful for libraries that force
 *    check-out, and we never edit a file in place: an upload creates a new
 *    version.
 *  - Thumbnails, previews, analytics/activities — display concerns for a UI
 *    that renders SharePoint, which Fretik is not.
 *  - `delta` / change subscriptions — a sync engine's primitives. Fretik
 *    pulls on demand; there is no store to keep in sync.
 *  - The recycle bin — absent from Graph v1.0 altogether.
 *
 * UPLOADS go through `create_upload_session`, not a `PUT …/content`. Graph
 * takes raw bytes on `/content` and the Nango Proxy carries a JSON body, so
 * a base64 string would land in the file verbatim. `createUploadSession`
 * returns a short-lived pre-authenticated `uploadUrl` the sandbox PUTs to
 * directly — which is also what Microsoft prescribes above 4 MB, so one path
 * covers every size. The approval card carries the file name and the target
 * folder: approving the session IS approving the upload.
 */
export const sharepointManifest: ProviderManifest = {
  key: "sharepoint",
  displayName: "Microsoft SharePoint",
  description:
    "Microsoft SharePoint — browse and search sites, read and write files in document libraries, query and update SharePoint list rows, and read site pages.",
  nangoProviderConfigKey: "sharepoint-online",
  // Monochrome Iconify glyph, like Outlook and Exchange. SharePoint's
  // identity is a RAMP rather than one colour — Microsoft's Fluent palette
  // publishes the logo as #036C70 → #1A9BA1 → #37C6D0 — so the glyph is
  // painted with `iconGradient` and `iconColor` carries the flat fallback
  // (and the soft container tint) for anything that does not paint one.
  icon: "i-simple-icons-microsoftsharepoint",
  iconColor: "#036C70",
  iconGradient: ["#036C70", "#1A9BA1", "#37C6D0"],
  transport: { kind: "nango-proxy" },
  // Root "storage" drives the settings filter. "file-storage" tells the
  // agent SharePoint substitutes for any document-storage request;
  // "database" says its lists substitute for a "where do we track X" one.
  // NOT a communication provider — no persona option, no voice boilerplate.
  categories: ["storage", "file-storage", "database"],
  // `Sites.Read.All` / `Sites.ReadWrite.All` are admin-consent scopes in
  // most Microsoft 365 tenants. Turning this on unlocks the "Install for
  // the whole organization" toggle and the friendly AADSTS error UI.
  requiresAdminConsent: true,
  connectionOptions: {
    fields: [
      {
        // Almost every team works out of ONE SharePoint site. Naming it
        // here saves a discovery round-trip on every single request — the
        // agent reads it from the system prompt's <external_apps> block and
        // resolves it once with `get_site_by_url`.
        key: "default_site_url",
        labelKey:
          "settings.externalApps.providers.sharepoint.options.default_site_url.label",
        helpKey:
          "settings.externalApps.providers.sharepoint.options.default_site_url.help",
        kind: "text",
        required: false,
        exposeToAgent: true,
      },
    ],
  },
  scopes: [
    "offline_access",
    "User.Read",
    // Read+write over every site the CONNECTED USER can reach — files,
    // lists, list rows, pages. Not tenant-wide: delegated scopes are
    // intersected with that user's SharePoint permissions.
    "Sites.ReadWrite.All",
    // `/search/query` names `Sites.Read.All` in its permission table and
    // does NOT accept `Sites.ReadWrite.All` in its place. Both are needed.
    "Sites.Read.All",
  ],

  types: {
    Site: {
      id: {
        type: "string",
        description:
          "Composite site id (`hostname,siteCollectionId,siteId`). Pass verbatim as `site_id`.",
      },
      name: { type: "string", description: "URL slug of the site" },
      display_name: { type: "string", description: "Human-readable title" },
      web_url: { type: "string" },
      description: { type: "string", optional: true },
      created_at: { type: "datetime", optional: true },
      last_modified_at: { type: "datetime", optional: true },
    },
    Library: {
      id: {
        type: "string",
        description:
          "Drive id of the document library — pass as `drive_id` to every file action.",
      },
      name: { type: "string" },
      web_url: { type: "string" },
      description: { type: "string", optional: true },
      drive_type: {
        type: "string",
        description: "`documentLibrary` for a SharePoint library",
      },
    },
    DriveItem: {
      id: { type: "string" },
      name: { type: "string" },
      is_folder: {
        type: "boolean",
        description: "True for folders — files have `mime_type` instead",
      },
      size_bytes: { type: "integer" },
      web_url: { type: "string" },
      mime_type: { type: "string", optional: true, description: "Files only" },
      child_count: {
        type: "integer",
        optional: true,
        description: "Folders only",
      },
      parent_folder_id: {
        type: "string",
        optional: true,
        description: "Id of the containing folder — use it to walk back up",
      },
      parent_path: {
        type: "string",
        optional: true,
        description:
          "Library-relative path of the containing folder, e.g. `/drive/root:/Contracts/2026`",
      },
      drive_id: {
        type: "string",
        optional: true,
        description:
          "Library the item lives in. Set on cross-library results (search, share links); pass it back as `drive_id`.",
      },
      list_item_id: {
        type: "string",
        optional: true,
        description:
          "Same item seen as a list row. With `list_id` and the site id you already have, it reads and writes the library's custom columns through the list actions.",
      },
      list_id: {
        type: "string",
        optional: true,
        description: "The library seen as a list — pass as `list_id`",
      },
      created_at: { type: "datetime" },
      last_modified_at: { type: "datetime" },
      last_modified_by: { type: "string", optional: true },
    },
    FileDownload: {
      id: { type: "string" },
      name: { type: "string" },
      content_type: { type: "string" },
      size_bytes: { type: "integer" },
      sandbox_path: {
        type: "string",
        optional: true,
        description:
          "On-disk path to the downloaded file inside the sandbox. The runtime streams the bytes here so the agent never sees them — use it with any file-consuming tool or library (vision, pypdf, pillow, pandas, bash commands).",
      },
      download_url: {
        type: "string",
        optional: true,
        description:
          "Always `None` once the runtime has spilled the bytes to `sandbox_path`. Non-null only when the download failed — retry it yourself with `urllib.request`.",
      },
    },
    ItemVersion: {
      id: {
        type: "string",
        description: "Version label, e.g. `3.0` — pass as `version_id`",
      },
      size_bytes: { type: "integer", optional: true },
      last_modified_at: { type: "datetime" },
      last_modified_by: { type: "string", optional: true },
    },
    Permission: {
      id: { type: "string" },
      roles: {
        type: "array",
        items: { type: "string" },
        description: "`read` / `write` / `owner`",
      },
      granted_to: {
        type: "array",
        items: { type: "string" },
        description:
          "Display names or emails the permission is granted to. Empty for an anonymous link.",
      },
      link_type: {
        type: "string",
        optional: true,
        description: "Sharing links only: `view` / `edit` / `embed`",
      },
      link_scope: {
        type: "string",
        optional: true,
        description:
          "Sharing links only: `anonymous` / `organization` / `users`",
      },
      link_url: { type: "string", optional: true },
      inherited: {
        type: "boolean",
        description:
          "True when the permission comes from a parent folder or the site — revoking it needs an admin, not this connection.",
      },
      expires_at: { type: "datetime", optional: true },
    },
    ShareLink: {
      id: { type: "string" },
      link_url: { type: "string" },
      link_type: { type: "string" },
      link_scope: { type: "string" },
      expires_at: { type: "datetime", optional: true },
    },
    SharePointList: {
      id: { type: "string" },
      name: { type: "string", description: "URL slug of the list" },
      display_name: { type: "string" },
      web_url: { type: "string" },
      description: { type: "string", optional: true },
      template: {
        type: "string",
        optional: true,
        description:
          "`genericList` for a plain list, `documentLibrary` for a library seen as a list, `tasks`, `events`, …",
      },
      created_at: { type: "datetime", optional: true },
    },
    ListColumn: {
      name: {
        type: "string",
        description:
          "INTERNAL name — the key to use in `fields`, in `filter` and in `columns`. Not what SharePoint shows in its UI.",
      },
      display_name: {
        type: "string",
        description: "What the user sees in SharePoint",
      },
      type: {
        type: "string",
        description:
          "`text` / `number` / `boolean` / `dateTime` / `choice` / `lookup` / `personOrGroup` / `currency` / `hyperlinkOrPicture` / `calculated` / …",
      },
      required: { type: "boolean" },
      read_only: {
        type: "boolean",
        description: "Never send a read-only column in `fields` — Graph 400s",
      },
      choices: {
        type: "array",
        items: { type: "string" },
        optional: true,
        description: "Allowed values for a `choice` column",
      },
      description: { type: "string", optional: true },
    },
    ListItem: {
      id: { type: "string" },
      web_url: { type: "string", optional: true },
      fields: {
        type: "object",
        fields: {},
        description:
          "The row's column values, keyed by INTERNAL column name (see list_columns).",
      },
      created_at: { type: "datetime", optional: true },
      last_modified_at: { type: "datetime", optional: true },
      created_by: { type: "string", optional: true },
      last_modified_by: { type: "string", optional: true },
    },
    SitePage: {
      id: { type: "string" },
      name: { type: "string", description: "File name, e.g. `Home.aspx`" },
      title: { type: "string" },
      web_url: { type: "string" },
      description: { type: "string", optional: true },
      page_layout: {
        type: "string",
        optional: true,
        description: "`article` / `home` / `newsLink`",
      },
      published_at: { type: "datetime", optional: true },
      content_html: {
        type: "string",
        optional: true,
        description:
          "The page's text web parts concatenated in reading order. Populated by get_page only — list_pages leaves it `None`.",
      },
    },
    SearchHit: {
      kind: {
        type: "enum",
        values: ["driveItem", "listItem", "list", "drive", "site"],
        description: "Which action to follow up with",
      },
      id: { type: "string" },
      name: { type: "string" },
      web_url: { type: "string", optional: true },
      summary: {
        type: "string",
        description: "Matched snippet, with the hit terms marked by <c0>…</c0>",
      },
      drive_id: {
        type: "string",
        optional: true,
        description: "Set on driveItem hits — pass to get_item / download_file",
      },
      site_id: {
        type: "string",
        optional: true,
        description: "Set on listItem / list hits — pass to the list actions",
      },
      list_id: { type: "string", optional: true },
      size_bytes: { type: "integer", optional: true },
      last_modified_at: { type: "datetime", optional: true },
    },
    UploadSession: {
      upload_url: {
        type: "string",
        description:
          "Pre-authenticated PUT target, valid ~15 minutes. Send the file's bytes to it from Python — see the SKILL's upload pattern. Carries its own auth: never add a header to it.",
      },
      expires_at: { type: "datetime", optional: true },
    },
  },

  actions: [
    // ───────────────────────── Sites — discovery ─────────────────────────
    {
      name: "search_sites",
      kind: "read",
      summary: "Find SharePoint sites by name across the tenant",
      endpoint: { method: "GET", path: "/v1.0/sites" },
      params: {
        query: {
          type: "string",
          description:
            "Matches the site title and URL. `*` returns every site the account can see.",
        },
        limit: { type: "integer", min: 1, max: 100, default: 25 },
      },
      returns: { list: "Site" },
      request: "searchSites",
      response: "siteList",
    },
    {
      name: "get_site",
      kind: "read",
      summary: "Fetch one site by ID",
      endpoint: { method: "GET", path: "/v1.0/sites/{site_id}" },
      params: {
        site_id: {
          type: "string",
          in: "path",
          description: "Composite site id, or `root` for the tenant root site",
        },
      },
      returns: { ref: "Site" },
      response: "site",
    },
    {
      name: "get_site_by_url",
      kind: "read",
      summary: "Resolve a SharePoint URL the user pasted into its site",
      endpoint: { method: "GET", path: "/v1.0/sites" },
      params: {
        site_url: {
          type: "string",
          description:
            "Any URL inside the site, e.g. `https://contoso.sharepoint.com/sites/Legal` or a deep link to a document. Everything past the site segment is ignored.",
        },
      },
      returns: { ref: "Site" },
      request: "getSiteByUrl",
      response: "site",
    },
    {
      name: "list_followed_sites",
      kind: "read",
      summary: "List the sites the connected account follows",
      endpoint: { method: "GET", path: "/v1.0/me/followedSites" },
      params: {
        limit: { type: "integer", min: 1, max: 100, default: 50 },
      },
      returns: { list: "Site" },
      request: "listWithTop",
      response: "siteList",
    },

    // ──────────────────── Document libraries — browse ────────────────────
    {
      name: "list_libraries",
      kind: "read",
      summary: "List a site's document libraries",
      endpoint: { method: "GET", path: "/v1.0/sites/{site_id}/drives" },
      params: { site_id: { type: "string", in: "path" } },
      returns: { list: "Library" },
      response: "libraryList",
      paginate: true,
    },
    {
      name: "list_folder",
      kind: "read",
      summary: "List the files and folders directly inside a folder",
      endpoint: {
        method: "GET",
        path: "/v1.0/drives/{drive_id}/root/children",
      },
      params: {
        drive_id: { type: "string", in: "path" },
        folder_id: {
          type: "string",
          optional: true,
          description: "Defaults to the library root",
        },
        folder_path: {
          type: "string",
          optional: true,
          description:
            "Library-relative path instead of an id, e.g. `Contracts/2026`. Ignored when `folder_id` is set.",
        },
        limit: { type: "integer", min: 1, max: 200, default: 100 },
        page_token: {
          type: "string",
          optional: true,
          description: "`page_token` from the previous page's result",
        },
      },
      returns: { page: "DriveItem" },
      request: "listFolder",
      response: "driveItemPage",
    },
    {
      name: "get_item",
      kind: "read",
      summary: "Fetch one file or folder's metadata by ID or by path",
      endpoint: { method: "GET", path: "/v1.0/drives/{drive_id}/root" },
      params: {
        drive_id: { type: "string", in: "path" },
        item_id: { type: "string", optional: true },
        item_path: {
          type: "string",
          optional: true,
          description:
            "Library-relative path instead of an id, e.g. `Contracts/2026/acme.pdf`. Ignored when `item_id` is set.",
        },
      },
      returns: { ref: "DriveItem" },
      request: "getItem",
      response: "driveItem",
    },
    {
      name: "search_library",
      kind: "read",
      summary: "Search file and folder names + contents inside ONE library",
      endpoint: { method: "GET", path: "/v1.0/drives/{drive_id}/root" },
      params: {
        drive_id: { type: "string", in: "path" },
        query: { type: "string" },
        limit: { type: "integer", min: 1, max: 100, default: 25 },
      },
      returns: { list: "DriveItem" },
      request: "searchLibrary",
      response: "driveItemList",
    },
    {
      name: "search",
      kind: "read",
      summary:
        "Search files, list rows and sites across the WHOLE tenant (Microsoft Search)",
      endpoint: { method: "POST", path: "/v1.0/search/query" },
      params: {
        query: {
          type: "string",
          description:
            'Keywords, or KQL — `filetype:pdf`, `path:"https://…/Contracts"`, `LastModifiedTime>=2026-01-01`, `author:"Marie"`.',
        },
        entity_types: {
          type: "array",
          items: {
            type: "enum",
            values: ["driveItem", "listItem", "list", "drive", "site"],
          },
          optional: true,
          default: ["driveItem"],
          description:
            "What to look for. These five combine freely with each other and with nothing else.",
        },
        limit: { type: "integer", min: 1, max: 100, default: 25 },
        offset: {
          type: "integer",
          min: 0,
          max: 1000,
          default: 0,
          description: "Skip the first N hits",
        },
      },
      returns: { list: "SearchHit" },
      request: "search",
      response: "searchHits",
    },
    {
      name: "download_file",
      kind: "read",
      summary: "Download a file's content into the sandbox",
      endpoint: {
        method: "GET",
        path: "/v1.0/drives/{drive_id}/items/{item_id}",
      },
      params: {
        drive_id: { type: "string", in: "path" },
        item_id: { type: "string", in: "path" },
      },
      returns: { ref: "FileDownload" },
      request: "downloadFile",
      response: "fileDownload",
    },
    {
      name: "resolve_share_link",
      kind: "read",
      summary:
        "Turn a SharePoint/OneDrive sharing link into the file it points at",
      endpoint: { method: "GET", path: "/v1.0/shares" },
      params: {
        share_url: {
          type: "string",
          description:
            "The link as the user pasted it, including any `?e=…` suffix",
        },
      },
      returns: { ref: "DriveItem" },
      request: "resolveShareLink",
      response: "driveItem",
    },
    {
      name: "list_versions",
      kind: "read",
      summary: "List a file's version history",
      endpoint: {
        method: "GET",
        path: "/v1.0/drives/{drive_id}/items/{item_id}/versions",
      },
      params: {
        drive_id: { type: "string", in: "path" },
        item_id: { type: "string", in: "path" },
        limit: { type: "integer", min: 1, max: 100, default: 20 },
      },
      returns: { list: "ItemVersion" },
      request: "listWithTop",
      response: "versionList",
    },
    {
      name: "list_permissions",
      kind: "read",
      summary: "List who has access to a file or folder, and how",
      endpoint: {
        method: "GET",
        path: "/v1.0/drives/{drive_id}/items/{item_id}/permissions",
      },
      params: {
        drive_id: { type: "string", in: "path" },
        item_id: { type: "string", in: "path" },
      },
      returns: { list: "Permission" },
      response: "permissionList",
    },

    // ──────────────────── Document libraries — write ─────────────────────
    {
      name: "create_folder",
      kind: "write",
      summary: "Create a folder inside a library",
      endpoint: {
        method: "POST",
        path: "/v1.0/drives/{drive_id}/items/{parent_folder_id}/children",
      },
      params: {
        drive_id: { type: "string", in: "path" },
        parent_folder_id: {
          type: "string",
          in: "path",
          default: "root",
          description: "`root` for the top level of the library",
        },
        name: { type: "string", excludeFromHash: true },
        conflict_behavior: {
          type: "enum",
          values: ["rename", "replace", "fail"],
          optional: true,
          default: "rename",
          description: "What to do when a folder of that name already exists",
        },
      },
      returns: { ref: "DriveItem" },
      request: "createFolder",
      response: "driveItem",
    },
    {
      name: "create_upload_session",
      kind: "write",
      summary:
        "Open an upload slot for a file — send the bytes to the returned URL",
      // Path addressing: `…/items/{parent}:/{name}:/createUploadSession`.
      // The `:` delimiters are literal; `substitutePath` URL-encodes the
      // file name, which is exactly what Graph wants there.
      endpoint: {
        method: "POST",
        path: "/v1.0/drives/{drive_id}/items/{parent_folder_id}:/{file_name}:/createUploadSession",
      },
      params: {
        drive_id: { type: "string", in: "path" },
        parent_folder_id: {
          type: "string",
          in: "path",
          default: "root",
          description:
            "Folder to upload into — `root` for the library's top level",
        },
        file_name: {
          type: "string",
          in: "path",
          excludeFromHash: true,
          description: "File name WITH its extension, e.g. `Q1-report.pdf`",
        },
        conflict_behavior: {
          type: "enum",
          values: ["rename", "replace", "fail"],
          optional: true,
          default: "rename",
          description:
            "`replace` uploads a new VERSION of an existing file of that name — SharePoint keeps the old one in the history.",
        },
      },
      returns: { ref: "UploadSession" },
      request: "createUploadSession",
      response: "uploadSession",
    },
    {
      name: "update_item",
      kind: "write",
      summary: "Rename a file or folder and/or move it to another folder",
      endpoint: {
        method: "PATCH",
        path: "/v1.0/drives/{drive_id}/items/{item_id}",
      },
      params: {
        drive_id: { type: "string", in: "path" },
        item_id: { type: "string", in: "path" },
        new_name: { type: "string", optional: true, excludeFromHash: true },
        new_parent_folder_id: {
          type: "string",
          optional: true,
          description: "Move target, in the SAME library",
        },
      },
      returns: { ref: "DriveItem" },
      request: "updateItem",
      response: "driveItem",
    },
    {
      name: "delete_item",
      kind: "write",
      summary: "Delete a file or folder (goes to the site's recycle bin)",
      endpoint: {
        method: "DELETE",
        path: "/v1.0/drives/{drive_id}/items/{item_id}",
      },
      params: {
        drive_id: { type: "string", in: "path" },
        item_id: { type: "string", in: "path" },
      },
      returns: { void: true },
      response: "empty",
    },
    {
      name: "copy_item",
      kind: "write",
      summary:
        "Copy a file or folder into another folder, possibly another library",
      endpoint: {
        method: "POST",
        path: "/v1.0/drives/{drive_id}/items/{item_id}/copy",
      },
      params: {
        drive_id: { type: "string", in: "path" },
        item_id: { type: "string", in: "path" },
        target_folder_id: {
          type: "string",
          description: "Destination folder id",
        },
        target_drive_id: {
          type: "string",
          optional: true,
          description: "Destination library — defaults to the source library",
        },
        new_name: {
          type: "string",
          optional: true,
          excludeFromHash: true,
          description: "Name of the copy — defaults to the source name",
        },
      },
      returns: { void: true },
      request: "copyItem",
      response: "empty",
    },
    {
      name: "restore_version",
      kind: "write",
      summary: "Restore a previous version of a file as the current one",
      endpoint: {
        method: "POST",
        path: "/v1.0/drives/{drive_id}/items/{item_id}/versions/{version_id}/restoreVersion",
      },
      params: {
        drive_id: { type: "string", in: "path" },
        item_id: { type: "string", in: "path" },
        version_id: {
          type: "string",
          in: "path",
          description: "Version label from list_versions, e.g. `3.0`",
        },
      },
      returns: { void: true },
      response: "empty",
    },
    {
      name: "create_share_link",
      kind: "write",
      summary: "Create a sharing link to a file or folder",
      endpoint: {
        method: "POST",
        path: "/v1.0/drives/{drive_id}/items/{item_id}/createLink",
      },
      params: {
        drive_id: { type: "string", in: "path" },
        item_id: { type: "string", in: "path" },
        link_type: {
          type: "enum",
          values: ["view", "edit", "embed"],
          default: "view",
        },
        scope: {
          type: "enum",
          values: ["organization", "anonymous", "users"],
          default: "organization",
          description:
            "`organization` = anyone signed into the tenant. `anonymous` = anyone with the link, and many tenants block it outright — only use it when the user asked for a public link.",
        },
        expiration_date: {
          type: "date",
          optional: true,
          description: "Calendar day the link stops working (YYYY-MM-DD)",
        },
      },
      returns: { ref: "ShareLink" },
      request: "createShareLink",
      response: "shareLink",
    },
    {
      name: "grant_item_access",
      kind: "write",
      summary: "Give named people access to a file or folder",
      endpoint: {
        method: "POST",
        path: "/v1.0/drives/{drive_id}/items/{item_id}/invite",
      },
      params: {
        drive_id: { type: "string", in: "path" },
        item_id: { type: "string", in: "path" },
        emails: { type: "array", items: { type: "email" } },
        role: {
          type: "enum",
          values: ["read", "write"],
          default: "read",
        },
        message: {
          type: "string",
          optional: true,
          excludeFromHash: true,
          description:
            "Sent to the recipients when `send_invitation` is on. Keep it short and factual — it is an email from the connected account.",
        },
        send_invitation: {
          type: "boolean",
          optional: true,
          default: true,
          description: "Email the recipients. Off = grant silently.",
        },
        require_sign_in: { type: "boolean", optional: true, default: true },
        expiration_date: {
          type: "date",
          optional: true,
          description: "Calendar day the access ends (YYYY-MM-DD)",
        },
      },
      returns: { list: "Permission" },
      request: "grantItemAccess",
      response: "permissionList",
    },
    {
      name: "revoke_item_access",
      kind: "write",
      summary: "Revoke one permission or sharing link on a file or folder",
      endpoint: {
        method: "DELETE",
        path: "/v1.0/drives/{drive_id}/items/{item_id}/permissions/{permission_id}",
      },
      params: {
        drive_id: { type: "string", in: "path" },
        item_id: { type: "string", in: "path" },
        permission_id: {
          type: "string",
          in: "path",
          description:
            "From list_permissions. An `inherited` permission cannot be revoked here.",
        },
      },
      returns: { void: true },
      response: "empty",
    },

    // ───────────────────────────── Lists ─────────────────────────────────
    {
      name: "list_lists",
      kind: "read",
      summary: "List a site's lists (and its libraries seen as lists)",
      endpoint: { method: "GET", path: "/v1.0/sites/{site_id}/lists" },
      params: { site_id: { type: "string", in: "path" } },
      returns: { list: "SharePointList" },
      response: "listCollection",
      paginate: true,
    },
    {
      name: "get_list",
      kind: "read",
      summary: "Fetch one list by ID or by its URL slug",
      endpoint: {
        method: "GET",
        path: "/v1.0/sites/{site_id}/lists/{list_id}",
      },
      params: {
        site_id: { type: "string", in: "path" },
        list_id: {
          type: "string",
          in: "path",
          description: "List id, or the list's URL slug (its `name`)",
        },
      },
      returns: { ref: "SharePointList" },
      response: "listEntry",
    },
    {
      name: "list_columns",
      kind: "read",
      summary:
        "List a list's columns — READ THIS before filtering or writing rows",
      endpoint: {
        method: "GET",
        path: "/v1.0/sites/{site_id}/lists/{list_id}/columns",
      },
      params: {
        site_id: { type: "string", in: "path" },
        list_id: { type: "string", in: "path" },
      },
      returns: { list: "ListColumn" },
      response: "columnList",
      paginate: true,
    },
    {
      name: "list_list_items",
      kind: "read",
      summary: "List the rows of a list, optionally filtered and sorted",
      endpoint: {
        method: "GET",
        path: "/v1.0/sites/{site_id}/lists/{list_id}/items",
      },
      params: {
        site_id: { type: "string", in: "path" },
        list_id: { type: "string", in: "path" },
        filter: {
          type: "string",
          optional: true,
          description:
            "OData filter on INTERNAL column names, prefixed with `fields/`: `fields/Status eq 'Open'`, `fields/Amount gt 1000`, `startswith(fields/Title,'ACME')`.",
        },
        order_by: {
          type: "string",
          optional: true,
          description:
            "`fields/<InternalName>` plus `asc` / `desc`, e.g. `fields/Created desc`. Only INDEXED columns can be sorted.",
        },
        columns: {
          type: "array",
          items: { type: "string" },
          optional: true,
          description:
            "Internal column names to return. Omit for every column — set it on wide lists to keep the result small.",
        },
        limit: { type: "integer", min: 1, max: 200, default: 50 },
        page_token: {
          type: "string",
          optional: true,
          description: "`page_token` from the previous page's result",
        },
      },
      returns: { page: "ListItem" },
      request: "listListItems",
      response: "listItemPage",
    },
    {
      name: "get_list_item",
      kind: "read",
      summary: "Fetch one list row with all its column values",
      endpoint: {
        method: "GET",
        path: "/v1.0/sites/{site_id}/lists/{list_id}/items/{item_id}",
      },
      params: {
        site_id: { type: "string", in: "path" },
        list_id: { type: "string", in: "path" },
        item_id: { type: "string", in: "path" },
      },
      returns: { ref: "ListItem" },
      request: "expandFields",
      response: "listItem",
    },
    {
      name: "create_list_item",
      kind: "write",
      summary: "Add a row to a list",
      endpoint: {
        method: "POST",
        path: "/v1.0/sites/{site_id}/lists/{list_id}/items",
      },
      params: {
        site_id: { type: "string", in: "path" },
        list_id: { type: "string", in: "path" },
        fields: {
          type: "object",
          fields: {},
          excludeFromHash: true,
          description:
            'Column values keyed by INTERNAL name from list_columns, e.g. `{"Title": "ACME", "Status": "Open", "Amount": 1200}`. Never send a read-only column.',
        },
      },
      returns: { ref: "ListItem" },
      request: "createListItem",
      response: "listItem",
    },
    {
      name: "update_list_item",
      kind: "write",
      summary: "Update column values on an existing list row",
      endpoint: {
        method: "PATCH",
        path: "/v1.0/sites/{site_id}/lists/{list_id}/items/{item_id}/fields",
      },
      params: {
        site_id: { type: "string", in: "path" },
        list_id: { type: "string", in: "path" },
        item_id: { type: "string", in: "path" },
        fields: {
          type: "object",
          fields: {},
          excludeFromHash: true,
          description:
            "Only the columns to change, keyed by INTERNAL name. Columns left out keep their value.",
        },
      },
      returns: { ref: "ListItem" },
      request: "updateListItem",
      response: "listItemFields",
    },
    {
      name: "delete_list_item",
      kind: "write",
      summary: "Delete a row from a list",
      endpoint: {
        method: "DELETE",
        path: "/v1.0/sites/{site_id}/lists/{list_id}/items/{item_id}",
      },
      params: {
        site_id: { type: "string", in: "path" },
        list_id: { type: "string", in: "path" },
        item_id: { type: "string", in: "path" },
      },
      returns: { void: true },
      response: "empty",
    },

    // ─────────────────────────── Site pages ──────────────────────────────
    {
      name: "list_pages",
      kind: "read",
      summary: "List a site's pages (intranet news, wiki, home page)",
      endpoint: {
        method: "GET",
        path: "/v1.0/sites/{site_id}/pages/microsoft.graph.sitePage",
      },
      params: {
        site_id: { type: "string", in: "path" },
        limit: { type: "integer", min: 1, max: 100, default: 50 },
      },
      returns: { list: "SitePage" },
      request: "listWithTop",
      response: "pageList",
    },
    {
      name: "get_page",
      kind: "read",
      summary: "Read a site page's text content",
      endpoint: {
        method: "GET",
        path: "/v1.0/sites/{site_id}/pages/{page_id}/microsoft.graph.sitePage",
      },
      params: {
        site_id: { type: "string", in: "path" },
        page_id: { type: "string", in: "path" },
      },
      returns: { ref: "SitePage" },
      request: "getPage",
      response: "page",
    },
  ],
};
