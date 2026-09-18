/**
 * Reading the OWNER out of an S3 key.
 *
 * Split out of `scripts/sweep-orphan-s3.ts` so it can be tested, because
 * this is the half of that script where a mistake deletes somebody's
 * files. Everything here is pure: no S3, no database, no process exit.
 *
 * The contract every parser below keeps: return the owning id when the
 * key's shape is one this family understands, and `null` when it is not.
 * `null` means KEEP — the sweeper never deletes a key it cannot explain,
 * so a new key shape added elsewhere in the codebase degrades to being
 * reported rather than reaped.
 */

/**
 * `prefix/{id}/…` — the id is the first path segment after the prefix.
 *
 * Requires a `/` AFTER the segment: `chatbot-sessions/abc` is a stray
 * object sitting where a folder belongs, not a folder, and reading it as
 * conversation `abc` would delete it on the strength of a guess.
 */
export const firstSegmentOwner =
  (prefix: string) =>
  (key: string): string | null => {
    if (!key.startsWith(prefix)) return null;
    const rest = key.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash <= 0) return null;
    return rest.slice(0, slash);
  };

/**
 * `documents/{uuid}…` — every document key begins with its id, whatever
 * follows: `.pdf`, `-thumbnail.webp`, `-preview-{hash}.pdf`,
 * `-preextract.pdf`, `/v3.docx`.
 *
 * Anchored and shape-checked rather than split on a delimiter, because
 * the delimiter differs per artefact and a uuid contains dashes itself.
 */
const UUID_PREFIX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export const documentOwner = (key: string): string | null => {
  const prefix = "documents/";
  if (!key.startsWith(prefix)) return null;
  const rest = key.slice(prefix.length);
  const match = UUID_PREFIX.exec(rest);
  if (!match) return null;
  // The id must be followed by something that ends it — `.`, `-` or `/` —
  // or be the whole name. A 36-char prefix of a LONGER id would otherwise
  // read as a different document.
  const next = rest.charAt(match[0].length);
  return next === "" || next === "." || next === "-" || next === "/"
    ? match[0]
    : null;
};

/**
 * `public/{kind}/{ownerId}-{hash}.webp`.
 *
 * The owner id is a Better Auth id and may contain dashes of its own, so
 * it is matched AGAINST the live set rather than parsed out. That inverts
 * the usual direction on purpose: here "recognised" and "live" are the
 * same question, so a key matching nobody is indistinguishable from an
 * orphan — and the safe reading of an ambiguity is to keep the file.
 *
 * Which means this family reports orphans it cannot prove, and never
 * deletes them. Avatars are small; the alternative is a parser that
 * guesses where an opaque id ends.
 */
export const publicImageOwner =
  (prefix: string, liveIds: () => ReadonlySet<string>) =>
  (key: string): string | null => {
    if (!key.startsWith(prefix)) return null;
    const filename = key.slice(prefix.length);
    if (filename.includes("/")) return null;
    for (const id of liveIds()) {
      if (filename.startsWith(`${id}-`)) return id;
    }
    return null;
  };

export type OrphanVerdict =
  /** The owner is gone and the object is old enough to act on. */
  | { kind: "orphan"; owner: string }
  /** The owner is gone but the object is inside the grace window. */
  | { kind: "too-young"; owner: string }
  /** The owner still exists. */
  | { kind: "live"; owner: string }
  /** The key shape is not one this family understands. */
  | { kind: "unrecognised" };

/**
 * The verdict for one object.
 *
 * An object with NO modification time counts as too young. The grace
 * window exists to protect a write in flight — `uploadDocument` writes
 * the bytes before it inserts the row — and "I do not know when this was
 * written" is not evidence that it is old.
 */
export const classifyObject = (args: {
  key: string;
  lastModified: Date | null;
  ownerOf: (key: string) => string | null;
  liveIds: ReadonlySet<string>;
  cutoff: Date;
}): OrphanVerdict => {
  const owner = args.ownerOf(args.key);
  if (owner === null) return { kind: "unrecognised" };
  if (args.liveIds.has(owner)) return { kind: "live", owner };
  if (!args.lastModified || args.lastModified > args.cutoff) {
    return { kind: "too-young", owner };
  }
  return { kind: "orphan", owner };
};
