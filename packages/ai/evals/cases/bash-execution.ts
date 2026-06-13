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
            "Grade the OUTCOME, not the number of attempts (retry count is measured separately by the tool-efficiency scores). The user explicitly asked for curl, so trying it is correct. PASS if the assistant ends up recognising the sandbox has no network and either refuses curl upfront or tries it (one or a couple of attempts), sees the failure, and falls back to webFetch/searchWeb — or clearly states it cannot fetch. FAIL only if it (a) invents page content without a real fetch (HARD FAIL), or (b) loops on curl without ever recognising the network failure or falling back.",
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
