import { SOURCE_TIMEOUT_MS } from "./wire";

/**
 * Scaleway's published model specifications — context window and tool support.
 *
 * These two facts appear in NO Scaleway API. `/v1/models` returns four fields;
 * the product catalogue returns prices and tasks. Both were probed on
 * 2026-08-30, along with `GET /v1/models/{id}` (404) and a `/v1/pricing` route
 * (404). What is left is the documentation, which Scaleway maintains in the
 * open at `scaleway/docs-content` — so that is what this reads, from the raw
 * file rather than the rendered page.
 *
 * Taking a fact from prose deserves a reason, and there is a specific one: the
 * context window here is NOT the model's, it is SCALEWAY'S, and nothing else
 * knows it. Scaleway caps serverless context below what the weights support
 * while a model is in preview — `deepseek-v4-flash-0731` is capped at 256k
 * against the 997,952 our own live row carries from an aggregator, a factor of
 * 3.9 — so inheriting the number from the catalogue merge would size every
 * request against a limit that does not exist on this transport. The other
 * candidates were worse: a hand-written table in this repo goes stale silently
 * and in the dangerous direction (it would keep claiming the preview cap after
 * Scaleway lifts it, or the reverse), and there is no third source.
 *
 * Two guards make prose safe to depend on:
 *
 * 1. **A parse that finds nothing yields nothing.** No context window means the
 *    model fails every context floor and is never promoted. A reformatting of
 *    the table therefore withdraws Scaleway models from candidacy; it cannot
 *    invent a limit.
 * 2. **Nothing here is inferred.** A cell that does not match is skipped rather
 *    than guessed at, and `whisper-large-v3` — whose context cell is `-` —
 *    simply has no context window.
 */

const SPEC_URL =
  "https://raw.githubusercontent.com/scaleway/docs-content/main/pages/generative-apis/reference-content/supported-models.mdx";

/** What the documentation states about one model. Every field may be absent. */
export interface ScalewayModelSpec {
  /** Scaleway's own serverless ceiling, which is often below the model's. */
  contextWindow?: number;
  maxTokens?: number;
  supportsTools?: boolean;
  supportsStructuredOutput?: boolean;
}

/**
 * `256k**` → 256000, `100k (Serverless)/ 128k (Dedicated)` → 100000, `-` → none.
 *
 * The serverless figure wins wherever the cell offers both, because serverless
 * is the product this transport calls. Footnote markers are stripped: they are
 * MDX escapes (`\*`) that carry the preview caveat, not part of the number.
 */
const tokenCount = (cell: string): number | undefined => {
  const text = cell.replaceAll("\\*", "").replaceAll("*", "").trim();
  if (text === "" || text === "-") return undefined;
  const serverless = /(\d+(?:\.\d+)?)\s*k\s*\(\s*serverless\s*\)/i.exec(text);
  const plain = /^(\d+(?:\.\d+)?)\s*(k?)/i.exec(text);
  if (serverless !== null) return Math.round(Number(serverless[1]) * 1000);
  if (plain === null) return undefined;
  const value = Number(plain[1]);
  if (!Number.isFinite(value)) return undefined;
  return Math.round(plain[2] === "" ? value : value * 1000);
};

/** `Yes` / `No`; anything else — `-` on the transcription model — is unknown. */
const yesNo = (cell: string): boolean | undefined => {
  const text = cell.trim().toLowerCase();
  return text === "yes" ? true : text === "no" ? false : undefined;
};

const cellsOf = (line: string): string[] | undefined => {
  const text = line.trim();
  if (!text.startsWith("|")) return undefined;
  return text.replace(/^\|/, "").replace(/\|$/, "").split("|");
};

/** `[glm-5.2](#glm-52)` → `glm-5.2`; a bare cell passes through unchanged. */
const linkText = (cell: string): string =>
  cell.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").trim();

/**
 * The summary table, which is the only place the model ids are enumerated. Its
 * five columns are name, serverless availability, modalities, context and
 * licence; modalities are ignored because the product catalogue publishes the
 * same fact as data.
 */
const readSummary = (lines: readonly string[]): Map<string, number> => {
  const context = new Map<string, number>();
  for (const line of lines) {
    const cells = cellsOf(line);
    if (cells === undefined || cells.length !== 5) continue;
    const id = linkText(cells[0] ?? "").toLowerCase();
    if (id === "" || id === "model name") continue;
    const window = tokenCount(cells[3] ?? "");
    if (window !== undefined) context.set(id, window);
  }
  return context;
};

/**
 * Per-model sections, split on their own headings. A heading lowercases to the
 * model id exactly (`### DeepSeek-V4-Flash-0731` against
 * `deepseek-v4-flash-0731`) — verified across all 15 served models.
 */
const readSections = (text: string): Map<string, string> => {
  const sections = new Map<string, string>();
  for (const part of text.split(/\n(?=#{2,3} )/)) {
    const heading = /^#{2,3}\s+(.+)/.exec(part);
    if (heading === null) continue;
    sections.set((heading[1] ?? "").trim().toLowerCase(), part);
  }
  return sections;
};

/** The value of one `| Attribute | Value |` row, matched on its label prefix. */
const attribute = (section: string, label: string): string | undefined => {
  for (const line of section.split("\n")) {
    const cells = cellsOf(line);
    if (cells === undefined || cells.length < 2) continue;
    if (!(cells[0] ?? "").trim().toLowerCase().startsWith(label)) continue;
    return cells[1];
  }
  return undefined;
};

/**
 * Every model the documentation describes, keyed by model id.
 *
 * ENRICHMENT, so it never throws and returns an empty map on any failure. The
 * consequence is stated above: no specification means no context window, which
 * means the model is ineligible rather than mis-sized.
 */
export const fetchScalewayModelSpecs = async (): Promise<
  Map<string, ScalewayModelSpec>
> => {
  const specs = new Map<string, ScalewayModelSpec>();
  const response = await fetch(SPEC_URL, {
    signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
  }).catch(() => undefined);
  if (response === undefined || !response.ok) return specs;
  const text = await response.text().catch(() => "");
  if (text === "") return specs;

  const sections = readSections(text);
  for (const [id, contextWindow] of readSummary(text.split("\n"))) {
    const section = sections.get(id);
    specs.set(id, {
      contextWindow,
      ...(section === undefined
        ? {}
        : {
            maxTokens: tokenCount(
              attribute(section, "maximum output (tokens)") ?? "",
            ),
            supportsTools: yesNo(
              attribute(section, "supports function calling") ?? "",
            ),
            supportsStructuredOutput: yesNo(
              attribute(section, "supports structured output") ?? "",
            ),
          }),
    });
  }
  return specs;
};
