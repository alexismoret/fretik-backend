import { and, eq, isNull, like, or } from "drizzle-orm";
import db from "../../db";
import { aiMemories } from "../../db/schema/ai-memory";
import { createApiError, throwHttpError } from "../../lib/errors";
import { findMemoryByPath } from "./lookup";
import { formatMemoryPath, parseMemoryPath } from "./paths";
import type { MemoryScopeKey } from "./types";

/**
 * Maximum number of lines we will render in a `view` call. Mirrors
 * Anthropic's documented cap and lets us short-circuit pathological
 * files without dumping them in full to the model.
 */
const VIEW_MAX_LINES = 999_999;

const LINE_NUMBER_WIDTH = 6;

/**
 * Render a byte size in the "5.5K" / "1.2M" format used by
 * Anthropic's reference output. Single decimal, no trailing `B`.
 */
const humanSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes.toString()}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
};

const padLineNumber = (n: number): string =>
  n.toString().padStart(LINE_NUMBER_WIDTH, " ");

/**
 * Render a single file content in the Anthropic-style `view`
 * envelope: leading header, then line-numbered body. The format
 * is best-effort compatible with `memory_20250818` so a future
 * swap to the native tool would be drop-in. If Anthropic ever
 * changes the format upstream, we can let it diverge — the model
 * was never relying on a specific upstream contract here.
 */
const renderFileView = (args: {
  displayPath: string;
  content: string;
  viewRange?: [number, number];
}): string => {
  const lines = args.content.split("\n");
  if (lines.length > VIEW_MAX_LINES) {
    return `File ${args.displayPath} exceeds maximum line limit of ${VIEW_MAX_LINES.toString()} lines.`;
  }

  let start = 1;
  let end = lines.length;
  if (args.viewRange) {
    const [s, e] = args.viewRange;
    if (s < 1 || e < s) {
      return `Invalid view_range [${s.toString()}, ${e.toString()}] for ${args.displayPath} (1-indexed inclusive).`;
    }
    start = s;
    end = Math.min(e, lines.length);
  }

  const numbered: string[] = [];
  for (let i = start; i <= end; i++) {
    const idx = i - 1;
    const line = lines[idx] ?? "";
    numbered.push(`${padLineNumber(i)}\t${line}`);
  }

  return [
    `Here's the content of ${args.displayPath} with line numbers:`,
    ...numbered,
  ].join("\n");
};

/**
 * Render a directory listing in the Anthropic-style envelope. We
 * filter to files whose stored `path` starts with the requested
 * prefix (or all files in the namespace for the root listing).
 *
 * Depth is capped at 2 levels below the request — anything deeper
 * is collapsed into a "<dir>/  N files" line.
 */
const renderDirectoryView = async (args: {
  scope: "user" | "team";
  relativePrefix: string; // empty for root namespace listing
  scopeKey: MemoryScopeKey;
  displayPath: string;
}): Promise<string> => {
  const { scope, relativePrefix, scopeKey, displayPath } = args;

  const conditions = [
    eq(aiMemories.organizationId, scopeKey.organizationId),
    eq(aiMemories.teamId, scopeKey.teamId),
    eq(aiMemories.scope, scope),
    scope === "user"
      ? eq(aiMemories.userId, scopeKey.userId)
      : isNull(aiMemories.userId),
  ];
  if (relativePrefix !== "") {
    // We want both the directory prefix and any nested files.
    // Drizzle's `like` is case-sensitive, which is what we want here.
    conditions.push(like(aiMemories.path, `${relativePrefix}/%`));
  }

  const rows = await db
    .select({
      path: aiMemories.path,
      sizeBytes: aiMemories.sizeBytes,
    })
    .from(aiMemories)
    .where(and(...conditions))
    .orderBy(aiMemories.path);

  if (rows.length === 0) {
    if (relativePrefix === "") {
      return `Directory ${displayPath} is empty.`;
    }
    return `The path ${displayPath} does not exist. Please provide a valid path.`;
  }

  // Build a depth-limited listing. Depth is counted from the
  // displayPath root: files exactly at depth 1 print verbatim,
  // sub-directories at depth 1 print as "subdir/ : N files".
  const directRows: { path: string; size: number }[] = [];
  const subdirCounts = new Map<string, { files: number; bytes: number }>();
  let totalBytes = 0;

  for (const row of rows) {
    totalBytes += row.sizeBytes;
    const remainder =
      relativePrefix === ""
        ? row.path
        : row.path.slice(relativePrefix.length + 1); // strip "<prefix>/"
    const parts = remainder.split("/");
    if (parts.length === 1) {
      directRows.push({ path: row.path, size: row.sizeBytes });
    } else {
      const subdirName = parts[0] ?? "";
      const existing = subdirCounts.get(subdirName) ?? { files: 0, bytes: 0 };
      existing.files += 1;
      existing.bytes += row.sizeBytes;
      subdirCounts.set(subdirName, existing);
    }
  }

  const lines: string[] = [
    `Here're the files and directories up to 2 levels deep in ${displayPath}:`,
    `${humanSize(totalBytes)}\t${displayPath}`,
  ];
  for (const dir of [...subdirCounts.keys()].sort()) {
    const stat = subdirCounts.get(dir);
    if (!stat) continue;
    lines.push(
      `${humanSize(stat.bytes)}\t${displayPath}/${dir}/  (${stat.files.toString()} files)`,
    );
  }
  for (const f of directRows.sort((a, b) => a.path.localeCompare(b.path))) {
    const fileDisplay =
      relativePrefix === ""
        ? `${displayPath}/${f.path}`
        : `${displayPath}/${f.path.slice(relativePrefix.length + 1)}`;
    lines.push(`${humanSize(f.size)}\t${fileDisplay}`);
  }
  return lines.join("\n");
};

/**
 * Implements the `view` command. Resolves the requested path to
 * either a single file (line-numbered render) or a directory
 * listing — a path that doesn't match either is reported as a
 * `MEMORY_FILE_NOT_FOUND`.
 *
 *  - `view /memories/user` → list everything under `/memories/user`
 *  - `view /memories/team/carriers` → list everything below
 *    `carriers/` (files at depth 1, sub-dirs collapsed)
 *  - `view /memories/team/carriers/dhl.md` → render the file with
 *    line numbers
 */
export const viewMemory = async (args: {
  rawPath: string;
  viewRange?: [number, number];
  scopeKey: MemoryScopeKey;
}): Promise<{ kind: "file" | "directory"; rendered: string }> => {
  const parsed = parseMemoryPath(args.rawPath, { allowEmptyRelative: true });
  const displayPath = formatMemoryPath(parsed);

  // Empty relative path => list the entire namespace root.
  if (parsed.relativePath === "") {
    const rendered = await renderDirectoryView({
      scope: parsed.scope,
      relativePrefix: "",
      scopeKey: args.scopeKey,
      displayPath,
    });
    return { kind: "directory", rendered };
  }

  const file = await findMemoryByPath({
    scope: parsed.scope,
    relativePath: parsed.relativePath,
    scopeKey: args.scopeKey,
  });

  if (file) {
    const rendered = renderFileView({
      displayPath,
      content: file.content,
      viewRange: args.viewRange,
    });
    return { kind: "file", rendered };
  }

  // Not a file — maybe a directory prefix? Render listing if any
  // descendants exist, otherwise return a not-found.
  const children = await db
    .select({ id: aiMemories.id })
    .from(aiMemories)
    .where(
      and(
        eq(aiMemories.organizationId, args.scopeKey.organizationId),
        eq(aiMemories.teamId, args.scopeKey.teamId),
        eq(aiMemories.scope, parsed.scope),
        parsed.scope === "user"
          ? eq(aiMemories.userId, args.scopeKey.userId)
          : isNull(aiMemories.userId),
        or(
          eq(aiMemories.path, parsed.relativePath),
          like(aiMemories.path, `${parsed.relativePath}/%`),
        ),
      ),
    )
    .limit(1);

  if (children.length === 0) {
    return throwHttpError(
      404,
      createApiError(
        "MEMORY_FILE_NOT_FOUND",
        `The path ${displayPath} does not exist. Please provide a valid path.`,
      ),
    );
  }

  const rendered = await renderDirectoryView({
    scope: parsed.scope,
    relativePrefix: parsed.relativePath,
    scopeKey: args.scopeKey,
    displayPath,
  });
  return { kind: "directory", rendered };
};
