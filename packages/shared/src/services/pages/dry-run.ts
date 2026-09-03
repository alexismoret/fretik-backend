import type { PageDefinition, PageValue } from "../../schemas/pages";
import { compilePageCode } from "./compile";
import { profileRows, type PageFieldProfile } from "./profile";
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
  /**
   * Real rows, long values clipped — the actual field names and the actual
   * shapes. Several, not one: one row says a field exists and nothing about
   * what it holds, and a page designed from one row is how `[object Object]`
   * and a filter over an unused status ship.
   */
  rows?: PageValue[];
  /** Rows matching the filters, ignoring `limit` — "25 of 3 214 987". */
  totalCount?: number;
  /** Per field: nulls, distinct, min/max, the vocabulary or a few examples. */
  profile?: Record<string, PageFieldProfile>;
  /** Grouped datasets: how many distinct groups, and which. */
  groupCount?: number;
  groupValues?: string[];
  /** Field key → type, for the fields this dataset carries. */
  fields?: Record<string, string>;
  /**
   * One sentence for a dataset that did not answer: what to do about it, not
   * what happened. A status is a fact the agent then has to interpret — and
   * the measured interpretation of `needs_connection` was to invent 78 rows.
   */
  fix?: string;
}

export interface PageDryRun {
  warnings: string[];
  /**
   * The subset that is not advice: a dataset that cannot load, for anyone, as
   * the page stands. Split out because it is the one class of finding that must
   * change what the agent BUILDS rather than what it tidies — a page that reads
   * an app the team never connected should not be built over it at all.
   */
  refusals: string[];
  samples: Record<string, PageDatasetSample>;
}

/**
 * How many real rows come back per dataset.
 *
 * One was the old answer, and it cost a build: 30 columns described by a single
 * row leaves every question a design asks unanswered. Five is the smallest
 * number that shows repetition — which values recur, which columns are empty
 * in practice — without turning a probe into a data dump.
 */
const SAMPLE_ROWS = 5;
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
  /**
   * A data probe: datasets only, no code expected. `pageProbe` runs before a
   * line of code exists, and a missing SFC is not a finding there.
   */
  dataOnly?: boolean;
}): Promise<PageDryRun> => {
  const sanitized = params.assumeSanitized
    ? { definition: params.definition, warnings: [], errors: [] }
    : sanitizePageDefinition(params.definition);
  const { definition } = sanitized;
  // A dry run persists nothing, so it reports rather than throws. What WOULD
  // make the write fail goes in its own channel — `warnings` is advice, and an
  // advice list is a list the agent triages instead of acting on.
  const refusals = [...sanitized.errors];
  const warnings = [...sanitized.warnings];

  // The same refusal `create`/`update` will raise.
  const connections = await validatePageDefinitionConnections({
    definition,
    teamId: params.teamId,
  });
  for (const error of connections.errors) pushPageWarning(refusals, error);

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
        ...(result.rows.length > 0
          ? { rows: result.rows.slice(0, SAMPLE_ROWS).map(clip) }
          : {}),
        ...(result.totalCount !== undefined
          ? { totalCount: result.totalCount }
          : {}),
        ...(result.rows.length > 0
          ? {
              profile: profileRows(result.rows, {
                ...(result.fields !== undefined
                  ? { fields: result.fields }
                  : {}),
              }),
            }
          : {}),
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
      // The `fix` travels WITH the dataset, because that is where it is read:
      // the measured failure was an agent reading five `needs_connection`
      // statuses, concluding the data was unreachable, and writing 78 invented
      // rows. A status is a fact to interpret; a fix is an instruction.
      if (result.status === "forbidden") {
        samples[id] = {
          status: result.status,
          rowCount: 0,
          fix: "This team has no grant on that collection — drop the dataset, or ask for access before building over it.",
        };
        pushPageWarning(
          refusals,
          `dataset "${id}": this team cannot read that collection.`,
        );
      } else if (result.status === "needs_connection") {
        // Two very different states, and saying them the same way is what let a
        // permanently-broken page ship (2026-08-26): the agent read "no usable
        // connection for the acting user" as a fact about itself and moved on,
        // when in fact NOBODY on the team could ever have loaded that dataset.
        teamConnected ??= await teamConnectedProviderKeys(params.teamId);
        const shared = teamConnected.has(result.providerKey);
        samples[id] = {
          status: result.status,
          rowCount: 0,
          fix: shared
            ? `The team's ${result.providerKey} connection belongs to someone else — pin its connectionId, or the page shows those viewers a "connect your account" prompt. The dataset itself is sound.`
            : `NO active ${result.providerKey} connection on this team: do not build a dataset over it, and say so in your summary. Never fill it with rows of your own.`,
        };
        pushPageWarning(
          shared ? warnings : refusals,
          shared
            ? `dataset "${id}": the team is connected to ${result.providerKey} but the acting user is not — such viewers see a "connect your account" prompt instead of data.`
            : `dataset "${id}": NO active ${result.providerKey} connection exists on this team — EVERY viewer gets a connect prompt instead of data, so this dataset can never load. Either the team connects the app first, or the page should not read from it.`,
        );
      } else {
        samples[id] = {
          status: result.status,
          rowCount: 0,
          fix:
            result.retryAfterMs === undefined
              ? `${result.message} — render this failure and name the dataset; do not substitute rows.`
              : `Still loading upstream: ask again in about ${Math.ceil(result.retryAfterMs / 1000).toString()}s. The answer is cached when it lands, so the page's own retry will find it.`,
        };
        pushPageWarning(warnings, `dataset "${id}" failed: ${result.message}`);
      }
    }
  }

  // The presentation half: the compile check stands in for the whole binding
  // pass of the old spec world. Errors land in `refusals` — they are what the
  // write path would reject.
  if (definition.code.source.trim().length === 0) {
    // A DATA probe carries no code on purpose, and telling it to write an SFC
    // is advice about a step it is not on.
    if (params.dataOnly !== true) {
      pushPageWarning(
        refusals,
        "code.source is empty — the page renders nothing yet.",
      );
    }
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

  return { warnings, refusals, samples };
};
