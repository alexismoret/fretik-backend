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

/**
 * "Does this path exist, and what is it?" for many paths, answered from one
 * listing per PARENT directory.
 *
 * `session.stat` is one cheap command on SFTP and a whole `LIST` of the
 * parent on FTP — the protocol has no stat. So the naive loop over fifty
 * paths in one folder is fifty listings of that folder on every FTP server
 * in existence. Grouping by parent turns that into one.
 *
 * Scoped to a single action, never longer. The cache is read-only against
 * facts our own writes do not change: deleting a file does not turn a
 * sibling into a directory, and an upload conflict is decided before any
 * byte of that batch is written.
 */
const createEntryIndex = (session: FileTransferSession) => {
  const listings = new Map<string, Map<string, RemoteEntry> | null>();

  const listingFor = async (
    directory: string,
  ): Promise<Map<string, RemoteEntry> | null> => {
    const cached = listings.get(directory);
    if (cached !== undefined) return cached;
    let index: Map<string, RemoteEntry> | null;
    try {
      index = new Map(
        (await session.list(directory)).map((entry) => [entry.name, entry]),
      );
    } catch (error) {
      // A directory we cannot list is not a directory whose children we can
      // claim are absent — `null` says UNKNOWN, and every caller has to
      // decide what to do with that rather than read it as "empty".
      if (!isSkippableDirectoryError(error)) throw error;
      index = null;
    }
    listings.set(directory, index);
    return index;
  };

  return {
    /** The entry at `path`, `null` when it is not there or cannot be read. */
    stat: async (path: string): Promise<RemoteEntry | null> => {
      const index = await listingFor(dirname(path));
      if (index === null) return null;
      return index.get(basename(path)) ?? null;
    },
    /**
     * Every name currently in `directory`, or `null` when the listing could
     * not be obtained.
     *
     * The null matters where it is used. A write-only drop folder — very
     * common in EDI, where a partner grants STOR and refuses LIST — answers
     * an error to every listing, and reading that as "no names taken" turns
     * `on_conflict: "fail"` into a silent overwrite of exactly the file the
     * policy exists to protect.
     */
    namesIn: async (directory: string): Promise<Set<string> | null> => {
      const index = await listingFor(directory);
      return index === null ? null : new Set(index.keys());
    },
    /** Forget a directory whose contents this action just changed. */
    invalidate: (directory: string): void => {
      listings.delete(directory);
    },
  };
};

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
 * True when a directory listing failed for a reason that is a fact about
 * THAT directory — it is gone, or this account may not read it — rather
 * than a fact about the connection.
 *
 * The distinction is the whole point: a shared server always has folders the
 * account cannot enter, and a walk that stops at the first one is useless.
 * A dropped control channel is the opposite, and treating it as "nothing
 * here" turns a truncated search into a confident "no such file".
 */
const isSkippableDirectoryError = (error: unknown): boolean => {
  if (isMissingPathError(error)) return true;
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error);
  return (
    message.includes("permission denied") ||
    message.includes("access is denied") ||
    message.includes("not a directory") ||
    // FTP: 530 not logged in for this path, 553 action not taken.
    message.includes("530 ") ||
    message.includes("553 ")
  );
};

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
      if (found.length >= limit || directoriesVisited >= MAX_WALK_DIRECTORIES) {
        break;
      }
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
          // server — skip it and keep walking. Anything else (the control
          // channel dropped, the session died mid-walk) must NOT be
          // swallowed: returning what was found so far as a complete answer
          // tells the agent the tree holds nothing more, which is a
          // different claim from "the search stopped".
          if (isSkippableDirectoryError(error)) continue;
          throw error;
        }

        for (const entry of entries) {
          if (entry.type === "directory") {
            // Bounded by what the walk can still visit, not by what the
            // tree holds: a wide archive (a folder per day for five years)
            // would otherwise queue thousands of paths the loop will never
            // reach, all held in memory for nothing.
            if (next.length + directoriesVisited < MAX_WALK_DIRECTORIES) {
              next.push(entry.path);
            }
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
    const index = createEntryIndex(session);
    const results: Record<string, unknown>[] = [];
    for (const requested of paths) {
      try {
        const resolved = resolveRemotePath(config.rootPath, requested);
        const entry = await index.stat(resolved);
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
    const index = createEntryIndex(session);
    const results: Record<string, unknown>[] = [];
    let totalBytes = 0;

    const refuseOverBudget = (
      requested: string,
      name: string,
      size: number,
    ): Record<string, unknown> => ({
      path: requested,
      name,
      size_bytes: size,
      content_type: contentTypeOf(name),
      error: `Download budget exceeded (${MAX_DOWNLOAD_TOTAL_MB.toString()} MB per call). Fetch this file in a separate call.`,
    });

    for (const requested of paths) {
      const name = basename(requested);
      try {
        const resolved = resolveRemotePath(config.rootPath, requested);

        // Refuse on the ANNOUNCED size before fetching, when the server
        // gives one — the cheapest refusal is the one that transfers
        // nothing. It is only ever an optimisation: an FTP server without
        // SIZE or MLSD announces nothing at all, which is why the sink
        // below carries the ceiling that always holds.
        const announced = (await index.stat(resolved))?.sizeBytes;
        if (
          announced !== undefined &&
          totalBytes + announced > MAX_DOWNLOAD_TOTAL_BYTES
        ) {
          results.push(refuseOverBudget(requested, name, announced));
          continue;
        }

        // The remaining budget IS the per-file ceiling: the sink aborts the
        // data connection the moment a file goes past it, so an unannounced
        // 2 GB file costs one chunk over the cap instead of the whole
        // process's memory.
        const budget = MAX_DOWNLOAD_TOTAL_BYTES - totalBytes;
        let bytes = await session.download(resolved, budget);

        // Verify the transfer against the size the server announced.
        //
        // Measured, not defensive: over 500 downloads from a stock vsftpd on
        // localhost, two came back EMPTY with no error at all — FTP opens a
        // separate data connection per transfer, and on a fast server the
        // whole payload and its FIN can arrive before the control channel's
        // `150` reply is parsed and the reader is attached. Nothing in the
        // protocol reports that; the download simply resolves with nothing.
        //
        // An empty file written to `sandbox_path` is the worst outcome this
        // provider can produce: the agent parses it, finds no rows, and
        // tells the user their partner sent an empty order. So a short read
        // is retried once on a fresh data connection, and a second one is
        // reported as the failure it is rather than returned as content.
        //
        // Only possible where the server announces a size (SIZE, MLSD, or
        // SFTP's attributes — which is everything except a bare FTP server
        // with neither). There, a genuinely empty file is indistinguishable
        // from a lost one, and returning it is the only honest choice.
        if (announced !== undefined && bytes.byteLength !== announced) {
          console.warn(
            `[ftp-sftp] short read on ${name}: announced ${announced.toString()}, got ${bytes.byteLength.toString()} — retrying`,
          );
          bytes = await session.download(resolved, budget);
          if (bytes.byteLength !== announced) {
            results.push({
              path: requested,
              name,
              size_bytes: bytes.byteLength,
              content_type: contentTypeOf(name),
              error: `Incomplete transfer: the server announced ${announced.toString()} bytes and sent ${bytes.byteLength.toString()}, twice. The file was NOT read — try again, or fetch it on its own.`,
            });
            continue;
          }
        }
        totalBytes += bytes.byteLength;
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

/**
 * Decode an upload's payload, refusing anything that is not whole base64.
 *
 * `Buffer.from(s, "base64")` never throws: it decodes up to the first
 * character it does not recognise and returns what it got. A payload
 * truncated in transit, or one an agent built by concatenating chunks
 * wrongly, therefore uploads as a SHORTER file that the server accepts and
 * the partner's parser rejects hours later. Validating the shape first turns
 * that into an error naming the file.
 *
 * Whitespace is stripped before the check rather than rejected: a base64
 * string that arrived wrapped at 76 columns (what MIME and several Python
 * helpers still produce) is perfectly valid data.
 *
 * An empty string is DATA, not an error — see the early return. A caller
 * that forgot the key entirely is a different mistake, and it is caught one
 * level up in `prepareUploads`, where `undefined` is still distinguishable.
 *
 * Exported for its test — a silent truncation is invisible on our side and
 * surfaces as the partner's parser rejecting a file hours later.
 */
export const decodeBase64 = (value: string, label: string): Uint8Array => {
  const compact = value.replace(/\s+/g, "");
  // A zero-byte FILE, not a missing one. Both protocols write one, and
  // partners rely on them — an EDI batch whose empty `.SIR`/`.SIO` members
  // are mandatory, a `.done` flag beside a drop. Refusing here once cost a
  // five-file upload every one of its files for two deliberate empties.
  // Must come first: the shape check below needs at least one character.
  if (compact === "") return new Uint8Array(0);
  if (compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
    throw new Error(
      `"${label}" is not valid base64 — the payload looks truncated or corrupted. Re-encode it with base64.b64encode(...).decode().`,
    );
  }
  return new Uint8Array(Buffer.from(compact, "base64"));
};

/**
 * One entry of an upload batch, ready to write or carrying the reason it
 * never can be.
 *
 * Exactly one of `bytes` / `error` is set.
 */
interface PreparedUpload {
  path: string;
  bytes?: Uint8Array;
  mode?: string;
  error?: string;
}

/**
 * Decode and measure every entry BEFORE a connection is opened: a payload
 * over budget should cost nothing, and a corrupted blob should not be
 * discovered halfway through writing to a partner's server.
 *
 * A bad entry becomes a ROW, not a throw. This used to abort the whole call
 * — five files offered, nothing uploaded, and only the first offender named
 * — which is the one thing this provider promises never to do. The order of
 * the returned list is the caller's, so row N still answers input N.
 *
 * Exported for its test: one entry taking the batch down with it is
 * invisible on our side and surfaces as a partner's folder still empty.
 */
export const prepareUploads = (files: unknown[]): PreparedUpload[] => {
  const prepared: PreparedUpload[] = [];
  let totalBytes = 0;
  for (const file of files) {
    const remotePath = str(prop(file, "remote_path"));
    if (remotePath === "") {
      prepared.push({
        path: "",
        error:
          "This entry has no `remote_path` — give it a destination path including the file name.",
      });
      continue;
    }
    const payload = asString(prop(file, "content_base64"));
    if (payload === undefined) {
      prepared.push({
        path: remotePath,
        // Kept apart from `""` on purpose: an empty string is a zero-byte
        // file the caller meant, a missing key is one they forgot to read.
        error:
          'This entry has no `content_base64` — pass the base64 bytes, or "" for a deliberately empty file.',
      });
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = decodeBase64(payload, remotePath);
    } catch (error) {
      prepared.push({ path: remotePath, error: errorMessage(error) });
      continue;
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_UPLOAD_TOTAL_BYTES) {
      // Still fatal, and deliberately so: the budget is a fact about the
      // CALL, not about one file, and the answer is to split the request
      // rather than to silently drop whichever entry crossed the line.
      throw new Error(
        `Upload budget exceeded (${MAX_UPLOAD_TOTAL_MB.toString()} MB per call). Send the files in several calls.`,
      );
    }
    prepared.push({
      path: remotePath,
      bytes,
      mode: asString(prop(file, "mode")),
    });
  }
  return prepared;
};

/** `report.csv` → `report (1).csv`, preserving the extension. */
const suffixedName = (name: string, attempt: number): string => {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  return `${stem} (${attempt.toString()})${extension}`;
};

/** Attempts before a `rename` conflict policy gives up on a crowded name. */
const MAX_RENAME_ATTEMPTS = 20;

/**
 * Pick a free name beside `path`, against a set of names already taken.
 *
 * Takes the whole directory listing rather than probing candidate by
 * candidate: on FTP each probe is a full `LIST` of the parent, so twenty
 * probes for one renamed file is twenty listings of the same folder.
 *
 * Exported for its test — the `rename` conflict policy exists to never
 * overwrite a partner's file, and a ladder that returns a taken name does
 * the one thing the policy was chosen to prevent.
 */
export const freeNameIn = (taken: Set<string>, name: string): string | null => {
  for (let attempt = 1; attempt <= MAX_RENAME_ATTEMPTS; attempt += 1) {
    const candidate = suffixedName(name, attempt);
    if (!taken.has(candidate)) return candidate;
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

  const prepared = prepareUploads(files);

  // Nothing decodable: answer with the reasons and skip the handshake. A
  // connection error here would replace N precise per-file messages with one
  // about a socket, which is how an agent concludes the server is broken.
  if (prepared.every((file) => file.bytes === undefined)) {
    return prepared.map((file) => ({
      path: file.path,
      ok: false,
      error: file.error ?? "This file could not be prepared.",
    }));
  }

  // Only entries that will actually be written can be `chmod`ed, so a
  // failed one must not buy the batch a `describe()` round-trip.
  const wantsPermissions = prepared.some((file) => file.mode !== undefined);

  return withSession(config, async (session) => {
    // Only asked when some file carries a `mode` — on FTP `describe()` costs
    // a `PWD`, a `FEAT` and a `SYST`, and an upload that sets no permissions
    // has no use for the answer.
    const supportsPermissions = wantsPermissions
      ? (await session.describe()).supportsPermissions
      : false;
    const index = createEntryIndex(session);
    const results: Record<string, unknown>[] = [];
    const ensured = new Set<string>();
    // Names this batch has itself placed, per directory. Two files landing
    // on the same name in one call would otherwise both read the directory
    // as free and the second would overwrite the first under a `rename`
    // policy that exists to prevent exactly that.
    const claimed = new Map<string, Set<string>>();

    for (const file of prepared) {
      // Destructured rather than read through `file.bytes` below: the
      // narrowing has to survive several `await`s, and a property's does
      // not. Rejected before the connection opened — keep its place so row
      // N still answers input N.
      const { bytes } = file;
      if (bytes === undefined) {
        results.push({
          path: file.path,
          ok: false,
          error: file.error ?? "This file could not be prepared.",
        });
        continue;
      }
      try {
        let target = resolveRemotePath(config.rootPath, file.path);
        const parent = dirname(target);

        if (createDirectories) {
          // One `mkdir -p` per distinct parent, not per file: a batch
          // dropping 20 files in one folder should not send 20 of them.
          if (parent !== "." && parent !== "/" && !ensured.has(parent)) {
            await session.ensureDirectory(parent);
            ensured.add(parent);
            // The directory may not have existed when the index read it.
            index.invalidate(parent);
          }
        }

        if (onConflict !== "replace") {
          const existing = await index.namesIn(parent);
          if (existing === null) {
            // Refusing beats guessing: `fail` and `rename` are both promises
            // about a file that may already be there, and neither can be
            // kept without seeing the folder. `replace` needs no listing and
            // still works on such a server.
            results.push({
              path: file.path,
              ok: false,
              error:
                'This folder cannot be listed, so "fail" and "rename" cannot tell whether the file already exists. Use on_conflict="replace" if overwriting is intended.',
            });
            continue;
          }
          const taken = new Set([...existing, ...(claimed.get(parent) ?? [])]);
          if (taken.has(basename(target))) {
            if (onConflict === "fail") {
              results.push({
                path: file.path,
                ok: false,
                error: "A file already exists at this path.",
              });
              continue;
            }
            const free = freeNameIn(taken, basename(target));
            if (free === null) {
              results.push({
                path: file.path,
                ok: false,
                error: `A file already exists at this path and ${MAX_RENAME_ATTEMPTS.toString()} renamed variants are taken.`,
              });
              continue;
            }
            target = parent === "." ? free : `${parent}/${free}`;
          }
          const claimedHere = claimed.get(parent) ?? new Set<string>();
          claimedHere.add(basename(target));
          claimed.set(parent, claimedHere);
        }

        await session.upload(target, bytes);
        if (file.mode !== undefined && supportsPermissions) {
          await session.chmod(target, file.mode);
        }
        results.push({
          path: toDisplayPath(config.rootPath, target),
          ok: true,
          // Say so rather than failing the upload over it: the bytes did
          // land, and a caller that asked for `0644` on a protocol with no
          // permission model deserves the fact, not an error.
          ...(file.mode !== undefined && !supportsPermissions
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
    const index = createEntryIndex(session);
    const results: Record<string, unknown>[] = [];
    for (const requested of paths) {
      try {
        const resolved = resolveRemotePath(config.rootPath, requested);
        // A directory reaching the file deleter is an agent mistake, and
        // the protocols disagree on what they do with one (SFTP refuses,
        // some FTP servers happily unlink the entry). Refusing here makes
        // the behaviour the same everywhere and keeps the destructive path
        // behind the action whose approval card says "folder".
        const entry = await index.stat(resolved);
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
