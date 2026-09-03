import { PAGE_ENTRY_FILE } from "@fretik/shared/schemas/pages";

/**
 * What the project LOOKS like, in the fewest lines that still let an agent
 * decide which file to open.
 *
 * It exists because of what a code agent forgets: after twenty steps the model
 * has written six files and remembers the first two. Re-reading them to find
 * out costs more than the edit it came for, so every build hands back the shape
 * of the whole project — path, size, and the interface each file exposes.
 *
 * Signatures are read with the SFC parser and small regexes rather than a full
 * AST walk: what is wanted is a reminder, and a wrong reminder is corrected by
 * one `pageRead`. A missing one sends the agent reading everything.
 */

const PROPS_RE = /defineProps<\{([\s\S]*?)\}>/;
const EMITS_RE = /defineEmits<\{([\s\S]*?)\}>/;
const RUNTIME_PROPS_RE = /defineProps\(\s*\{([\s\S]*?)\}\s*\)/;
const EXPORT_RE = /export\s+(?:const|function|class)\s+([A-Za-z_$][\w$]*)/g;
const SCRIPT_RE = /<script[^>]*>([\s\S]*?)<\/script>/;

/** `rows: Row[]; currency?: string` → `rows, currency?`. */
const keysOf = (block: string): string[] =>
  block
    .split(/[;\n,]/)
    .map((entry) => /^\s*([A-Za-z_$][\w$]*\??)\s*:/.exec(entry)?.[1] ?? "")
    .filter((key) => key.length > 0);

const firstComment = (content: string): string | null => {
  for (const line of content.split("\n").slice(0, 4)) {
    const match = /^\s*(?:\/\/|<!--)\s*(.+?)\s*(?:-->)?\s*$/.exec(line);
    const text = match?.[1];
    if (text !== undefined && text.length > 3) return text.slice(0, 80);
  }
  return null;
};

/** One line: what this file offers to the rest of the project. */
const signature = (path: string, content: string): string => {
  if (path.endsWith(".ts")) {
    const names = [...content.matchAll(EXPORT_RE)].map((match) => match[1]);
    return names.length > 0 ? `exports ${names.join(", ")}` : "";
  }
  const script = SCRIPT_RE.exec(content)?.[1] ?? "";
  const parts: string[] = [];
  const props =
    PROPS_RE.exec(script)?.[1] ?? RUNTIME_PROPS_RE.exec(script)?.[1];
  if (props !== undefined) {
    const keys = keysOf(props);
    if (keys.length > 0) parts.push(`props: ${keys.join(", ")}`);
  }
  const emits = EMITS_RE.exec(script)?.[1];
  if (emits !== undefined) {
    const keys = keysOf(emits);
    if (keys.length > 0) parts.push(`emits: ${keys.join(", ")}`);
  }
  return parts.join(" · ");
};

/**
 * The project as a table: `path  N lines  what it offers`.
 *
 * The entry comes first, then components, then the rest — the order somebody
 * reads a project in, not alphabetical order.
 */
export const renderProjectManifest = (
  files: Record<string, string>,
): string => {
  const paths = Object.keys(files).sort((a, b) => {
    if (a === PAGE_ENTRY_FILE) return -1;
    if (b === PAGE_ENTRY_FILE) return 1;
    return a.localeCompare(b);
  });
  if (paths.length === 0) return "(no files yet)";
  const width = Math.min(Math.max(...paths.map((path) => path.length)) + 2, 34);
  return paths
    .map((path) => {
      const content = files[path] ?? "";
      const lines = content === "" ? 0 : content.split("\n").length;
      const note = signature(path, content) || (firstComment(content) ?? "");
      return `${path.padEnd(width)}${`${lines.toString()} lines`.padEnd(11)}${note}`.trimEnd();
    })
    .join("\n");
};
