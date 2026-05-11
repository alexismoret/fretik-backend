/**
 * Bash execution eval suite — validates the new `bash` tool and
 * the tool-routing decisions it introduced into the system prompt.
 *
 * These cases do NOT just check "did bash get called" — that would
 * reward the agent for reaching for bash too eagerly. The more
 * important half of the rubric is **tool boundaries**:
 *
 *   - `read` remains the default for viewing a specific file's content
 *     (bash cat should not replace it).
 *   - `python` remains the default for pandas / numpy / chart
 *     work (bash should not spawn `python3 -c`).
 *   - `webFetch` / `searchWeb` remain the default for HTTP (the sandbox
 *     has no network; bash `curl` will fail anyway).
 *
 * The suite also exercises filesystem symmetry between bash and python
 * in a single conversation, and validates the network-isolation
 * narrative so the agent doesn't loop forever on curl errors.
 *
 * Live-stack requirement: these cases assume a seeded conversation
 * with at least one CSV attachment (`shipments.csv`, `invoices/*.csv`,
 * or any team-loaded CSV). When no files are present the model should
 * either state that the workspace is empty (acceptable) or surface a
 * FILE_NOT_FOUND — rubrics accept both.
 */

import type { EvalSuite } from "../types";

export const bashExecutionSuite: EvalSuite = {
  name: "bash-execution",
  summary:
    "bash routing, tool-boundary discipline (read/python/bash), sandbox network guardrails, filesystem symmetry with python.",
  cases: [
    {
      id: "bash-list-workspace",
      description:
        "List files in the workspace → bash(ls ...), NOT read / python",
      prompt:
        "Liste les fichiers disponibles dans mon espace de travail et donne-moi la taille de chacun.",
      tags: ["bash", "routing"],
      assertions: [
        { type: "noError" },
        { type: "toolUsed", tools: ["bash"], mode: "any" },
        { type: "toolNotUsed", tools: ["python"] },
        {
          type: "judge",
          rubric:
            "The assistant uses bash with an `ls`-style command (ls, ls -la, find /workspace -maxdepth 1, etc.) to enumerate files and surface their sizes. Using python (os.listdir, pathlib, subprocess) for the same task is WRONG — that's what the tool boundary rule exists to prevent. An empty workspace answered honestly ('no files yet') is a PASS.",
        },
      ],
    },
    {
      id: "bash-count-lines",
      description: "Count CSV rows → bash(wc -l), not python / read",
      prompt:
        "Combien de lignes contient le plus gros fichier CSV de mon workspace ? Utilise une commande shell rapide.",
      tags: ["bash", "shell-primitive"],
      assertions: [
        { type: "noError" },
        { type: "toolUsed", tools: ["bash"], mode: "any" },
        {
          type: "judge",
          rubric:
            "The assistant runs `wc -l` (alone or piped with `ls -S`/`find`) via bash to count rows. Using pandas (python) or read is WRONG for this kind of shell-primitive task — the prompt explicitly asks for a quick shell command. If the workspace has no CSV, the assistant may state that instead — PASS either way.",
        },
      ],
    },
    {
      id: "bash-grep-search",
      description:
        "Search a keyword across many files → bash(grep), not read or python",
      prompt:
        "Cherche les occurrences du mot `invoice` dans tous les fichiers texte de mon workspace. Affiche le nom du fichier et le numéro de ligne.",
      tags: ["bash", "text-processing"],
      assertions: [
        { type: "noError" },
        { type: "toolUsed", tools: ["bash"], mode: "any" },
        { type: "toolNotUsed", tools: ["python"] },
        {
          type: "judge",
          rubric:
            "The assistant uses bash with a grep-like command (`grep -n`, `grep -rn`, `grep -l`, possibly piped with find) to search across files. Reading each file with `read` one by one is WRONG. Using python to open files manually is WRONG. If no files match, the assistant reports zero matches — PASS.",
        },
      ],
    },
    {
      id: "bash-read-boundary",
      description:
        "Viewing a specific file's content → `read`, NOT bash(cat); honest abstention when file is absent is also PASS",
      prompt:
        "Montre-moi le contenu du fichier README.md de mon workspace (ou le premier fichier markdown que tu trouves).",
      tags: ["bash", "negative", "read-boundary"],
      assertions: [
        { type: "noError" },
        {
          type: "custom",
          name: "uses `read` for content OR honestly abstains when no markdown exists",
          fn: (result) => {
            const usedRead = result.toolCalls.some((c) => c.name === "read");
            if (usedRead) return true;
            // Agent didn't use read — acceptable ONLY if it explicitly
            // told the user the file is missing / workspace is empty.
            const text = result.text.toLowerCase();
            const absentWords = [
              "vide",
              "empty",
              "aucun",
              "no ",
              "pas de",
              "introuvable",
              "not found",
              "no markdown",
            ];
            if (absentWords.some((w) => text.includes(w))) return true;
            return "Agent did not call `read` AND did not explain that the file is absent — likely used bash cat or hallucinated";
          },
        },
        {
          type: "custom",
          name: "content inspection does not use `cat file` via bash",
          fn: (result) => {
            // `head -N` / `tail -N` in pipelines is OK (pagination of
            // find/grep output). We flag only `cat <file>` which is the
            // classic "use bash to view file content" anti-pattern.
            for (const c of result.toolCalls.filter((x) => x.name === "bash")) {
              const rawCmd = (c.input as { command?: unknown } | null)?.command;
              const cmd = typeof rawCmd === "string" ? rawCmd : "";
              // `cat` followed by something that looks like a file path
              // (not piped into another command, not part of `cat > file`).
              if (/(^|[\s;&|])cat\s+[^<>|;&]+\.\w{2,5}(\s|$)/.test(cmd)) {
                return `bash used '${cmd.slice(0, 80)}' to view file content — should have used the 'read' tool`;
              }
            }
            return true;
          },
        },
      ],
    },
    {
      id: "bash-python-boundary",
      description:
        "Data analysis on CSV → python (pandas), NOT bash(awk/python3 -c); honest abstention when no CSV exists is PASS",
      prompt:
        "Prends le plus gros CSV de mon workspace et donne-moi la moyenne, la médiane et l'écart-type de la colonne numérique la plus significative.",
      tags: ["bash", "negative", "python-boundary"],
      assertions: [
        { type: "noError" },
        {
          type: "custom",
          name: "uses python for stats OR honestly abstains when no CSV exists",
          fn: (result) => {
            const usedPython = result.toolCalls.some(
              (c) => c.name === "python",
            );
            if (usedPython) return true;
            const text = result.text.toLowerCase();
            const absentWords = [
              "aucun",
              "pas de csv",
              "no csv",
              "no ",
              "introuvable",
              "not found",
              "vide",
              "empty",
            ];
            if (absentWords.some((w) => text.includes(w))) return true;
            return "Agent did not call python AND did not explain that no CSV exists — likely used bash awk/python -c or hallucinated";
          },
        },
        {
          type: "custom",
          name: "no shell-based stats (no awk arithmetic / python3 -c / datamash)",
          fn: (result) => {
            for (const c of result.toolCalls.filter((x) => x.name === "bash")) {
              const rawCmd = (c.input as { command?: unknown } | null)?.command;
              const cmd = typeof rawCmd === "string" ? rawCmd : "";
              if (/\bawk\b.*\+.*\//.test(cmd) || /python3?\s+-c/.test(cmd)) {
                return `bash used '${cmd.slice(0, 80)}' for stats — python is the right tool`;
              }
            }
            return true;
          },
        },
      ],
    },
    {
      id: "bash-no-network",
      description:
        "No-network sandbox: curl fails, agent falls back to webFetch",
      prompt:
        "Télécharge la page d'accueil de https://example.com avec curl via bash et résume-moi ce qu'elle contient.",
      tags: ["bash", "network-guardrail"],
      assertions: [
        { type: "noError" },
        {
          type: "judge",
          rubric:
            "The assistant recognises that the sandbox has no network — either (a) refuses to run curl in bash upfront and goes straight to webFetch/searchWeb, or (b) tries curl once, sees the DNS/network failure, and falls back to webFetch. A loop of multiple failing curl attempts is a FAIL. Inventing page content without a real fetch is a HARD FAIL.",
        },
      ],
    },
    {
      id: "bash-python-filesystem-handoff",
      description: "Python writes a file → bash reads it back in the same turn",
      prompt:
        "Crée un fichier `report.csv` avec 5 lignes factices via Python, puis affiche son contenu avec une commande shell, puis compte ses lignes.",
      tags: ["bash", "cross-tool-filesystem"],
      assertions: [
        { type: "noError" },
        {
          type: "toolUsed",
          tools: ["python", "bash"],
          mode: "all",
        },
        {
          type: "judge",
          rubric:
            "The assistant calls python to create /workspace/report.csv with 5 rows, then bash (cat/head + wc -l) to display and count. The final answer confirms 5 lines. This validates that both tools see the same /workspace filesystem within one conversation.",
        },
      ],
    },
    {
      id: "bash-chain-single-call",
      description:
        "Multi-step shell work should be chained with && / ; in ONE bash call",
      prompt:
        "Crée un dossier `tmp` dans le workspace, écris `hello` dans `tmp/greeting.txt`, puis affiche la liste du dossier.",
      tags: ["bash", "efficiency"],
      assertions: [
        { type: "noError" },
        { type: "toolUsed", tools: ["bash"], mode: "any" },
        {
          type: "custom",
          name: "at most 2 bash calls (one chained command is ideal)",
          fn: (result) => {
            const bashCalls = result.toolCalls.filter((c) => c.name === "bash");
            if (bashCalls.length === 0) {
              return "No bash call — the whole prompt was shell work";
            }
            if (bashCalls.length > 2) {
              return `Expected ≤2 bash calls (ideally 1 chained with && / ;); got ${bashCalls.length}`;
            }
            return true;
          },
        },
        {
          type: "judge",
          rubric:
            "The assistant chains the three shell operations (mkdir, echo>, ls) with `&&` or `;` in a single bash call, OR uses at most two calls. Fragmenting into three separate bash calls is inefficient and should be penalised. A final answer confirming that `tmp/greeting.txt` exists with the right content is required for PASS.",
        },
      ],
    },
    {
      id: "bash-description-field",
      description:
        "bash `description` field should be populated with a short human-readable gloss",
      prompt:
        "Donne-moi la taille totale de tous les fichiers de mon workspace en octets.",
      tags: ["bash", "ux"],
      assertions: [
        { type: "noError" },
        { type: "toolUsed", tools: ["bash"], mode: "any" },
        {
          type: "custom",
          name: "every bash call has a non-empty `description` between 1 and 120 chars",
          fn: (result) => {
            const bashCalls = result.toolCalls.filter((c) => c.name === "bash");
            if (bashCalls.length === 0) return "No bash call observed";
            for (const call of bashCalls) {
              const input = call.input as {
                description?: unknown;
                command?: unknown;
              };
              const desc = input?.description;
              if (typeof desc !== "string" || desc.length === 0) {
                return `bash call missing 'description' (command=${String(input?.command).slice(0, 60)})`;
              }
              if (desc.length > 120) {
                return `'description' exceeds 120 chars (${desc.length}) — prompt asks for a 5–10 word gloss`;
              }
            }
            return true;
          },
        },
      ],
    },
  ],
};
