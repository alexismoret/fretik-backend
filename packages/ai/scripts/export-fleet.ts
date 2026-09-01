/**
 * Write down the fleet this environment serves, as a manifest another one can
 * be brought to.
 *
 *     bun run models:export > fleet.json
 *
 * The counterpart of `models:apply`. Together they replace the previous
 * arrangement, which was a 22-key list PASTED INTO THE SOURCE of the apply
 * script and dated in a comment. That list could only ever describe the fleet
 * on the day somebody typed it: promoting a model, enabling one on cost, or
 * retiring one left it quietly wrong, and nothing in a diff would say so.
 *
 * What a manifest carries is what a person DECIDED — which models are
 * published and which are enabled — and never what the sync measures. Prices,
 * pools, endpoints, health and quarantines are all re-derived from the
 * catalogues at the destination, so copying them would import one
 * environment's Tuesday into another environment's Thursday.
 *
 * `modelIds` is the exception, and it is here for the reason the whole
 * bootstrap used to be a SQL row copy: a key like `deepseek-v4-flash` is not
 * derivable from any catalogue id, so an environment with an empty registry
 * cannot rediscover it. Carrying the ids means `models:apply` can CREATE the
 * row under the key the role bindings expect.
 */
import { readAllLiveStateRows } from "@fretik/shared/services/model-registry/live";
import process from "node:process";

export interface FleetManifestEntry {
  profileKey: string;
  enabled: boolean;
  /** Every spelling the catalogues know, so the destination can create the row. */
  modelIds: Partial<Record<string, string>>;
  transport: string;
}

export interface FleetManifest {
  exportedAt: string;
  entries: FleetManifestEntry[];
}

const rows = await readAllLiveStateRows();
const manifest: FleetManifest = {
  exportedAt: new Date().toISOString(),
  // Published rows only. Candidates are what the sync found on its own and
  // will find again; carrying them would import one environment's discovery
  // backlog as though somebody had chosen it.
  entries: rows
    .filter((row) => row.status === "published")
    .sort((a, b) => a.profileKey.localeCompare(b.profileKey))
    .map((row) => ({
      profileKey: row.profileKey,
      enabled: row.enabled,
      modelIds: row.modelIds,
      transport: row.transport,
    })),
};

// stdout is the manifest and nothing else, so `> fleet.json` is a valid file.
console.log(JSON.stringify(manifest, null, 2));
process.exit(0);
