import { canonicalProviderKey } from "../../../external-apps/canonical-provider-key";
import { getAction } from "../../../external-apps/registry";
import type { PageDefinition } from "../../../schemas/pages";
import { validateActionArgs } from "../../external-apps/exec/validate-args";
import { resolvePageState } from "../run-page-data";
import { resolveExternalArgs } from "../sources/external";
import type { PageLintFinding } from "./types";

/**
 * An `external` dataset's arguments, checked against the app's own manifest —
 * at BUILD time, with no HTTP call.
 *
 * Measured in production 2026-09-14. A builder declared `"sort": "date"` where
 * the action takes a list, so the app refused every request and the page got
 * no rows at all. Nothing caught it: the lints read the CODE, the compiler
 * reads the SFCs, and the only component that validates these arguments is the
 * runtime — which reports to the viewer, hours later. The page shipped, the
 * summary said it worked, and the review then spent its whole budget on a
 * blocker about empty data whose cause was one word in `page.json`.
 *
 * The check is the same call the runtime makes (`validateActionArgs`), on the
 * same arguments (`resolveExternalArgs` over the variables' own defaults),
 * which is what a viewer's first load sends. Refusing at build costs a build;
 * not refusing costs a page, a review budget and the user's trust in it.
 *
 * What it stays silent on: an unknown provider (a custom MCP key has no
 * manifest — save-time connection validation owns that), and a dataset pinned
 * by `connectionId` alone, whose provider needs a database read.
 */
export const lintExternalDatasetArgs = (
  definition: PageDefinition,
): PageLintFinding[] => {
  const findings: PageLintFinding[] = [];
  const state = resolvePageState(definition, {});

  for (const dataset of definition.datasets) {
    if (dataset.kind !== "external") continue;
    if (dataset.providerKey === undefined || dataset.operation === undefined) {
      continue;
    }
    const qualifiedName = `${canonicalProviderKey(dataset.providerKey)}.${dataset.operation}`;
    const resolved = getAction(qualifiedName);
    if (resolved === undefined) continue;

    const finding = (message: string): PageLintFinding => ({
      path: "page.json",
      line: 0,
      rule: "external-dataset-args",
      severity: "error",
      message: `dataset "${dataset.id}": ${message}`,
    });

    if (resolved.action.kind !== "read") {
      findings.push(
        finding(
          `"${dataset.operation}" is a write. A dataset may only read; a write belongs to a page operation.`,
        ),
      );
      continue;
    }

    const args = resolveExternalArgs(dataset.args ?? {}, state);
    if (!args.ok) {
      findings.push(finding(args.error));
      continue;
    }
    try {
      validateActionArgs(qualifiedName, resolved.action, args.args);
    } catch (error) {
      findings.push(
        finding(
          `${dataset.operation} refused these arguments — ${error instanceof Error ? error.message : String(error)}. Probe the call with pageProbe and copy the shape it accepts.`,
        ),
      );
    }
  }
  return findings;
};
