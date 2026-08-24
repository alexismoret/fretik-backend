import { and, eq, isNull, like } from "drizzle-orm";

import db from "../../db";
import { documents } from "../../db/schema/documents";

/**
 * Two files with the same name in the same folder.
 *
 * Never resolved silently. Two "facture.pdf" that are genuinely different
 * documents is a normal thing to have, and so is re-sending a file that was
 * already filed — guessing which one the person meant gets it wrong half the
 * time, in one direction losing a document and in the other duplicating one.
 * So the upload path asks, exactly as Drive, Dropbox, Finder and Explorer do.
 *
 * The one case worth short-circuiting is identical BYTES: there is nothing to
 * decide, the file is already there, and asking would be a question with one
 * sensible answer.
 */

export type NameCollision =
  | { kind: "none" }
  /** Same name, same bytes — already filed. Nothing to do, nothing to ask. */
  | { kind: "identical"; documentId: string }
  /** Same name, different bytes — the caller decides. */
  | { kind: "different"; documentId: string };

/**
 * Folder scoping is by EQUALITY, and the root is `NULL` — which `=` never
 * matches in SQL. Two files named the same in two folders are not a collision;
 * two at the root are.
 */
const inSameFolder = (folderId: string | null) =>
  folderId === null
    ? isNull(documents.folderId)
    : eq(documents.folderId, folderId);

export const findNameCollision = async (args: {
  teamId: string;
  folderId: string | null;
  filename: string;
  fileHash: string;
}): Promise<NameCollision> => {
  const existing = await db.query.documents.findFirst({
    where: {
      teamId: args.teamId,
      // The root is NULL, and `= NULL` matches nothing — the relational filter
      // needs `isNull` rather than the value.
      folderId:
        args.folderId === null ? { isNull: true } : { eq: args.folderId },
      originalFilename: args.filename,
    },
    columns: { id: true, fileHash: true },
  });

  if (!existing) return { kind: "none" };
  return existing.fileHash === args.fileHash
    ? { kind: "identical", documentId: existing.id }
    : { kind: "different", documentId: existing.id };
};

/**
 * `report.pdf` → `report (2).pdf`, then `(3)`, and so on.
 *
 * The counter goes before the EXTENSION, not after the name: `report.pdf (2)`
 * stops being a PDF to every operating system, and the whole storage layer
 * derives its S3 key from the extension.
 *
 * The scan is one query, not a probe per candidate: `LIKE 'report%'` fetches
 * whatever is already taken and the gap is found in memory. Bounded at 999 —
 * past that the name is not what needs fixing.
 */
const MAX_NAME_SUFFIX = 999;

/**
 * Split a filename where the EXTENSION starts, or nowhere.
 *
 * `lastIndexOf` with `> 0`, not `>= 0`: a dotfile (`.env`) is all name and no
 * extension, and treating its leading dot as the split would produce `` and
 * `.env`. The same rule as the rename guard, which learned it the hard way —
 * a version of it that stripped extensions repointed documents at S3 keys
 * holding nothing.
 */
const splitExtension = (filename: string): [string, string] => {
  const dot = filename.lastIndexOf(".");
  return dot > 0
    ? [filename.slice(0, dot), filename.slice(dot)]
    : [filename, ""];
};

/**
 * `report.pdf` + 2 → `report (2).pdf`.
 *
 * Exported for the tests that pin the extension placement; the collision path
 * below is the only caller.
 */
export const withNameSuffix = (filename: string, n: number): string => {
  const [stem, extension] = splitExtension(filename);
  return `${stem} (${n.toString()})${extension}`;
};

export const nextAvailableFilename = async (args: {
  teamId: string;
  folderId: string | null;
  filename: string;
}): Promise<string> => {
  const [stem] = splitExtension(args.filename);

  const rows = await db
    .select({ originalFilename: documents.originalFilename })
    .from(documents)
    .where(
      and(
        eq(documents.teamId, args.teamId),
        inSameFolder(args.folderId),
        // `%` and `_` are LIKE wildcards; a stem containing either would match
        // more than it should. Over-matching is harmless here — the set is only
        // used to test membership — but the escape keeps the query honest.
        like(
          documents.originalFilename,
          `${stem.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`,
        ),
      ),
    );

  const taken = new Set(rows.map((r) => r.originalFilename));
  if (!taken.has(args.filename)) return args.filename;

  for (let n = 2; n <= MAX_NAME_SUFFIX; n += 1) {
    const candidate = withNameSuffix(args.filename, n);
    if (!taken.has(candidate)) return candidate;
  }
  return withNameSuffix(args.filename, Date.now());
};
