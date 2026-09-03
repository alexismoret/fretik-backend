import type { PageDefinition, PageValue } from "../../schemas/pages";
import { compilePageCode } from "./compile";
import { resolvePageState, runPageData } from "./run-page-data";
import { pushPageWarning, sanitizePageDefinition } from "./sanitize";
import {
  teamConnectedProviderKeys,
  validatePageDefinitionConnections,
} from "./validate-connections";

/**
 * Dry-run a page against REAL data before it is handed to anyone: run every
 * dataset, compile the code, and hand the failures BACK TO THE AGENT as
 * warnings — the mistake gets caught in the turn that made it, not by the
 * user opening a broken page.
 *
 * It doubles as the agent's free PROBE. `samples` reports row counts, the
 * distinct values of a grouping column, the real field names and one real row
 * per dataset — every question the agent used to answer by writing
 * exploratory SQL.
 */

export interface PageDatasetSample {
  status: string;
  rowCount: number;
  /** One real row, long values clipped. Shows the actual field names. */
  sample?: PageValue;
  /** Grouped datasets: how many distinct groups, and which. */
  groupCount?: number;
  groupValues?: string[];
  /** Field key → type, for the fields this dataset carries. */
  fields?: Record<string, string>;
}

export interface PageDryRun {
  warnings: string[];
  /** Works, but reads as unfinished. */
  samples: Record<string, PageDatasetSample>;
}

const CLIP_CHARS = 160;
const clip = (value: PageValue): PageValue => {
  if (typeof value === "string") {
    return value.length > CLIP_CHARS ? `${value.slice(0, CLIP_CHARS)}…` : value;
  }
  if (Array.isArray(value)) return value.slice(0, 8).map(clip);
  if (typeof value === "object" && value !== null) {
    const mapped: Record<string, PageValue> = {};
    for (const [key, inner] of Object.entries(value)) mapped[key] = clip(inner);
    return mapped;
  }
  return value;
};

const asRecord = (value: PageValue): Record<string, PageValue> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : null;

export const dryRunPage = async (params: {
  definition: PageDefinition;
  teamId: string;
  /** The acting user — external datasets resolve THEIR connection, exactly as
   * the page will for that same person viewing it. Null when unknown. */
  userId: string | null;
  /**
   * The caller already ran `sanitizePageDefinition` and is passing the result.
   * `create`/`update` do: they hand over the STORED definition, which is the
   * sanitized one.
   */
  assumeSanitized?: boolean;
  /** The caller already compiled this exact source (a write just did) — skip
   * the compile check instead of paying it twice. */
  assumeCompiled?: boolean;
}): Promise<PageDryRun> => {
  const sanitized = params.assumeSanitized
    ? { definition: params.definition, warnings: [], errors: [] }
    : sanitizePageDefinition(params.definition);
  const { definition } = sanitized;
  // A dry run persists nothing, so it reports rather than throws — but the
  // refusals go in FIRST and in the same channel: what would make the write
  // fail must be the first thing the agent reads, not the last.
  const warnings = [...sanitized.errors, ...sanitized.warnings];

  // The same refusal `create`/`update` will raise, said here as a warning: a
  // dry run persists nothing, so it reports rather than throws — but it must
  // report it as a DEFECT, or the agent writes the page and hits the 400.
  const connections = await validatePageDefinitionConnections({
    definition,
    teamId: params.teamId,
  });
  for (const error of connections.errors) pushPageWarning(warnings, error);

  const samples: PageDryRun["samples"] = {};
  // Run against the page's own defaults — the state a first visitor sees.
  resolvePageState(definition, {});

  const { datasets } = await runPageData({
    definition,
    teamId: params.teamId,
    userId: params.userId,
    variables: {},
  });

  const datasetById = new Map(definition.datasets.map((d) => [d.id, d]));
  /** Fetched at most once, and only if a dataset actually came back unconnected. */
  let teamConnected: Set<string> | undefined;

  for (const [id, result] of Object.entries(datasets)) {
    if (result.status === "ok") {
      const declared = datasetById.get(id);
      const sample: PageDatasetSample = {
        status: "ok",
        rowCount: result.rows.length,
        sample: result.rows[0] === undefined ? undefined : clip(result.rows[0]),
      };

      // The grouping dimension's real values — the answer to "how many
      // statuses are there, and what are they called".
      if (declared?.groupBy || declared?.mode === "aggregate") {
        const groups = new Set<string>();
        for (const row of result.rows) {
          const value = asRecord(row)?.["group"];
          if (typeof value === "string") groups.add(value);
        }
        if (groups.size > 0) {
          sample.groupCount = groups.size;
          sample.groupValues = [...groups].slice(0, 12);
        }
      }

      if (result.fields && result.fields.length > 0) {
        sample.fields = Object.fromEntries(
          result.fields.map((field) => [field.key, field.type]),
        );
      }

      samples[id] = sample;
      if (result.rows.length === 0) {
        pushPageWarning(
          warnings,
          `dataset "${id}" returned no rows — check its filters, or the collection may be empty.`,
        );
      }
    } else {
      samples[id] = { status: result.status, rowCount: 0 };
      if (result.status === "forbidden") {
        pushPageWarning(
          warnings,
          `dataset "${id}": this team cannot read that collection.`,
        );
      } else if (result.status === "needs_connection") {
        // Two very different states, and saying them the same way is what let a
        // permanently-broken page ship (2026-08-26): the agent read "no usable
        // connection for the acting user" as a fact about itself and moved on,
        // when in fact NOBODY on the team could ever have loaded that dataset.
        teamConnected ??= await teamConnectedProviderKeys(params.teamId);
        pushPageWarning(
          warnings,
          teamConnected.has(result.providerKey)
            ? `dataset "${id}": the team is connected to ${result.providerKey} but the acting user is not — such viewers see a "connect your account" prompt instead of data.`
            : `dataset "${id}": NO active ${result.providerKey} connection exists on this team — EVERY viewer gets a connect prompt instead of data, so this dataset can never load. Either the team connects the app first, or the page should not read from it.`,
        );
      } else {
        pushPageWarning(warnings, `dataset "${id}" failed: ${result.message}`);
      }
    }
  }

  // The presentation half: the compile check stands in for the whole binding
  // pass of the old spec world. Errors land in `warnings` — a dry run persists
  // nothing, so refusal semantics belong to the write path.
  if (definition.code.source.trim().length === 0) {
    pushPageWarning(
      warnings,
      "code.source is empty — the page renders nothing yet. Write the complete SFC and send it with update.",
    );
  } else if (!params.assumeCompiled) {
    const compiled = await compilePageCode({
      source: definition.code.source,
      files: definition.code.files,
    });
    if (!compiled.ok) {
      for (const error of compiled.errors) {
        pushPageWarning(
          warnings,
          `code ${error.file !== undefined ? `${error.file} ` : ""}[${error.block}]: ${error.message}${
            error.line !== undefined ? ` (line ${error.line.toString()})` : ""
          }`,
        );
      }
    }
  }

  return { warnings, samples };
};
