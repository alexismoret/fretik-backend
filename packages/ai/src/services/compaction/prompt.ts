/**
 * Compaction summariser prompt + post-stream formatting.
 *
 * Direct port of `claude-code/src/services/compact/prompt.ts` adapted for
 * Fretik's generic B2B document-and-data assistant. The 9-section
 * structure, `<analysis>...<summary>` envelope, NO_TOOLS preamble/trailer,
 * and `formatCompactSummary` strip pattern are kept verbatim — these are
 * the load-bearing parts validated in production by Claude Code.
 *
 * Diffs from the CC original:
 *   - Section 2: "Key Technical Concepts" → "Key Domain References" with
 *     explicit examples (invoice/contract/reference numbers, document IDs).
 *   - Section 3: "Files and Code Sections" → "Files and Document
 *     References" — Fretik handles uploaded documents / persisted-output
 *     paths, not source code.
 *   - "VERBATIM PRESERVATION" rules made explicit at the top of the
 *     instruction so the summariser never paraphrases identifiers,
 *     workspace paths, or tool call IDs (the model can `read()` these
 *     post-compaction).
 *   - Output instruction: "Write in the same language as the conversation"
 *     so a French chat produces a French summary.
 *
 * @see claude-code/src/services/compact/prompt.ts
 */

const NO_TOOLS_PREAMBLE = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- Do NOT use read, vision, sql-query, python, bash, or ANY other tool.
- You already have all the context you need in the conversation above.
- Tool calls will be REJECTED and will waste your only turn — you will fail the task.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.

`;

const VERBATIM_PRESERVATION_RULE = `IMPORTANT — VERBATIM PRESERVATION (load-bearing for the next turn):
The model continuing the conversation can call read(), python, bash, etc. on
files referenced below — but ONLY if the references are preserved exactly as
they appeared. NEVER translate, paraphrase, normalize, or "clean up" any of
the following:
- Workspace-relative file paths: outputs/persisted/<id>.json, outputs/persisted/<id>.txt,
  attachments/<filename>, drive/<docid>-<filename>, context/<filename>,
  outputs/<anything>, memory/<anything>, /workspace/* (any path starting with
  /workspace/).
- Tool call IDs and toolUseIds (used to recover persisted-output payloads).
- RAG document IDs, document UUIDs, SQL query identifiers.
- Persisted-output references inside <persisted-output>...</persisted-output>
  envelopes.
- Domain identifiers: invoice numbers, contract numbers, reference IDs,
  project codes, purchase order numbers, dates (in their original format),
  monetary amounts (with original currency), and any verbatim business
  identifiers specific to the team's industry.
- File names in their exact form (case, spaces, accents preserved).

If a section of the conversation references a file by path, repeat that path
verbatim in your summary so the model can re-read it.
`;

const DETAILED_ANALYSIS_INSTRUCTION = `Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts and ensure you've covered all necessary points. In your analysis process:

1. Chronologically analyze each message and section of the conversation. For each section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, domain references, and tool usage patterns
   - Specific details like:
     - file names and workspace paths (verbatim)
     - persisted-output references and tool call IDs
     - business identifiers — invoice / contract / reference / PO numbers (verbatim)
     - error messages encountered
   - Errors that you ran into and how you fixed them
   - Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
2. Double-check for technical accuracy and completeness, addressing each required element thoroughly.`;

const BASE_COMPACT_PROMPT = `Your task is to create a detailed summary of a conversation between a user and a generalist B2B AI work assistant. The summary REPLACES the older messages in the assistant's short-term memory for the next turn, so it must capture everything the assistant will need to stay coherent without seeing the originals.

This summary should be thorough in capturing the user's intent, domain references, file paths, tool results, and pending work — anything the next turn will need to continue without losing context.

${VERBATIM_PRESERVATION_RULE}

${DETAILED_ANALYSIS_INSTRUCTION}

Your summary should include the following sections:

1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail. Quote key user messages verbatim where helpful.
2. Key Domain References: List ALL load-bearing domain identifiers mentioned in the conversation — VERBATIM. Include invoice / contract / reference / PO numbers, project codes, document IDs, RAG IDs, dates (in their original format), monetary amounts, and entity names. Do NOT translate or normalize these.
3. Files and Document References: Enumerate every file, document, persisted-output reference, and workspace path examined or produced. For each, include:
   - The exact path (verbatim, e.g. \`outputs/persisted/abc123.json\`, \`attachments/invoice.pdf\`, \`drive/uuid-report.xlsx\`).
   - Why it matters (which question it answers, what it contains).
   - Key snippets or extracted values when small enough to inline (otherwise note "full content available via read(<path>)").
4. Errors and fixes: List all errors encountered (tool errors, schema mismatches, missing data, user corrections) and how they were resolved. Pay special attention to specific user feedback — especially when the user told you to do something differently.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL non-tool-result user messages chronologically. These are critical for understanding the user's evolving intent and feedback.
7. Pending Tasks: Outline any tasks the user has explicitly asked you to work on that are NOT yet complete.
8. Current Work: Describe in detail precisely what was being worked on immediately before this summary request, paying special attention to the most recent messages from both user and assistant. Include file names, paths, and key data points.
9. Optional Next Step: List the next step that you would take, directly in line with the user's most recent explicit request and the task you were working on immediately before this summary. If there is a next step, include direct quotes from the most recent conversation showing exactly what task you were working on and where you left off — verbatim, to ensure no drift in task interpretation.

Here's an example of how your output should be structured:

<example>
<analysis>
[Your thought process, ensuring all points are covered thoroughly and accurately]
</analysis>

<summary>
1. Primary Request and Intent:
   [Detailed description]

2. Key Domain References:
   - [Identifier 1 verbatim]
   - [Identifier 2 verbatim]
   - [...]

3. Files and Document References:
   - [exact/path/file.ext]
      - [Why this file matters]
      - [Inline excerpt OR "full content available via read(...)"]
   - [...]

4. Errors and fixes:
    - [Error 1]: [How it was fixed] [User feedback if any]
    - [...]

5. Problem Solving:
   [Description of solved problems and ongoing troubleshooting]

6. All user messages:
   - [User message 1 — quoted or paraphrased]
   - [...]

7. Pending Tasks:
   - [Task 1 — status]
   - [...]

8. Current Work:
   [Precise description of current work, with verbatim file paths and identifiers]

9. Optional Next Step:
   [Next step, with direct quotes from the most recent conversation]
</summary>
</example>

Output language rule: write the summary in the SAME language as the conversation. Do not translate. The structural section headers above ("Primary Request and Intent", etc.) MAY be translated to the conversation language as long as section meaning is preserved.

Please provide your summary based on the conversation so far, following this structure and ensuring precision and thoroughness in your response.`;

const NO_TOOLS_TRAILER = `

REMINDER: Do NOT call any tools. Respond with plain text only — an <analysis> block followed by a <summary> block. Tool calls will be rejected and you will fail the task.`;

/**
 * Build the full summariser prompt. The conversation transcript is
 * appended by the caller (`summarizer.ts::buildPrompt`) — this returns
 * only the instructions / structure / preserves rules.
 */
export const getCompactPrompt = (): string =>
  NO_TOOLS_PREAMBLE + BASE_COMPACT_PROMPT + NO_TOOLS_TRAILER;

/**
 * Strip the `<analysis>` drafting scratchpad and unwrap the `<summary>`
 * envelope. The analysis block improves summary quality (the model
 * thinks before writing) but has no informational value once the
 * summary is final, and inflating context with it wastes tokens.
 *
 * Defensive: if the model returns malformed output (no `<summary>`
 * tags, truncated `<analysis>`, etc.), return the input mostly as-is
 * with whatever cleanup we can do safely. NEVER throws.
 *
 * Mirror of `claude-code/src/services/compact/prompt.ts::formatCompactSummary`.
 */
export const formatCompactSummary = (raw: string): string => {
  let out = raw;

  // Strip <analysis>...</analysis> (DOTALL via [\s\S]).
  out = out.replace(/<analysis>[\s\S]*?<\/analysis>/g, "");

  // Extract and unwrap <summary>...</summary>. If the closing tag is
  // missing, take everything from <summary> to end-of-string — the
  // model probably ran out of tokens but the structured content is
  // still useful.
  const summaryMatch = out.match(/<summary>([\s\S]*?)<\/summary>/);
  if (summaryMatch) {
    const content = summaryMatch[1] ?? "";
    out = out.replace(
      /<summary>[\s\S]*?<\/summary>/,
      `Summary:\n${content.trim()}`,
    );
  } else {
    const openOnly = out.match(/<summary>([\s\S]*)$/);
    if (openOnly) {
      const content = openOnly[1] ?? "";
      out = out.replace(/<summary>[\s\S]*$/, `Summary:\n${content.trim()}`);
    }
  }

  // Collapse runs of blank lines.
  out = out.replace(/\n{3,}/g, "\n\n");

  return out.trim();
};

/**
 * Compose the user-facing handoff message that replaces the compacted
 * history. Mirrors `getCompactUserSummaryMessage` in CC: a fixed
 * preface + the formatted summary + an optional runtime-state block
 * (active tools, pending tasks) so the next turn sees the same world
 * state.
 *
 * The output goes into a single UIMessage with role "user" — this is
 * how CC ships the handoff (the model treats it as the start of a
 * continuation, not as its own prior assistant turn).
 *
 * @param summary  Raw summariser output (will be passed through
 *                 `formatCompactSummary` first).
 * @param runtimeStateText
 *   Optional block describing live runtime state at compaction time
 *   (active tools, pending tasks). Empty string when nothing useful to
 *   inject.
 */
export const getCompactUserSummaryMessage = (
  summary: string,
  runtimeStateText: string,
): string => {
  const formatted = formatCompactSummary(summary);
  let out = `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation — newer messages will follow after it.

${formatted}`;

  if (runtimeStateText.trim().length > 0) {
    out += `\n\n${runtimeStateText.trim()}`;
  }

  out += `\n\nContinue from where the conversation left off. Re-read any file path mentioned above with read() if you need its full content. Do not greet the user, do not recap the summary — pick up the last task as if the break never happened.`;

  return out;
};
