/**
 * Flatten MDC block syntax out of markdown before it is chunked and embedded.
 *
 * The agent writes in Markdown plus the MDC blocks of `<rich_blocks>` —
 * `::tabs`, `::steps`, `::card{title="…"}`, `:::stat{label="…" value="…"}`.
 * Rendered they are tabs, cards and KPI tiles. Handed to an embedder verbatim
 * they are two different problems, and only the second is content loss:
 *
 *  - **Container blocks** (`::tabs`, `::steps`, `::accordion`, `::collapsible`)
 *    wrap ordinary markdown. Their prose is already indexed; the marker lines
 *    are just tokens carrying nothing about the subject. Noise, not loss.
 *  - **Attribute-carrying blocks** (`::card{title}`, `:::place{label address}`,
 *    `:::stat{label value delta}`, `::field{name type}`) keep real content
 *    INSIDE the braces, where it reads as configuration rather than as the
 *    sentence it is. That is the part worth rescuing.
 *
 * So: markers dropped, brace content promoted to a bullet, wrapped prose left
 * byte-identical, fenced code untouched.
 *
 * **This output is DERIVED — never write it back.** For a `.md` document the
 * sidecar IS the original file (see the corruption guard in
 * `services/documents/process.ts`), so persisting this rendering would destroy
 * the document it describes.
 *
 * Generic by construction, and the attribute filter is a DENY-list on purpose:
 * a block type nobody updated this file for still flattens correctly, and a
 * new textual attribute survives by default. Wrongly keeping a machine
 * attribute costs a couple of noise tokens; wrongly dropping a label loses
 * content — the asymmetry picks the direction.
 */

/** Same fence convention as the chunker: ``` or ~~~ at line start. */
const FENCE_RE = /^(```|~~~)/;

/**
 * A whole line that is only MDC block syntax: an opener (`::name`,
 * `:::name{…}`) or a bare closing marker (`::`, `:::`). Anything else on the
 * line means it is prose that happens to start with colons, and is left alone.
 */
const BLOCK_LINE_RE =
  /^\s*(:{2,})([a-zA-Z][a-zA-Z0-9-]*)?[ \t]*(\{[^}]*\})?[ \t]*$/;

/** Quoted attributes only — `cols=3`, `required` and friends are machine bits. */
const QUOTED_ATTR_RE = /([a-zA-Z][\w-]*)\s*=\s*"([^"]*)"/g;

/**
 * `:badge[Active]`, `:kbd[Ctrl]` — the label is the content.
 *
 * The lookbehind is load-bearing: without it these also fire on the tail of a
 * BLOCK marker (`:::tabs-item{…}`), so a malformed opener that carries trailing
 * prose — and therefore never matched `BLOCK_LINE_RE` — would come out as a
 * mangled `::` stub. An inline span is single-colon by definition; a run of
 * colons is block syntax and belongs to the line rule or to nobody.
 */
const INLINE_SPAN_RE = /(?<!:):([a-zA-Z][\w-]*)\[([^\]]*)\](?:\{[^}]*\})?/g;

/** `:icon{name="i-lucide-check"}` — decoration with no readable text. */
const INLINE_ATTR_ONLY_RE = /(?<!:):([a-zA-Z][\w-]*)\{[^}]*\}/g;

/**
 * Attribute names whose value is styling or wiring rather than something a
 * reader would search for. Everything not listed here is kept.
 */
const NON_CONTENT_ATTRS = new Set([
  "icon",
  "cols",
  "color",
  "class",
  "id",
  "to",
  "target",
  "size",
  "variant",
  "orientation",
  "open",
  "defaultvalue",
]);

/** Pull the readable values out of a `{…}` attribute string, in order. */
const readableAttributeValues = (braces: string): string[] => {
  const values: string[] = [];
  for (const match of braces.matchAll(QUOTED_ATTR_RE)) {
    const key = (match[1] ?? "").toLowerCase();
    const value = (match[2] ?? "").trim();
    if (value.length === 0 || NON_CONTENT_ATTRS.has(key)) continue;
    values.push(value);
  }
  return values;
};

const flattenInline = (line: string): string =>
  line
    .replace(INLINE_SPAN_RE, (_, __, label: string) => label)
    .replace(INLINE_ATTR_ONLY_RE, "");

/**
 * Rewrite `markdown` for indexing. A no-op by construction on markdown that
 * carries no MDC — uploaded documents' OCR text and skill bodies pass through
 * unchanged, so this is safe to run on every source.
 */
export const flattenRichBlocks = (markdown: string): string => {
  if (!markdown.includes(":")) return markdown;

  const out: string[] = [];
  let inFence = false;

  for (const line of markdown.split("\n")) {
    if (FENCE_RE.test(line.trim())) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }

    const block = BLOCK_LINE_RE.exec(line);
    if (block) {
      const braces = block[3];
      const values = braces ? readableAttributeValues(braces) : [];
      // A bullet, not a bare line: it keeps the label visually attached to the
      // prose that followed it in the block, which is what it labelled.
      if (values.length > 0) out.push(`- ${values.join(" ")}`);
      continue;
    }

    out.push(flattenInline(line));
  }

  // Dropped markers leave runs of blank lines behind, and the chunker splits
  // on paragraph boundaries — collapse them so it does not see phantom ones.
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
};
