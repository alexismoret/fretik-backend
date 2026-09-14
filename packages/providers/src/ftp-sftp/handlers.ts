import {
  arr,
  asString,
  bool,
  num,
  prop,
  str,
  strArray,
} from "@fretik/shared/external-apps/json-access";
import type {
  ProviderHandlerContext,
  ProviderHandlers,
} from "@fretik/shared/external-apps/provider-types";
import type { FileTransferSession, RemoteEntry } from "./client";
import { basename, dirname, isMissingPathError, withSession } from "./client";
import { parseFileTransferConfig } from "./config";
import {
  MAX_BATCH_PATHS,
  MAX_DOWNLOAD_FILES,
  MAX_DOWNLOAD_TOTAL_BYTES,
  MAX_DOWNLOAD_TOTAL_MB,
  MAX_UPLOAD_FILES,
  MAX_UPLOAD_TOTAL_BYTES,
  MAX_UPLOAD_TOTAL_MB,
  MAX_WALK_DIRECTORIES,
} from "./limits";
import { matchesPattern, resolveRemotePath, toDisplayPath } from "./paths";

/**
 * Action handlers for the FTP/SFTP provider.
 *
 * Three rules hold across all of them, and they are what make this provider
 * usable rather than merely complete:
 *
 * 1. **One connection per action, many operations inside it.** The handshake
 *    is the expensive part of both protocols (a TLS negotiation or an SSH
 *    key exchange), so every action that can take a list does — 20 files in
 *    one `download_files` is one handshake, not twenty.
 *
 * 2. **Per-item results, never all-or-nothing.** A batch that stops at the
 *    first bad path forces the agent to bisect its own request. Each bulk
 *    action returns one row per input with `ok` / `error`, so a partner that
 *    removed one of twelve files costs one row, not the run.
 *
 * 3. **Paths in and out are the connection's own.** `resolveRemotePath`
 *    applies the pinned root and refuses to climb out of it;
 *    `toDisplayPath` strips it back off everything returned, so the agent
 *    only ever sees and sends paths in one coordinate system.
 */

/** Resolve the connection's config once per action. */
const configOf = (ctx: ProviderHandlerContext) =>
  parseFileTransferConfig(ctx.credentials, ctx.connection_config);

/** Project one entry back into the connection's coordinate system. */
const toAgentEntry = (
  rootPath: string,
  entry: RemoteEntry,
): Record<string, unknown> => ({
  name: entry.name,
  path: toDisplayPath(rootPath, entry.path),
  type: entry.type,
  size_bytes: entry.sizeBytes,
  modified_at: entry.modifiedAt,
  mode: entry.mode,
  owner: entry.owner,
  group: entry.group,
});

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Refuse an oversized batch at the boundary instead of half-running it.
 *
 * Deliberately a throw, not a per-item error: the caller asked for something
 * the action cannot do at all, and discovering that after 200 of 500 files
 * have moved is worse than not starting.
 */
const assertBatchSize = (count: number, max: number, what: string): void => {
  if (count > max) {
    throw new Error(
      `Too many ${what} in one call: ${count.toString()} (max ${max.toString()}). Split the request.`,
    );
  }
  if (count === 0) {
    throw new Error(`No ${what} given.`);
  }
};

// ── Discovery ─────────────────────────────────────────────────────────

const getServerInfo = async (
  _args: Record<string, unknown>,
  ctx: ProviderHandlerContext,
): Promise<unknown> => {
  const config = configOf(ctx);
  return withSession(config, async (session) => {
    const capabilities = await session.describe();
    return {
      protocol: config.protocol,
      host: config.host,
      working_directory: toDisplayPath(
        config.rootPath,
        capabilities.workingDirectory,
      ),
      root_path: config.rootPath === "" ? undefined : config.rootPath,
      supports_modified_time: capabilities.supportsModifiedTime,
      supports_size: capabilities.supportsSize,
      supports_permissions: capabilities.supportsPermissions,
      server_software: capabilities.serverSoftware,
    };
  });
};

const sortEntries = (entries: RemoteEntry[], sort: string): RemoteEntry[] => {
  const sorted = [...entries];
  if (sort === "modified_desc") {
    sorted.sort((a, b) =>
      (b.modifiedAt ?? "").localeCompare(a.modifiedAt ?? ""),
    );
  } else if (sort === "size_desc") {
    sorted.sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0));
  } else {
    sorted.sort((a, b) => a.name.localeCompare(b.name));
  }
  return sorted;
};

const listDirectory = async (
  args: Record<string, unknown>,
  ctx: ProviderHandlerContext,
): Promise<unknown> => {
  const config = configOf(ctx);
  const path = resolveRemotePath(config.rootPath, str(args.path));
  const pattern = asString(args.pattern);
  const includeDirectories = bool(args.include_directories, true);
  const limit = num(args.limit, 200);

  return withSession(config, async (session) => {
    const entries = await session.list(path);
    const filtered = entries.filter((entry) => {
      if (!includeDirectories && entry.type === "directory") return false;
      // A pattern filters FILES. Hiding folders that do not match would
      // make `*.csv` on a tree look like an empty server, and the agent
      // would have no way to navigate to the files it asked for.
      if (pattern === undefined || entry.type === "directory") return true;
      return matchesPattern(entry.name, pattern);
    });
    return sortEntries(filtered, str(args.sort, "name"))
      .slice(0, limit)
      .map((entry) => toAgentEntry(config.rootPath, entry));
  });
};

const findFiles = async (
  args: Record<string, unknown>,
  ctx: ProviderHandlerContext,
): Promise<unknown> => {
  const config = configOf(ctx);
  const root = resolveRemotePath(config.rootPath, str(args.path));
  const pattern = str(args.pattern, "*");
  const maxDepth = num(args.max_depth, 3);
  const limit = num(args.limit, 200);
  const modifiedAfter = asString(args.modified_after);

  return withSession(config, async (session) => {
    const found: RemoteEntry[] = [];
    // Breadth-first: the files an agent wants are overwhelmingly near the
    // top of a drop folder, so a shallow sweep that stops at `limit` beats
    // a depth-first dive into the first subfolder it meets.
    let frontier = [root];
    let directoriesVisited = 0;

    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
      const next: string[] = [];
      for (const directory of frontier) {
        if (found.length >= limit) break;
        if (directoriesVisited >= MAX_WALK_DIRECTORIES) break;
        directoriesVisited += 1;

        let entries: RemoteEntry[];
        try {
          entries = await session.list(directory);
        } catch (error) {
          // A folder the account cannot read is a normal fact of a shared
          // server, not a reason to abandon the search.
          if (isMissingPathError(error)) continue;
          continue;
        }

        for (const entry of entries) {
          if (entry.type === "directory") {
            next.push(entry.path);
            continue;
          }
          if (!matchesPattern(entry.name, pattern)) continue;
          if (
            modifiedAfter !== undefined &&
            entry.modifiedAt !== undefined &&
            entry.modifiedAt <= modifiedAfter
          ) {
            continue;
          }
          found.push(entry);
          if (found.length >= limit) break;
        }
      }
      frontier = next;
    }

    return found
      .slice(0, limit)
      .map((entry) => toAgentEntry(config.rootPath, entry));
  });
};

const getEntries = async (
  args: Record<string, unknown>,
  ctx: ProviderHandlerContext,
): Promise<unknown> => {
  const config = configOf(ctx);
  const paths = strArray(args.paths);
  assertBatchSize(paths.length, MAX_BATCH_PATHS, "paths");

  return withSession(config, async (session) => {
    const results: Record<string, unknown>[] = [];
    for (const requested of paths) {
      try {
        const resolved = resolveRemotePath(config.rootPath, requested);
        const entry = await session.stat(resolved);
        results.push({
          path: requested,
          exists: entry !== null,
          type: entry?.type,
          size_bytes: entry?.sizeBytes,
          modified_at: entry?.modifiedAt,
          mode: entry?.mode,
        });
      } catch (error) {
        // "Cannot look it up" is not "it is not there", and reporting the
        // second for the first is how an agent decides to overwrite a file
        // it never saw.
        results.push({
          path: requested,
          exists: false,
          error: errorMessage(error),
        });
      }
    }
    return results;
  });
};

// ── Transfers ─────────────────────────────────────────────────────────

/**
 * Guess a content type from the extension.
 *
 * Neither protocol carries one — FTP knows ASCII vs binary and SFTP knows
 * nothing at all — so the alternative is `application/octet-stream` on every
 * file, which costs the agent the one hint it uses to pick a parser.
 */
const CONTENT_TYPES: Record<string, string> = {
  csv: "text/csv",
  txt: "text/plain",
  xml: "application/xml",
  json: "application/json",
  edi: "application/edi-x12",
  edifact: "application/edifact",
  pdf: "application/pdf",
  zip: "application/zip",
  gz: "application/gzip",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

const contentTypeOf = (name: string): string => {
  const extension = name.includes(".")
    ? (name.split(".").pop() ?? "").toLowerCase()
    : "";
  return CONTENT_TYPES[extension] ?? "application/octet-stream";
};

const downloadFiles = async (
  args: Record<string, unknown>,
  ctx: ProviderHandlerContext,
): Promise<unknown> => {
  const config = configOf(ctx);
  const paths = strArray(args.paths);
  assertBatchSize(paths.length, MAX_DOWNLOAD_FILES, "files");

  return withSession(config, async (session) => {
    const results: Record<string, unknown>[] = [];
    let totalBytes = 0;

    for (const requested of paths) {
      const name = basename(requested);
      try {
        const resolved = resolveRemotePath(config.rootPath, requested);
        const bytes = await session.download(resolved);
        totalBytes += bytes.byteLength;
        if (totalBytes > MAX_DOWNLOAD_TOTAL_BYTES) {
          // Stop at the file that crossed the line rather than truncating
          // it: half a file written to `sandbox_path` is a file the agent
          // will happily parse and silently get wrong.
          results.push({
            path: requested,
            name,
            size_bytes: bytes.byteLength,
            content_type: contentTypeOf(name),
            error: `Download budget exceeded (${MAX_DOWNLOAD_TOTAL_MB.toString()} MB per call). Fetch this file in a separate call.`,
          });
          totalBytes -= bytes.byteLength;
          continue;
        }
        results.push({
          path: requested,
          name,
          size_bytes: bytes.byteLength,
          content_type: contentTypeOf(name),
          // Spilled to `sandbox_path` by the SDK runtime before the agent
          // sees it — the base64 never enters the model's context.
          content_base64: Buffer.from(bytes).toString("base64"),
        });
      } catch (error) {
        results.push({
          path: requested,
          name,
          size_bytes: 0,
          content_type: contentTypeOf(name),
          error: errorMessage(error),
        });
      }
    }
    return results;
  });
};

/** `report.csv` → `report (1).csv`, preserving the extension. */
const suffixed = (path: string, attempt: number): string => {
  const directory = dirname(path);
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  const renamed = `${stem} (${attempt.toString()})${extension}`;
  return directory === "." ? renamed : `${directory}/${renamed}`;
};

/** Find a free path next to `path`, or null when the neighbourhood is full. */
const freePathNear = async (
  session: FileTransferSession,
  path: string,
): Promise<string | null> => {
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const candidate = suffixed(path, attempt);
    if ((await session.stat(candidate)) === null) return candidate;
  }
  return null;
};

const uploadFiles = async (
  args: Record<string, unknown>,
  ctx: ProviderHandlerContext,
): Promise<unknown> => {
  const config = configOf(ctx);
  const files = arr(args.files);
  assertBatchSize(files.length, MAX_UPLOAD_FILES, "files");
  const onConflict = str(args.on_conflict, "replace");
  const createDirectories = bool(args.create_directories, true);

  // Decode and measure everything BEFORE opening a connection: a payload
  // over budget should cost nothing, and a malformed base64 blob should not
  // be discovered halfway through writing to a partner's server.
  const decoded: { path: string; bytes: Uint8Array; mode?: string }[] = [];
  let totalBytes = 0;
  for (const file of files) {
    const remotePath = str(prop(file, "remote_path"));
    if (remotePath === "") {
      throw new Error("Every uploaded file needs a `remote_path`.");
    }
    const bytes = Buffer.from(str(prop(file, "content_base64")), "base64");
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_UPLOAD_TOTAL_BYTES) {
      throw new Error(
        `Upload budget exceeded (${MAX_UPLOAD_TOTAL_MB.toString()} MB per call). Send the files in several calls.`,
      );
    }
    decoded.push({
      path: remotePath,
      bytes: new Uint8Array(bytes),
      mode: asString(prop(file, "mode")),
    });
  }

  return withSession(config, async (session) => {
    const capabilities = await session.describe();
    const results: Record<string, unknown>[] = [];
    const ensured = new Set<string>();

    for (const file of decoded) {
      try {
        let target = resolveRemotePath(config.rootPath, file.path);

        if (createDirectories) {
          const parent = dirname(target);
          // One `mkdir -p` per distinct parent, not per file: a batch
          // dropping 20 files in one folder should not send 20 of them.
          if (parent !== "." && parent !== "/" && !ensured.has(parent)) {
            await session.ensureDirectory(parent);
            ensured.add(parent);
          }
        }

        if (onConflict !== "replace") {
          const existing = await session.stat(target);
          if (existing !== null) {
            if (onConflict === "fail") {
              results.push({
                path: file.path,
                ok: false,
                error: "A file already exists at this path.",
              });
              continue;
            }
            const free = await freePathNear(session, target);
            if (free === null) {
              results.push({
                path: file.path,
                ok: false,
                error:
                  "A file already exists at this path and 20 renamed variants are taken.",
              });
              continue;
            }
            target = free;
          }
        }

        await session.upload(target, file.bytes);
        if (file.mode !== undefined && capabilities.supportsPermissions) {
          await session.chmod(target, file.mode);
        }
        results.push({
          path: toDisplayPath(config.rootPath, target),
          ok: true,
          // Say so rather than failing the upload over it: the bytes did
          // land, and a caller that asked for `0644` on a protocol with no
          // permission model deserves the fact, not an error.
          ...(file.mode !== undefined && !capabilities.supportsPermissions
            ? {
                error:
                  "Uploaded, but permissions were not applied — this protocol has no permission model. Use SFTP to set them.",
              }
            : {}),
        });
      } catch (error) {
        results.push({
          path: file.path,
          ok: false,
          error: errorMessage(error),
        });
      }
    }
    return results;
  });
};

// ── Housekeeping ──────────────────────────────────────────────────────

const moveEntries = async (
  args: Record<string, unknown>,
  ctx: ProviderHandlerContext,
): Promise<unknown> => {
  const config = configOf(ctx);
  const moves = arr(args.moves);
  assertBatchSize(moves.length, MAX_BATCH_PATHS, "moves");
  const createDirectories = bool(args.create_directories, true);

  return withSession(config, async (session) => {
    const results: Record<string, unknown>[] = [];
    const ensured = new Set<string>();

    for (const move of moves) {
      const fromPath = str(prop(move, "from_path"));
      const toPath = str(prop(move, "to_path"));
      try {
        if (fromPath === "" || toPath === "") {
          throw new Error("Each move needs both `from_path` and `to_path`.");
        }
        const from = resolveRemotePath(config.rootPath, fromPath);
        const to = resolveRemotePath(config.rootPath, toPath);
        if (createDirectories) {
          const parent = dirname(to);
          if (parent !== "." && parent !== "/" && !ensured.has(parent)) {
            await session.ensureDirectory(parent);
            ensured.add(parent);
          }
        }
        await session.rename(from, to);
        results.push({ path: toPath, ok: true });
      } catch (error) {
        results.push({
          path: fromPath,
          ok: false,
          error: errorMessage(error),
        });
      }
    }
    return results;
  });
};

const deleteFiles = async (
  args: Record<string, unknown>,
  ctx: ProviderHandlerContext,
): Promise<unknown> => {
  const config = configOf(ctx);
  const paths = strArray(args.paths);
  assertBatchSize(paths.length, MAX_BATCH_PATHS, "paths");

  return withSession(config, async (session) => {
    const results: Record<string, unknown>[] = [];
    for (const requested of paths) {
      try {
        const resolved = resolveRemotePath(config.rootPath, requested);
        // A directory reaching the file deleter is an agent mistake, and
        // the protocols disagree on what they do with one (SFTP refuses,
        // some FTP servers happily unlink the entry). Refusing here makes
        // the behaviour the same everywhere and keeps the destructive path
        // behind the action whose approval card says "folder".
        const entry = await session.stat(resolved);
        if (entry !== null && entry.type === "directory") {
          throw new Error(
            "This path is a folder — use delete_directory to remove it.",
          );
        }
        await session.removeFile(resolved);
        results.push({ path: requested, ok: true });
      } catch (error) {
        results.push({
          path: requested,
          ok: false,
          error: errorMessage(error),
        });
      }
    }
    return results;
  });
};

const createDirectory = async (
  args: Record<string, unknown>,
  ctx: ProviderHandlerContext,
): Promise<unknown> => {
  const config = configOf(ctx);
  const requested = str(args.path);
  if (requested === "") throw new Error("`path` is required.");
  const mode = asString(args.mode);

  return withSession(config, async (session) => {
    const resolved = resolveRemotePath(config.rootPath, requested);
    // Always creates missing parents. A non-recursive variant exists only
    // to fail on a path the caller wanted anyway.
    await session.ensureDirectory(resolved);
    if (mode !== undefined) {
      const capabilities = await session.describe();
      if (capabilities.supportsPermissions) await session.chmod(resolved, mode);
    }
    return { path: requested, ok: true };
  });
};

const deleteDirectory = async (
  args: Record<string, unknown>,
  ctx: ProviderHandlerContext,
): Promise<unknown> => {
  const config = configOf(ctx);
  const requested = str(args.path);
  if (requested === "") throw new Error("`path` is required.");
  const recursive = bool(args.recursive, false);

  return withSession(config, async (session) => {
    const resolved = resolveRemotePath(config.rootPath, requested);
    await session.removeDirectory(resolved, recursive);
    return { path: requested, ok: true };
  });
};

export const ftpSftpHandlers: ProviderHandlers = {
  getServerInfo,
  listDirectory,
  findFiles,
  getEntries,
  downloadFiles,
  uploadFiles,
  moveEntries,
  deleteFiles,
  createDirectory,
  deleteDirectory,
};
