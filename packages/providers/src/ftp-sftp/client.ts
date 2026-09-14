import { Client as FtpClient } from "basic-ftp";
import { Readable, Writable } from "node:stream";
import SftpClient from "ssh2-sftp-client";

/**
 * One protocol-agnostic file-transfer session over two very different
 * libraries:
 *
 *  - **SFTP** → `ssh2-sftp-client` (a promise wrapper over `ssh2`). SFTP is
 *    a subsystem of SSH, not FTP with TLS bolted on — different transport,
 *    different auth (keys), different metadata (POSIX mode/uid/gid).
 *  - **FTP / FTPS** → `basic-ftp` (zero dependencies, explicit + implicit
 *    TLS, passive only — active mode is unreachable from behind NAT, which
 *    is every deployment we will ever run in).
 *
 * The point of this file is that `handlers.ts` never branches on protocol.
 * A user connects "a file server"; the agent lists, downloads and uploads
 * with one vocabulary, and the two protocols' metadata are normalized into
 * one `RemoteEntry`. Where a protocol genuinely cannot answer (FTP has no
 * portable permission bits, no symlink target, no owner), the field comes
 * back absent rather than invented — and `describe()` tells the agent which
 * of those to expect BEFORE it relies on one.
 *
 * Lifecycle: ONE connection per action. FTP is a stateful, single-command
 * protocol and SSH channels are per-connection, so a pooled session shared
 * across tenants is not a thing that can exist here. That cost is exactly
 * why every bulk action takes a LIST: one handshake amortized over N files
 * instead of N handshakes.
 */

export type FileTransferProtocol = "sftp" | "ftp" | "ftps" | "ftps-implicit";

export interface FileTransferConfig {
  protocol: FileTransferProtocol;
  host: string;
  port: number;
  username: string;
  /** Password auth (every protocol). Absent when authenticating by key. */
  password?: string;
  /** SFTP only — PEM / OpenSSH private key. */
  privateKey?: string;
  /** SFTP only — passphrase protecting `privateKey`. */
  passphrase?: string;
  /**
   * SFTP only — expected host key fingerprint. Absent = accept whatever the
   * server presents (the default every FTP client in this space ships with;
   * see `verifyHostKey`).
   */
  hostFingerprint?: string;
  /** FTPS only — accept a self-signed / internal-CA certificate. */
  allowSelfSignedCert: boolean;
  /**
   * Every path the agent passes is resolved against this. Empty = the
   * account's own landing directory.
   */
  rootPath: string;
}

/** One directory entry, normalized across both protocols. */
export interface RemoteEntry {
  name: string;
  /** Absolute server-side path, root-relative segments already resolved. */
  path: string;
  type: "file" | "directory" | "symlink";
  sizeBytes?: number;
  modifiedAt?: string;
  /** Octal permission bits, e.g. `0644`. SFTP always; FTP when parsable. */
  mode?: string;
  owner?: string;
  group?: string;
}

/** What the connected server can actually answer — see `describe()`. */
export interface ServerCapabilities {
  workingDirectory: string;
  supportsModifiedTime: boolean;
  supportsSize: boolean;
  supportsPermissions: boolean;
  serverSoftware?: string;
}

export interface FileTransferSession {
  describe(): Promise<ServerCapabilities>;
  list(path: string): Promise<RemoteEntry[]>;
  stat(path: string): Promise<RemoteEntry | null>;
  /**
   * Read a file's bytes, refusing to buffer more than `maxBytes`.
   *
   * The cap is enforced DURING the transfer, not after it: this process
   * holds the whole file in memory, so a check that runs once the download
   * returns has already spent whatever the server chose to send. Neither
   * protocol makes the size trustworthy in advance — FTP without SIZE or
   * MLSD reports nothing at all — so the only ceiling that always holds is
   * the one the sink itself applies.
   */
  download(path: string, maxBytes: number): Promise<Uint8Array>;
  upload(path: string, bytes: Uint8Array): Promise<void>;
  /** `mkdir -p`: creates missing parents, succeeds when it already exists. */
  ensureDirectory(path: string): Promise<void>;
  removeFile(path: string): Promise<void>;
  removeDirectory(path: string, recursive: boolean): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** No-op on a server with no permission model — callers check first. */
  chmod(path: string, mode: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * Abandon a handshake, or a transfer that has gone quiet, after this long.
 *
 * `basic-ftp` applies its constructor timeout to the control AND data
 * connections, so this doubles as the stall detector there; `ssh2` takes it
 * as `readyTimeout` for the handshake only, which is why the whole-action
 * deadline below exists on top.
 */
const CONNECT_TIMEOUT_MS = 20_000;

/**
 * Wall clock one action may spend, start to finish.
 *
 * This is NOT a nice-to-have: `@fretik/api` serves with `idleTimeout: 30`,
 * and Bun applies that to a request whose HANDLER is slow, not merely to an
 * idle socket — measured, a handler sleeping 6 s behind `idleTimeout: 3` has
 * its connection closed at 4 s. So an action running past ~30 s does not
 * return an error, it loses the connection, and the sandbox SDK reports
 * "backend unreachable".
 *
 * On an upload that is the worst possible failure: the bytes reached the
 * partner's server, the agent was told the call failed, and a retry drops
 * the file a second time. Finishing first with a message the agent can act
 * on — fetch fewer files, send them in smaller batches — is the only
 * outcome that stays truthful.
 *
 * Five seconds of headroom under the 30, for the dispatch either side.
 */
const ACTION_DEADLINE_MS = 25_000;

export class TransferDeadlineError extends Error {
  constructor(seconds: number) {
    super(
      `The file server did not finish within ${seconds.toString()}s. Ask for fewer files, or smaller ones, in one call — a single very large transfer belongs in a scheduled workflow rather than a chat turn.`,
    );
    this.name = "TransferDeadlineError";
  }
}

/**
 * Open a session, run `fn` under the action deadline, close it whatever
 * happens.
 *
 * The close is best-effort on purpose: a server that drops the control
 * channel after the last command makes `close()` throw, and letting that
 * mask a successful transfer would turn "your 12 files uploaded" into an
 * error the user cannot act on. It also runs on the deadline path, which is
 * what actually releases the socket — an abandoned promise would otherwise
 * leave the connection open until the server timed it out, and an account
 * limited to one session could not reconnect in the meantime.
 */
export const withSession = async <T>(
  config: FileTransferConfig,
  fn: (session: FileTransferSession) => Promise<T>,
): Promise<T> => {
  const session = await withDeadline(
    openSession(config),
    // A handshake has its own, shorter timeout; this only catches a server
    // that accepts the socket and then says nothing at all.
    CONNECT_TIMEOUT_MS + 5_000,
    () => undefined,
  );
  try {
    return await withDeadline(fn(session), ACTION_DEADLINE_MS, () => {
      // Tear the session down as the deadline fires rather than waiting for
      // the `finally` — the pending operation keeps a reference to it, and
      // on a one-session account the next call needs this socket gone.
      void session.close().catch(() => undefined);
    });
  } finally {
    await session.close().catch(() => undefined);
  }
};

/**
 * Reject with a `TransferDeadlineError` if `work` has not settled in time.
 *
 * `onTimeout` runs before the rejection so the caller can release whatever
 * the abandoned promise is still holding — neither library exposes an
 * AbortSignal, so closing the session is the only way to stop the work.
 */
const withDeadline = async <T>(
  work: Promise<T>,
  ms: number,
  onTimeout: () => void,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          onTimeout();
          reject(new TransferDeadlineError(Math.round(ms / 1000)));
        }, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

export const openSession = async (
  config: FileTransferConfig,
): Promise<FileTransferSession> =>
  config.protocol === "sftp"
    ? await openSftpSession(config)
    : await openFtpSession(config);

// ── SFTP ──────────────────────────────────────────────────────────────

/**
 * Compare the server's host key against the pinned fingerprint.
 *
 * Unpinned is the default and it is a deliberate, stated trade-off rather
 * than an oversight: a hosted product cannot know a customer's host key
 * ahead of the first connection, and every comparable integration (n8n,
 * Make, Zapier's SFTP) connects without one. What we add is the CHOICE —
 * a user who pastes a fingerprint gets a connection that refuses to talk to
 * anything else, which is the only configuration that survives a DNS or
 * routing compromise.
 *
 * Accepts the two spellings people actually have: OpenSSH's base64 SHA256
 * (`SHA256:abc…`, what `ssh-keyscan | ssh-keygen -lf` prints) and a hex
 * MD5 with or without colons (what older tooling shows).
 */
const verifyHostKey = (expected: string, key: Buffer): boolean => {
  const normalized = expected.trim().toLowerCase();
  const sha256 = new Bun.CryptoHasher("sha256").update(key).digest("base64");
  // OpenSSH prints the digest unpadded.
  const sha256Normalized = sha256.replace(/=+$/, "").toLowerCase();
  if (
    normalized.replace(/^sha256:/, "").replace(/=+$/, "") === sha256Normalized
  ) {
    return true;
  }
  const md5 = new Bun.CryptoHasher("md5").update(key).digest("hex");
  return normalized.replace(/^md5:/, "").replace(/:/g, "") === md5;
};

const openSftpSession = async (
  config: FileTransferConfig,
): Promise<FileTransferSession> => {
  const client = new SftpClient("fretik");
  const fingerprint = config.hostFingerprint;

  await client.connect({
    host: config.host,
    port: config.port,
    username: config.username,
    ...(config.password !== undefined ? { password: config.password } : {}),
    ...(config.privateKey !== undefined
      ? { privateKey: config.privateKey }
      : {}),
    ...(config.passphrase !== undefined
      ? { passphrase: config.passphrase }
      : {}),
    readyTimeout: CONNECT_TIMEOUT_MS,
    ...(fingerprint !== undefined && fingerprint.length > 0
      ? { hostVerifier: (key: Buffer) => verifyHostKey(fingerprint, key) }
      : {}),
  });

  return {
    describe: async () => ({
      workingDirectory: await client.cwd(),
      // SFTP carries POSIX attributes on every entry — no probing needed.
      supportsModifiedTime: true,
      supportsSize: true,
      supportsPermissions: true,
    }),

    list: async (path) => {
      const entries = await client.list(path);
      return entries.map((entry) => ({
        name: entry.name,
        path: joinPath(path, entry.name),
        type: sftpEntryType(entry.type),
        sizeBytes: entry.size,
        modifiedAt: toIso(entry.modifyTime),
        // A LISTING carries the `rwx` triplets, not the numeric mode a
        // `stat` returns — so the octal form is reassembled here rather
        // than costing one extra round-trip per entry.
        mode: modeFromRights(entry.rights),
        owner: String(entry.owner),
        group: String(entry.group),
      }));
    },

    stat: async (path) => {
      let stats;
      try {
        stats = await client.stat(path);
      } catch (error) {
        if (isMissingPathError(error)) return null;
        throw error;
      }
      return {
        name: basename(path),
        path,
        type: stats.isDirectory
          ? "directory"
          : stats.isSymbolicLink
            ? "symlink"
            : "file",
        sizeBytes: stats.size,
        modifiedAt: toIso(stats.modifyTime),
        mode: octalMode(stats.mode),
        owner: String(stats.uid),
        group: String(stats.gid),
      };
    },

    download: async (path, maxBytes) => {
      // `client.get(path)` with no destination concatenates the whole file
      // into one Buffer with nothing watching the total. Handing it a sink
      // makes the ceiling part of the transfer instead of a check that
      // arrives once the memory is already spent.
      const sink = createBoundedSink(path, maxBytes);
      await client.get(path, sink.stream);
      return sink.bytes();
    },

    upload: async (path, bytes) => {
      await client.put(Buffer.from(bytes), path);
    },

    ensureDirectory: async (path) => {
      await client.mkdir(path, true);
    },

    removeFile: async (path) => {
      await client.delete(path);
    },

    removeDirectory: async (path, recursive) => {
      await client.rmdir(path, recursive);
    },

    rename: async (from, to) => {
      await client.rename(from, to);
    },

    chmod: async (path, mode) => {
      await client.chmod(path, Number.parseInt(mode, 8));
    },

    close: async () => {
      await client.end();
    },
  };
};

/** ssh2-sftp-client reports the long-listing type character. */
const sftpEntryType = (type: string): RemoteEntry["type"] =>
  type === "d" ? "directory" : type === "l" ? "symlink" : "file";

/**
 * Render the permission bits of a POSIX mode as 4 octal digits.
 *
 * The mask matters: `stat.mode` carries the file type in its high bits
 * (`0o100644` for a regular file), and printing it raw would show a
 * plausible-looking `100644` that no `chmod` accepts.
 */
const octalMode = (mode: number | undefined): string | undefined =>
  mode === undefined ? undefined : (mode & 0o7777).toString(8).padStart(4, "0");

/** `{ user: "rw", group: "r", other: "r" }` → `0644`. */
const modeFromRights = (rights: {
  user: string;
  group: string;
  other: string;
}): string | undefined => {
  const digit = (triplet: string): number =>
    (triplet.includes("r") ? 4 : 0) +
    (triplet.includes("w") ? 2 : 0) +
    (triplet.includes("x") ? 1 : 0);
  return `0${digit(rights.user).toString()}${digit(rights.group).toString()}${digit(rights.other).toString()}`;
};

// ── FTP / FTPS ────────────────────────────────────────────────────────

const openFtpSession = async (
  config: FileTransferConfig,
): Promise<FileTransferSession> => {
  const client = new FtpClient(CONNECT_TIMEOUT_MS);

  await client.access({
    host: config.host,
    port: config.port,
    user: config.username,
    password: config.password ?? "",
    // `true` negotiates TLS with AUTH TLS after connecting on the plain
    // port; `"implicit"` wraps the socket in TLS from byte zero (the
    // legacy port-990 scheme a lot of EDI servers still run).
    secure:
      config.protocol === "ftps"
        ? true
        : config.protocol === "ftps-implicit"
          ? "implicit"
          : false,
    ...(config.allowSelfSignedCert
      ? { secureOptions: { rejectUnauthorized: false } }
      : {}),
  });

  // Probed once at connect and reused: an FTP server's FEAT list is what
  // decides whether a modification time or a byte count can be trusted, and
  // the answer is per-server, not per-protocol.
  const features = await client
    .features()
    .catch(() => new Map<string, string>());
  const has = (command: string) => features.has(command);

  // RFC 959 predates Unicode, and the FEAT list does not settle the
  // question: vsftpd advertises `UTF8` only with `utf8_filesystem=YES`, so
  // the most common Unix FTP server on the internet serves UTF-8 filenames
  // while reporting no UTF-8 support at all. Measured here — a `Facture
  // été.pdf` on stock vsftpd came back as `Facture Ã©tÃ©.pdf` the moment
  // the FEAT flag was trusted.
  //
  // So the socket is put on latin-1 and treated as what it actually is: a
  // byte channel. Every octet maps to exactly one character and back, and
  // `decodeName` then decides per NAME whether those bytes are UTF-8. That
  // is decidable — UTF-8 is self-synchronising, and a byte sequence that
  // parses as multi-byte UTF-8 essentially never is meaningful latin-1.
  client.ftp.encoding = "latin1";

  return {
    describe: async () => ({
      workingDirectory: decodeName(await client.pwd()),
      // MLSD returns machine-readable facts including a real timestamp;
      // without it the listing carries only the `ls`-style date, which
      // drops either the year or the time depending on the file's age.
      supportsModifiedTime: has("MLST") || has("MLSD") || has("MDTM"),
      supportsSize: has("SIZE"),
      // Permissions travel in a directory LISTING, never as a settable
      // attribute: standard FTP has no chmod, and SITE CHMOD is a vendor
      // extension. Reported false so the agent does not plan around it.
      supportsPermissions: false,
      // `SYST` is not a FEAT entry — it is its own command, and the one
      // way to learn whether the listings will be Unix-shaped or something
      // else entirely (Windows, MVS, VMS all answer here).
      serverSoftware: await client
        .sendIgnoringError("SYST")
        .then((response) =>
          response.code === 215 ? response.message : undefined,
        )
        .catch(() => undefined),
    }),

    list: async (path) => {
      const entries = await client.list(encodePath(path));
      return entries.map((entry) => {
        const name = decodeName(entry.name);
        return {
          name,
          path: joinPath(path, name),
          type: entry.isDirectory
            ? "directory"
            : entry.isSymbolicLink
              ? "symlink"
              : "file",
          sizeBytes: entry.size,
          modifiedAt: ftpModifiedAt(entry),
          // `permissions` is the parsed `rwx` triplet of a Unix-style
          // listing; a DOS/MVS-style server simply has none.
          mode: ftpMode(entry),
          owner: entry.user,
          group: entry.group,
        };
      });
    },

    stat: async (path) => {
      // FTP has no stat. Listing the PARENT and matching the name is the
      // only portable answer — `SIZE`/`MDTM` on a directory is an error on
      // most servers, and `list(path)` on a file returns the file on some
      // servers and its containing directory on others.
      const parent = dirname(path);
      const name = basename(path);
      let entries;
      try {
        entries = await client.list(encodePath(parent));
      } catch (error) {
        if (isMissingPathError(error)) return null;
        throw error;
      }
      // Compare on the DECODED name: `path` is an agent-facing string,
      // and the listing carries raw bytes until `decodeName` reads them.
      const match = entries.find((entry) => decodeName(entry.name) === name);
      if (match === undefined) return null;
      return {
        name,
        path,
        type: match.isDirectory
          ? "directory"
          : match.isSymbolicLink
            ? "symlink"
            : "file",
        sizeBytes: match.size,
        modifiedAt: ftpModifiedAt(match),
        mode: ftpMode(match),
        owner: match.user,
        group: match.group,
      };
    },

    download: async (path, maxBytes) => {
      const sink = createBoundedSink(path, maxBytes);
      await client.downloadTo(sink.stream, encodePath(path));
      return sink.bytes();
    },

    upload: async (path, bytes) => {
      await client.uploadFrom(
        Readable.from(Buffer.from(bytes)),
        encodePath(path),
      );
    },

    ensureDirectory: async (path) => {
      // `ensureDir` walks INTO the directory it creates, so the session is
      // left somewhere else than the caller expects. Restoring the working
      // directory keeps every subsequent relative command honest — and the
      // `finally` matters as much as the restore: a failure halfway up the
      // path (a permission wall on one segment) would otherwise strand the
      // session in a directory nobody chose, and every later relative path
      // in the same batch would resolve against it.
      const previous = await client.pwd();
      try {
        await client.ensureDir(encodePath(path));
      } finally {
        await client.cd(previous).catch(() => undefined);
      }
    },

    removeFile: async (path) => {
      await client.remove(encodePath(path));
    },

    removeDirectory: async (path, recursive) => {
      if (recursive) {
        await client.removeDir(encodePath(path));
        return;
      }
      // `removeDir` is unconditionally recursive, so a non-recursive delete
      // has to establish emptiness itself — otherwise the safe-by-default
      // flag would silently wipe a tree.
      const entries = await client.list(encodePath(path));
      if (entries.length > 0) {
        throw new Error(
          `Directory "${path}" is not empty (${entries.length.toString()} entries). Pass recursive=true to delete it with its contents.`,
        );
      }
      await client.removeDir(encodePath(path));
    },

    rename: async (from, to) => {
      await client.rename(encodePath(from), encodePath(to));
    },

    chmod: async (path, mode) => {
      // Not in RFC 959 — a vendor extension. Servers without it answer
      // 500/502, which we translate rather than surfacing as a bare
      // protocol code. `sendIgnoringError` so a refusal is a value to
      // inspect rather than a throw to catch.
      const response = await client
        .sendIgnoringError(`SITE CHMOD ${mode} ${encodePath(path)}`)
        .catch(() => null);
      if (response === null || response.code >= 400) {
        throw new Error(
          "This FTP server does not support changing permissions (SITE CHMOD). Permissions can only be set on an SFTP connection.",
        );
      }
    },

    close: async () => {
      client.close();
    },
  };
};

/**
 * Does this string carry any byte above 0x7f?
 *
 * Written as code-point arithmetic rather than a regex on purpose: the
 * escapes a character-class version needs (`\u0000`, `\u007f`) are exactly
 * the ones a formatter or a code generator can turn into literal control
 * characters, and the result is a source file that no longer parses.
 */
const hasHighBytes = (value: string): boolean => {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0x80 && code <= 0xff) return true;
  }
  return false;
};

/** Any code point outside 7-bit ASCII. */
const hasNonAscii = (value: string): boolean => {
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) > 0x7f) return true;
  }
  return false;
};

/**
 * Read a filename off the latin-1 byte channel.
 *
 * The socket hands back one character per byte, so `Buffer.from(raw,
 * "latin1")` recovers exactly what the server sent. A strict UTF-8 decode
 * then answers the only question that matters: were those bytes UTF-8? If
 * they were, the name is the decoded text; if they were not, they were a
 * single-byte code page and latin-1 already read them correctly.
 *
 * Pure ASCII takes neither branch's cost — the two encodings agree on it,
 * which is what the overwhelming majority of EDI filenames are.
 */
const decodeName = (raw: string): string => {
  if (!hasHighBytes(raw)) return raw;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.from(raw, "latin1"),
    );
  } catch {
    return raw;
  }
};

/**
 * Put a path back on that same byte channel, as UTF-8.
 *
 * The asymmetry is deliberate and is the one thing this scheme cannot make
 * perfect. A name is decoded from whatever the server sent, but an outgoing
 * path is always sent as UTF-8 bytes, because nothing in the string itself
 * says which code page it came from. On a UTF-8 server that round-trips
 * exactly. On a genuine single-byte-code-page server it round-trips for
 * ASCII — which every EDI filename is — and an accented name there can be
 * LISTED correctly but not addressed. Stated rather than hidden: the
 * alternative is `basic-ftp`'s default, where such a name is unreadable in
 * the listing too.
 */
const encodePath = (path: string): string => {
  if (!hasNonAscii(path)) return path;
  return Buffer.from(path, "utf-8").toString("latin1");
};

/** `basic-ftp` parses a timestamp only when the server speaks MLSD. */
const ftpModifiedAt = (entry: {
  modifiedAt?: Date;
  rawModifiedAt?: string;
}): string | undefined =>
  entry.modifiedAt !== undefined ? entry.modifiedAt.toISOString() : undefined;

const ftpMode = (entry: {
  permissions?: { user: number; group: number; world: number } | null;
}): string | undefined => {
  const permissions = entry.permissions;
  if (permissions === undefined || permissions === null) return undefined;
  return `0${permissions.user.toString()}${permissions.group.toString()}${permissions.world.toString()}`;
};

// ── Shared helpers ────────────────────────────────────────────────────

/**
 * True for the several dozen ways the two stacks say "not there".
 *
 * `ssh2` reports a numeric SFTP status (2 = NO_SUCH_FILE) usually wrapped in
 * a message; FTP answers 550, which basic-ftp raises with the server's own
 * prose. Both matter because "does this file exist yet" is the single most
 * common question asked of a drop folder, and an exception is a poor answer
 * to it.
 */
export const isMissingPathError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  if (code === 2 || code === "ENOENT") return true;
  const message = error.message.toLowerCase();
  return (
    message.includes("no such file") ||
    message.includes("not found") ||
    message.includes("does not exist") ||
    message.includes("550")
  );
};

const toIso = (value: number | undefined): string | undefined =>
  value === undefined || value === 0
    ? undefined
    : new Date(value).toISOString();

export class FileTooLargeError extends Error {
  constructor(path: string, maxBytes: number) {
    super(
      `"${basename(path)}" is larger than the ${(maxBytes / (1024 * 1024)).toFixed(0)} MB a single download may carry into the sandbox. Fetch it in a scheduled workflow, or ask the partner for a smaller file.`,
    );
    this.name = "FileTooLargeError";
  }
}

/**
 * A `Writable` that collects a download and destroys itself the moment the
 * file goes over budget.
 *
 * Both libraries write into a stream we provide, which is the only place a
 * ceiling can be applied while the bytes are still arriving. Destroying the
 * sink propagates through `downloadTo` / `get` and aborts the data
 * connection, so an oversized file costs the budget plus one chunk rather
 * than however many gigabytes the server was willing to send.
 *
 * `Writable` from `node:stream` rather than a Web stream because that is
 * what both libraries accept — `basic-ftp`'s `downloadTo` is typed against
 * it and `ssh2`'s `get` pipes into it. Bun implements both natively; this is
 * not a compatibility shim.
 */
const createBoundedSink = (
  path: string,
  maxBytes: number,
): { stream: Writable; bytes: () => Uint8Array } => {
  const chunks: Buffer[] = [];
  let total = 0;
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      total += chunk.byteLength;
      if (total > maxBytes) {
        callback(new FileTooLargeError(path, maxBytes));
        return;
      }
      chunks.push(chunk);
      callback();
    },
  });
  // `Buffer.concat` is one native copy into a pre-sized buffer; the
  // hand-rolled loop it replaced was the same algorithm in JavaScript.
  return { stream, bytes: () => new Uint8Array(Buffer.concat(chunks)) };
};

export const joinPath = (parent: string, name: string): string =>
  parent.endsWith("/") ? `${parent}${name}` : `${parent}/${name}`;

export const basename = (path: string): string =>
  path.replace(/\/+$/, "").split("/").pop() ?? path;

export const dirname = (path: string): string => {
  const trimmed = path.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  if (index <= 0) return index === 0 ? "/" : ".";
  return trimmed.slice(0, index);
};
