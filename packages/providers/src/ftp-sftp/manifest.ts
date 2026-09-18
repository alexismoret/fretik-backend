import type { ProviderManifest } from "@fretik/shared/external-apps/manifest-schema";
import {
  MAX_DOWNLOAD_FILES,
  MAX_DOWNLOAD_TOTAL_MB,
  MAX_UPLOAD_FILES,
  MAX_UPLOAD_TOTAL_MB,
  MAX_WALK_RESULTS,
} from "./limits";

/**
 * FTP/SFTP provider manifest — file transfer over the open standards
 * (RFC 959 FTP, RFC 4217 FTPS, and SFTP as an SSH subsystem). Covers any
 * file server the user can reach with a host, a login and either a password
 * or an SSH key: EDI drop folders, partner exchanges, WMS/TMS export
 * directories, backup targets, self-hosted NAS.
 *
 * ONE provider for three protocols on purpose. The user's mental model is
 * "my file server", not "my RFC 959 endpoint", and the actions are
 * identical across all three — only the wire differs, which is `client.ts`'s
 * problem and no one else's. Splitting them the way Pipedream does (one app
 * for key auth, one for password auth) pushes a protocol decision onto
 * someone who just wants their files, and forks every skill, every summary
 * and every disambiguation rule for nothing.
 *
 * Transport is `custom-handler`: neither protocol is HTTP, so Nango is used
 * purely as encrypted credential storage and our own handlers speak the
 * wire. Because SFTP needs up to four secrets (username, password OR
 * private key, passphrase) and an RSA private key alone blows past Nango's
 * 1024-character BASIC slots, the credentials form uses a `secretEnvelope`:
 * the whole set is stored as one encrypted JSON blob. See the schema's
 * JSDoc for why no other slot fits.
 */
export const ftpSftpManifest: ProviderManifest = {
  key: "ftp-sftp",
  displayName: "File transfer (FTP/SFTP)",
  description:
    "File transfer over FTP, FTPS and SFTP — browse a remote file server, read its folders and file metadata, download and upload files in bulk, and move, rename or delete what is there.",
  nangoProviderConfigKey: "ftp-sftp",
  // A protocol has no brand mark, so the glyph has to carry the meaning.
  // Lucide's own tags for `folder-sync` are directory / transfer / backup,
  // which is the job exactly — and it reads differently at a glance from
  // every other connected app, which is what a hub full of icons needs.
  // The amber ramp is unclaimed in the catalogue (the others are Microsoft
  // blue, SharePoint teal, Teams indigo, Akanea violet, Shiptify cyan).
  icon: "i-lucide-folder-sync",
  iconColor: "#F59E0B",
  iconGradient: ["#F59E0B", "#EA580C"],
  transport: { kind: "custom-handler" },
  // One call at a time per connection — the default that works EVERYWHERE
  // rather than the one that works on modern servers.
  //
  // Each action opens its own FTP/SSH session, and a file server caps
  // concurrent sessions per LOGIN: an EDI account is routinely limited to
  // one or two, and exceeding it answers `421 Too many connections` — which
  // reads exactly like bad credentials to anyone debugging it. Parallel
  // would serve a modern SFTP server slightly better and break a locked-down
  // one outright, so the connection card's per-account override
  // (`external_app_connections.concurrency_mode`) is the place to relax it.
  //
  // The wait is long because an FTP transfer is: an 8-second default would
  // make a second widget give up while the first is still moving bytes.
  concurrency: { mode: "serial", maxWaitMs: 60_000 },
  // No OAuth. Credentials come from the descriptor-driven form and Nango
  // stores them (private-api-bearer template — see SETUP.md).
  scopes: [],
  // Root "storage" drives the settings filter; "file-storage" tells the
  // agent this connection substitutes for any "where are the files" request
  // alongside SharePoint / OneDrive / Drive. NOT a communication provider —
  // no persona option, no voice boilerplate.
  categories: ["storage", "file-storage"],

  credentialsForm: {
    // The whole secret set lands in ONE encrypted Nango field. Four secrets
    // and a multi-kilobyte private key do not fit the two 1024-character
    // slots Nango's BASIC template exposes.
    secretEnvelope: { nangoKey: "apiKey" },
    sections: [
      {
        key: "server",
        titleKey:
          "settings.externalApps.providers.ftp-sftp.sections.server.title",
      },
      {
        key: "auth",
        titleKey:
          "settings.externalApps.providers.ftp-sftp.sections.auth.title",
      },
      {
        key: "advanced",
        titleKey:
          "settings.externalApps.providers.ftp-sftp.sections.advanced.title",
        collapsed: true,
      },
    ],
    fields: [
      {
        key: "protocol",
        labelKey:
          "settings.externalApps.providers.ftp-sftp.fields.protocol.label",
        helpKey:
          "settings.externalApps.providers.ftp-sftp.fields.protocol.help",
        kind: "select",
        target: "connection_config",
        required: true,
        default: "sftp",
        options: [
          {
            value: "sftp",
            labelKey:
              "settings.externalApps.providers.ftp-sftp.fields.protocol.sftp",
          },
          {
            value: "ftps",
            labelKey:
              "settings.externalApps.providers.ftp-sftp.fields.protocol.ftps",
          },
          {
            value: "ftps-implicit",
            labelKey:
              "settings.externalApps.providers.ftp-sftp.fields.protocol.ftpsImplicit",
          },
          {
            value: "ftp",
            labelKey:
              "settings.externalApps.providers.ftp-sftp.fields.protocol.ftp",
          },
        ],
        section: "server",
      },
      {
        key: "host",
        labelKey: "settings.externalApps.providers.ftp-sftp.fields.host.label",
        helpKey: "settings.externalApps.providers.ftp-sftp.fields.host.help",
        kind: "text",
        target: "connection_config",
        required: true,
        section: "server",
      },
      {
        // Optional on purpose: the standard port is a function of the
        // protocol (22 / 21 / 990) and only a non-standard one is worth
        // asking a user to type.
        key: "port",
        labelKey: "settings.externalApps.providers.ftp-sftp.fields.port.label",
        helpKey: "settings.externalApps.providers.ftp-sftp.fields.port.help",
        kind: "number",
        target: "connection_config",
        required: false,
        min: 1,
        max: 65535,
        section: "server",
      },
      {
        key: "username",
        labelKey:
          "settings.externalApps.providers.ftp-sftp.fields.username.label",
        kind: "text",
        target: "credentials",
        required: true,
        section: "auth",
      },
      {
        key: "auth_method",
        labelKey:
          "settings.externalApps.providers.ftp-sftp.fields.auth_method.label",
        helpKey:
          "settings.externalApps.providers.ftp-sftp.fields.auth_method.help",
        kind: "select",
        // Not a secret, and it has to survive into the reconnect form —
        // `connection_config` is the half of a connection we can read back.
        target: "connection_config",
        required: true,
        default: "password",
        options: [
          {
            value: "password",
            labelKey:
              "settings.externalApps.providers.ftp-sftp.fields.auth_method.password",
          },
          {
            value: "private_key",
            labelKey:
              "settings.externalApps.providers.ftp-sftp.fields.auth_method.privateKey",
          },
        ],
        section: "auth",
      },
      {
        key: "password",
        labelKey:
          "settings.externalApps.providers.ftp-sftp.fields.password.label",
        kind: "password",
        target: "credentials",
        required: true,
        visibleWhen: { field: "auth_method", equals: ["password"] },
        section: "auth",
      },
      {
        key: "private_key",
        labelKey:
          "settings.externalApps.providers.ftp-sftp.fields.private_key.label",
        helpKey:
          "settings.externalApps.providers.ftp-sftp.fields.private_key.help",
        // A PEM block is 5 to 50 lines. Pasted into a single-line input it
        // arrives newline-free and never parses, with an error that blames
        // the key rather than the field.
        kind: "textarea",
        target: "credentials",
        required: true,
        visibleWhen: { field: "auth_method", equals: ["private_key"] },
        section: "auth",
      },
      {
        key: "passphrase",
        labelKey:
          "settings.externalApps.providers.ftp-sftp.fields.passphrase.label",
        helpKey:
          "settings.externalApps.providers.ftp-sftp.fields.passphrase.help",
        kind: "password",
        target: "credentials",
        required: false,
        visibleWhen: { field: "auth_method", equals: ["private_key"] },
        section: "auth",
      },
      {
        key: "root_path",
        labelKey:
          "settings.externalApps.providers.ftp-sftp.fields.root_path.label",
        helpKey:
          "settings.externalApps.providers.ftp-sftp.fields.root_path.help",
        kind: "text",
        target: "connection_config",
        required: false,
        section: "advanced",
      },
      {
        key: "host_fingerprint",
        labelKey:
          "settings.externalApps.providers.ftp-sftp.fields.host_fingerprint.label",
        helpKey:
          "settings.externalApps.providers.ftp-sftp.fields.host_fingerprint.help",
        kind: "text",
        target: "connection_config",
        required: false,
        visibleWhen: { field: "protocol", equals: ["sftp"] },
        section: "advanced",
      },
      {
        key: "allow_self_signed_cert",
        labelKey:
          "settings.externalApps.providers.ftp-sftp.fields.allow_self_signed_cert.label",
        helpKey:
          "settings.externalApps.providers.ftp-sftp.fields.allow_self_signed_cert.help",
        kind: "boolean",
        target: "connection_config",
        required: false,
        default: false,
        visibleWhen: { field: "protocol", equals: ["ftps", "ftps-implicit"] },
        section: "advanced",
      },
    ],
    testConnection: { supported: true },
  },

  types: {
    RemoteEntry: {
      name: { type: "string", description: "File or folder name" },
      path: {
        type: "string",
        description:
          "Full path to pass back to any other action. Already relative to the connection's root folder when one is configured.",
      },
      type: { type: "enum", values: ["file", "directory", "symlink"] },
      size_bytes: { type: "integer", optional: true },
      modified_at: {
        type: "datetime",
        optional: true,
        description:
          "Absent on an FTP server with no MLSD/MDTM support — check `get_server_info().supports_modified_time` before sorting or filtering on it.",
      },
      mode: {
        type: "string",
        optional: true,
        description:
          "POSIX permission bits, e.g. `0644`. SFTP always; FTP only on Unix-style listings.",
      },
      owner: { type: "string", optional: true },
      group: { type: "string", optional: true },
    },
    // Flat rather than a nested `entry` object: a nested one renders as an
    // untyped `dict` in the generated SDK, so the agent would be guessing
    // field names on the one shape it was given to avoid guessing.
    EntryLookup: {
      path: { type: "string", description: "The path as you asked for it" },
      exists: {
        type: "boolean",
        description:
          "Also false when the lookup itself failed — check `error` before concluding a path is absent.",
      },
      type: {
        type: "enum",
        values: ["file", "directory", "symlink"],
        optional: true,
        description: "`None` when the path does not exist",
      },
      size_bytes: { type: "integer", optional: true },
      modified_at: { type: "datetime", optional: true },
      mode: { type: "string", optional: true },
      error: {
        type: "string",
        optional: true,
        description:
          "Set when the lookup itself failed — which is NOT the same as the path not existing.",
      },
    },
    RemoteFile: {
      path: { type: "string", description: "Remote path it was read from" },
      name: { type: "string" },
      size_bytes: { type: "integer" },
      content_type: { type: "string" },
      sandbox_path: {
        type: "string",
        optional: true,
        description:
          "On-disk path to the downloaded file inside the sandbox. The runtime spills the bytes here so the agent never sees them — use it with any file-consuming tool or library (read, vision, pandas, pypdf, bash).",
      },
      content_base64: {
        type: "string",
        optional: true,
        description:
          "Always `None` once the runtime has spilled the bytes to `sandbox_path`.",
      },
      error: {
        type: "string",
        optional: true,
        description:
          "Set when THIS file failed while the rest of the batch succeeded. `sandbox_path` is then `None`.",
      },
    },
    ServerInfo: {
      protocol: {
        type: "enum",
        values: ["sftp", "ftp", "ftps", "ftps-implicit"],
      },
      host: { type: "string" },
      working_directory: {
        type: "string",
        description: "Where a relative path starts from on this connection",
      },
      root_path: {
        type: "string",
        optional: true,
        description:
          "Folder this connection is pinned to. Every path you send and receive is relative to it.",
      },
      supports_modified_time: { type: "boolean" },
      supports_size: { type: "boolean" },
      supports_permissions: {
        type: "boolean",
        description: "False on FTP — permissions can only be set over SFTP.",
      },
      server_software: { type: "string", optional: true },
    },
    WriteResult: {
      path: { type: "string" },
      ok: { type: "boolean" },
      error: {
        type: "string",
        optional: true,
        description: "Why this one item failed, when `ok` is false.",
      },
    },
  },

  actions: [
    // ───────────────────────── Discovery ──────────────────────────
    {
      // The first question on an unfamiliar file server is "where am I and
      // what can this thing answer", and FTP servers differ wildly on the
      // second half. Without this the agent guesses, sorts on timestamps
      // that are all `None`, and reports an empty folder as an error.
      name: "get_server_info",
      kind: "read",
      summary:
        "Show the connection's protocol, starting folder and capabilities",
      handler: "getServerInfo",
      params: {},
      returns: { ref: "ServerInfo" },
    },
    {
      name: "list_directory",
      kind: "read",
      summary: "List the files and folders directly inside one folder",
      handler: "listDirectory",
      params: {
        path: {
          type: "string",
          optional: true,
          default: "",
          description:
            "Folder to list. Omit for the connection's starting folder.",
        },
        pattern: {
          type: "string",
          optional: true,
          description:
            "Glob on the NAME, case-insensitive, e.g. `*.csv` or `ORDER_??.xml`. Omit for everything.",
        },
        include_directories: {
          type: "boolean",
          optional: true,
          default: true,
          description: "Set false to return files only",
        },
        sort: {
          type: "enum",
          values: ["name", "modified_desc", "size_desc"],
          optional: true,
          default: "name",
          description:
            "`modified_desc` needs a server that reports times — see get_server_info",
        },
        limit: { type: "integer", min: 1, max: 1000, default: 200 },
      },
      returns: { list: "RemoteEntry" },
    },
    {
      // Separate from `list_directory` rather than a `recursive` flag on it,
      // because the costs are not comparable: one is a single command, the
      // other walks a tree the agent cannot see the size of. A distinct
      // action makes that a deliberate choice, with its own depth and
      // result ceilings.
      name: "find_files",
      kind: "read",
      summary: "Search a folder tree for files matching a name pattern",
      handler: "findFiles",
      params: {
        path: {
          type: "string",
          optional: true,
          default: "",
          description: "Folder to search from. Omit for the starting folder.",
        },
        pattern: {
          type: "string",
          description:
            "Glob on the file NAME, case-insensitive, e.g. `*.edi`. Use `*` for every file.",
        },
        max_depth: {
          type: "integer",
          min: 1,
          max: 10,
          default: 3,
          description: "1 = the folder itself, no subfolders",
        },
        modified_after: {
          type: "datetime",
          optional: true,
          description:
            "Keep files modified strictly after this instant. Ignored on a server that reports no times.",
        },
        limit: { type: "integer", min: 1, max: MAX_WALK_RESULTS, default: 200 },
      },
      returns: { list: "RemoteEntry" },
    },
    {
      // Takes a LIST, and answers `exists: false` instead of raising,
      // because the question it is actually asked is "has the partner
      // dropped the file yet" — and an exception is a poor answer to a
      // question whose expected answer is often "not yet".
      name: "get_entries",
      kind: "read",
      summary: "Check whether paths exist and read their metadata",
      handler: "getEntries",
      params: {
        paths: {
          type: "array",
          items: { type: "string" },
          description: "Files or folders to look up, in one round-trip",
        },
      },
      returns: { list: "EntryLookup" },
    },

    // ───────────────────────── Transfers ──────────────────────────
    {
      name: "download_files",
      kind: "read",
      summary: "Download files into the sandbox — bytes land at `sandbox_path`",
      handler: "downloadFiles",
      params: {
        paths: {
          type: "array",
          items: { type: "string" },
          description: `Remote files to fetch. Up to ${MAX_DOWNLOAD_FILES.toString()} per call, ${MAX_DOWNLOAD_TOTAL_MB.toString()} MB total — a file that fails comes back with \`error\` set while the rest still arrive.`,
        },
      },
      returns: { list: "RemoteFile" },
    },
    {
      name: "upload_files",
      kind: "write",
      summary: "Upload files to the server (creates missing folders)",
      handler: "uploadFiles",
      params: {
        // Nothing here is dropped from the approval's lookup hash. Stripping
        // the array would leave `on_conflict` and `create_directories` as the
        // only discriminators; stripping just the BYTES, one level down, was
        // the previous shape and was not enough either — two uploads to the
        // same paths with DIFFERENT content hashed alike, so the second
        // matched the first's consumed grant and was replayed. Observed in
        // prod on 2026-09-16: the agent was told `ok`, and the partner kept
        // the old file.
        //
        // `hashAsDigest` keeps what that was protecting — a byte-identical
        // re-send still matches its grant, so a regenerated file does not
        // re-prompt — while making different content a different plan. The
        // cost is a fresh card when the bytes really did change, which is
        // what approving an upload should mean.
        files: {
          type: "array",
          description: `Files to send. Up to ${MAX_UPLOAD_FILES.toString()} per call, ${MAX_UPLOAD_TOTAL_MB.toString()} MB total.`,
          items: {
            type: "object",
            fields: {
              remote_path: {
                type: "string",
                description: "Destination path INCLUDING the file name",
              },
              content_base64: {
                type: "string",
                description:
                  'The file\'s bytes, base64-encoded. `""` writes a 0-byte file.',
                hashAsDigest: true,
              },
              mode: {
                type: "string",
                optional: true,
                description:
                  "POSIX permissions to set after writing, e.g. `0644`. SFTP only.",
              },
            },
          },
        },
        on_conflict: {
          type: "enum",
          values: ["replace", "rename", "fail"],
          optional: true,
          default: "replace",
          description:
            "`rename` appends a numeric suffix; `fail` leaves the existing file alone and reports it",
        },
        create_directories: {
          type: "boolean",
          optional: true,
          default: true,
          description: "Create missing parent folders",
        },
      },
      returns: { list: "WriteResult" },
    },

    // ─────────────────────── Housekeeping ─────────────────────────
    {
      // One action for rename AND move, because on both protocols they are
      // one command (`RNFR`/`RNTO`, SFTP `rename`) with the same failure
      // modes. Two actions would be a fiction the agent has to maintain.
      name: "move_entries",
      kind: "write",
      summary: "Move or rename files and folders",
      handler: "moveEntries",
      params: {
        moves: {
          type: "array",
          description: "Each entry moves one path to another",
          items: {
            type: "object",
            fields: {
              from_path: { type: "string" },
              to_path: {
                type: "string",
                description: "Destination path INCLUDING the new name",
              },
            },
          },
        },
        create_directories: {
          type: "boolean",
          optional: true,
          default: true,
          description: "Create the destination's parent folders if missing",
        },
      },
      returns: { list: "WriteResult" },
    },
    {
      name: "delete_files",
      kind: "write",
      summary: "Delete files (not folders)",
      handler: "deleteFiles",
      params: {
        paths: {
          type: "array",
          items: { type: "string" },
          description: "Files to delete. A path that is a folder is refused.",
        },
      },
      returns: { list: "WriteResult" },
    },
    {
      name: "create_directory",
      kind: "write",
      summary: "Create a folder, with any missing parents",
      handler: "createDirectory",
      params: {
        // `path` is the ONLY discriminating argument this action has —
        // excluding it from the approval's lookup hash would make every
        // `create_directory` in a turn match the first one's grant and
        // short-circuit on its consumed result, creating nothing.
        path: { type: "string" },
        mode: {
          type: "string",
          optional: true,
          description: "POSIX permissions, e.g. `0755`. SFTP only.",
        },
      },
      returns: { ref: "WriteResult" },
    },
    {
      // Deliberately NOT folded into `delete_files`: wiping a tree and
      // deleting a list of files read the same in code and nothing like the
      // same on an approval card, and one misread approval is a directory
      // nobody gets back.
      name: "delete_directory",
      kind: "write",
      summary:
        "Delete a folder — empty by default, with its contents on request",
      handler: "deleteDirectory",
      params: {
        path: { type: "string" },
        recursive: {
          type: "boolean",
          optional: true,
          default: false,
          description:
            "true deletes everything inside it. Left false, a non-empty folder is refused.",
        },
      },
      returns: { ref: "WriteResult" },
    },
  ],
};
