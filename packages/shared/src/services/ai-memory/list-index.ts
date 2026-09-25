import { and, or } from "drizzle-orm";
import db from "../../db";
import { aiMemories, type AiMemoryScope } from "../../db/schema/ai-memory";
import { memoryNamespaceConditions } from "./lookup";
import type { MemoryScopeKey } from "./types";

/**
 * Per-directory file cap before we collapse files into a "N files"
 * summary line. The model can drill into the directory with `view`
 * when it actually needs the names.
 */
const MAX_FILES_PER_DIR = 30;

/**
 * Total file cap before we drop the per-namespace listings entirely
 * and only show the top-level totals. Beyond this size, the index
 * is mostly noise — the model should rely on `grep` / `view <dir>`.
 */
const TOTAL_FILE_CAP = 80;

const humanSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes.toString()}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
};

interface IndexRow {
  scope: AiMemoryScope;
  path: string;
  sizeBytes: number;
}

/** How each namespace introduces itself in the index. */
const NAMESPACE_HEADERS: Record<AiMemoryScope, string> = {
  user: "(visible only to you)",
  team: "(shared with the whole team — every write is audited)",
  project: "(shared with the people of this project — every write is audited)",
};

/**
 * Compact manifest of the memory tree, injected into the chatbot
 * system prompt at every turn. The model uses it to decide whether
 * a file is worth `view`-ing and where to write new memories — no
 * round-trip required for discovery.
 *
 * The namespaces the turn reads (`memoryNamespacesFor`) are rendered side by
 * side: `/memories/user/` (the scope key's `userId`, private files only),
 * `/memories/team/` for the team's people, and `/memories/project/` (the scope
 * key's `projectId`) in a project's chats.
 *
 * Returns the empty-state string when no memories exist in any of them.
 * Callers should still inject the result — the prompt block tells the model
 * "feel free to start writing".
 */
export const buildMemoryIndexManifest = async (
  scopeKey: MemoryScopeKey,
  namespaces: readonly AiMemoryScope[],
): Promise<string> => {
  const rows =
    namespaces.length === 0
      ? []
      : await db
          .select({
            scope: aiMemories.scope,
            path: aiMemories.path,
            sizeBytes: aiMemories.sizeBytes,
          })
          .from(aiMemories)
          .where(
            or(
              ...namespaces.map((scope) =>
                and(...memoryNamespaceConditions(scope, scopeKey)),
              ),
            ),
          )
          .orderBy(aiMemories.scope, aiMemories.path);

  if (rows.length === 0) {
    const where = namespaces.map((scope) => `/memories/${scope}/`).join(", ");
    return [
      "<memory_index>",
      `(no memories yet in ${where} — feel free to start writing using the \`memory\` tool)`,
      "</memory_index>",
    ].join("\n");
  }

  const rowsOf = (scope: AiMemoryScope) =>
    rows.filter((row) => row.scope === scope);

  // Beyond the global cap we only show counts — relying on
  // grep/view for discovery instead of dumping a long index.
  if (rows.length > TOTAL_FILE_CAP) {
    return [
      "<memory_index>",
      ...namespaces.map((scope) => {
        const scoped = rowsOf(scope);
        const bytes = scoped.reduce((acc, r) => acc + r.sizeBytes, 0);
        return `/memories/${scope}/  ${scoped.length.toString()} files (${humanSize(bytes)}) ${NAMESPACE_HEADERS[scope]} — use \`view\` or \`grep\` to explore`;
      }),
      "</memory_index>",
    ].join("\n");
  }

  const lines: string[] = ["<memory_index>"];

  const renderNamespace = (
    label: string,
    headerSuffix: string,
    namespaceRows: IndexRow[],
  ) => {
    if (namespaceRows.length === 0) {
      lines.push(`${label}  ${headerSuffix} — empty`);
      return;
    }
    lines.push(`${label}  ${headerSuffix}:`);

    // Group by first segment of path (depth-1 directory). Files at
    // the namespace root live under the synthetic key "" and render
    // as direct children.
    const buckets = new Map<string, IndexRow[]>();
    for (const r of namespaceRows) {
      const slashIdx = r.path.indexOf("/");
      const key = slashIdx === -1 ? "" : r.path.slice(0, slashIdx);
      const list = buckets.get(key) ?? [];
      list.push(r);
      buckets.set(key, list);
    }

    // Direct files first (sorted), then sub-directories alphabetically.
    const direct = buckets.get("");
    if (direct) {
      for (const f of direct.sort((a, b) => a.path.localeCompare(b.path))) {
        lines.push(`  ${humanSize(f.sizeBytes).padStart(6, " ")}  ${f.path}`);
      }
    }
    const dirs = [...buckets.keys()].filter((k) => k !== "").sort();
    for (const dir of dirs) {
      const entries = buckets.get(dir);
      if (!entries) continue;
      const totalBytes = entries.reduce((acc, e) => acc + e.sizeBytes, 0);
      if (entries.length > MAX_FILES_PER_DIR) {
        lines.push(
          `  ${dir}/  ${entries.length.toString()} files (${humanSize(totalBytes)})`,
        );
        continue;
      }
      lines.push(`  ${dir}/  (${humanSize(totalBytes)})`);
      for (const f of entries.sort((a, b) => a.path.localeCompare(b.path))) {
        const remainder = f.path.slice(dir.length + 1);
        lines.push(
          `    ${humanSize(f.sizeBytes).padStart(6, " ")}  ${remainder}`,
        );
      }
    }
  };

  for (const scope of namespaces) {
    renderNamespace(
      `/memories/${scope}/`,
      NAMESPACE_HEADERS[scope],
      rowsOf(scope),
    );
  }
  lines.push("</memory_index>");

  return lines.join("\n");
};
