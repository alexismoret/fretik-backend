/**
 * `model-admin` — the operator surface of the model engine.
 *
 *     bun run models:admin -- list
 *     bun run models:admin -- show deepseek-v4-flash
 *     bun run models:admin -- scorecard zai-glm-5-2
 *     bun run models:admin -- add moonshotai/kimi-k3
 *     bun run models:admin -- quarantine deepseek-v4-flash novita --reason "…"
 *
 * # What this is for
 *
 * The engine writes `model_live_state`, and everything a running process reads
 * about a model — which transport serves it, which upstreams it may land on,
 * what its real context ceiling is, whether it is quarantined — comes from that
 * one row. Every write here therefore takes effect on the NEXT MODEL
 * CONSTRUCTION anywhere in the fleet: `invalidateLiveRegistry` drops the
 * in-process snapshot on every replica through Redis, and `clearResolvedModelCache`
 * throws away the memoized model instances built from the old state. No deploy,
 * no restart, no window during which one replica routes differently from another.
 *
 * That property is the whole reason the engine exists, and it is also why this
 * CLI prints what a change MEANS rather than just confirming it landed. Every
 * exclusion in this codebase used to be a compile-time constant: removing an
 * upstream that had started corrupting output took a pull request and a release,
 * and two such exclusions quietly expired and had to be relearned from a second
 * production incident.
 *
 * # The two layers, and which one each subcommand touches
 *
 * Curation (TypeScript, `src/lib/model-registry/profiles/`) says what a model IS
 * and how we decided to run it. Live state (this table) says what is TRUE about
 * it right now. Nothing here edits curation — `set-transport`, `enable`,
 * `disable`, `promote`, `retire`, `quarantine` and `release` all write the
 * second layer only, which is what makes them instant and what makes them
 * survivable: a bad call is undone by the opposite call, not by a revert.
 *
 * The two layers each hold a VETO and neither can force the other to enable. A
 * profile marked `enabled: false` in TypeScript disappears on deploy whatever
 * this CLI says; a model disabled here disappears whatever the profile says.
 *
 * # Reading the output
 *
 * `list` and `show` report state; `scorecard` is the promotion aid. The three
 * numbers that decide most questions are on every model:
 *
 *   - **effective context** is the SMALLEST endpoint in the allowed pool minus a
 *     safety margin, never the catalogue headline. Routing picks per request, so
 *     budgeting against the largest overflows the moment a turn lands on the
 *     smallest — endpoints for one model spanned 40 960 to 262 144 tokens when
 *     this was measured.
 *   - **pool** is what actually goes on the wire (`effectivePoolFor`), i.e. the
 *     vetted `only` list minus live quarantines, or `open` when quarantines
 *     exhausted the vetted list and routing was widened. It is NOT the declared
 *     pool, which `show` prints alongside it so the two can be compared.
 *   - **health** is a 0-100 composite dominated by uptime, penalised by policy
 *     failures and by our own incident traffic. It is a grade, not a gate.
 *
 * # Exit codes
 *
 * 0 on success, 1 on a refusal (with a message naming the fix), 2 on a usage
 * error. Nothing here is interactive and nothing prompts for confirmation: a
 * quarantine that waits for a keystroke is a quarantine that does not happen at
 * three in the morning.
 */
import type { ModelAlertRow, ModelBenchRunRow } from "@fretik/shared/db/schema";
import { isModelFunctionKey } from "@fretik/shared/model-registry/functions";
import {
  DEFAULT_CANDIDATE_POLICY,
  PROMOTION_PRICE_CAPS,
  evaluatePolicy,
  promotionEnablement,
} from "@fretik/shared/model-registry/policy";
import {
  INCIDENT_KINDS,
  isTransportId,
  type EndpointStat,
  type IncidentKind,
  type LiveModelState,
  type PolicyReport,
  type TransportId,
} from "@fretik/shared/model-registry/types";
import {
  buildAllowedPool,
  computeEffectiveContext,
  computePoolPricing,
  deriveDynamicProfile,
} from "@fretik/shared/services/model-registry/sync/compute";
import { fetchGatewayCatalog } from "@fretik/shared/services/model-registry/sync/sources/gateway-catalog";
import { fetchGatewayEndpoints } from "@fretik/shared/services/model-registry/sync/sources/gateway-endpoints";
import { desc, eq } from "drizzle-orm";

/** `disabled_reason` is a typed column with no exported runtime tuple. */
const DISABLED_REASONS = ["cost", "no-zdr", "unavailable", "policy"] as const;

/**
 * The default `--kind` for a HAND quarantine.
 *
 * The column is typed to the five detector kinds, so an operator acting on
 * something they saw still has to file under one of them. `upstream-cut` is the
 * least specific claim of the five — a generation that ended badly for a reason
 * upstream — and `--reason` is where what actually happened is recorded. Pick a
 * sharper kind when one fits: the kind is what the release re-probe and the
 * alert digest read back.
 */
const DEFAULT_QUARANTINE_KIND: IncidentKind = "upstream-cut";

/** How much incident history a promotion decision looks at, versus `show`. */
const SHOW_INCIDENT_WINDOW_HOURS = 24;
const SCORECARD_INCIDENT_WINDOW_HOURS = 24 * 7;

/** Recent bench rows shown on a scorecard. Enough to see a trend, not a log. */
const BENCH_RUN_LIMIT = 12;

const VALUE_FLAGS = new Set(["key", "reason", "kind", "limit", "ack"]);

const COMMANDS = [
  "list",
  "show",
  "scorecard",
  "add",
  "promote",
  "retire",
  "enable",
  "disable",
  "set-transport",
  "quarantine",
  "release",
  "alerts",
  "audit",
] as const;

const USAGE = `model-admin — operator surface for the model engine (model_live_state).

  bun run models:admin -- <command> [args] [flags]

Read
  list [--all]                       One line per model: status, transport, health,
                                     usable context, wire pool, quarantines, last sync.
                                     Without --all, published models only.
  show <profileKey>                  The full row: routing, the stored policy report
                                     rule by rule, every endpoint, active quarantines
                                     with release dates, and the last ${SHOW_INCIDENT_WINDOW_HOURS.toString()} h of incidents.
  scorecard <profileKey>             The promotion aid: Artificial Analysis figures,
                                     gateway endpoints, recent models:bench rows, the
                                     verdict against DEFAULT_CANDIDATE_POLICY, and the
                                     last ${(SCORECARD_INCIDENT_WINDOW_HOURS / 24).toString()} days of incidents.
  alerts [--limit N]                 What the engine decided, newest first.
  audit                              Every way the engine can contradict itself,
                                     checked offline: rows with no id for their
                                     transport, teams pointing a function at a model
                                     it cannot serve, curation and the row disagreeing
                                     on enabled, pools naming upstreams no endpoint
                                     answers to, orphan display/gateway entries, a
                                     fallback pointing at its own primary. Exit 1 on
                                     any finding — safe in CI, changes nothing.

Write — every one of these takes effect on the next model construction
fleet-wide, with no deploy and no restart.
  add <creator/model> [--key <k>]    Fetch the gateway catalogue + endpoints for that
                                     id, derive a profile from catalogue facts, insert
                                     it as a CANDIDATE (invisible to teams), print its
                                     scorecard. --key overrides the derived slug.
  promote <profileKey>               Candidate -> published + enabled. The deliberate
                                     second step: discovery is automatic, publication
                                     is not.
  retire <profileKey>                Out of every picker, history kept.
  enable <profileKey>                Selectable again; clears the policy-fail streak.
  disable <profileKey> [--reason ${DISABLED_REASONS.join("|")}]
                                     Unselectable. Running turns are unaffected.
  set-transport <profileKey> <gateway|openrouter>
                                     THE rollback. Moves a model between transports
                                     using the pool already stored for the target.
  quarantine <profileKey> <provider> [--kind <k>] [--reason "…"]
                                     Pull one upstream out of one model's pool by hand.
                                     Kinds: ${INCIDENT_KINDS.join(", ")}
                                     (default ${DEFAULT_QUARANTINE_KIND}).
  release <profileKey> <provider>    Put it back.
  alerts --ack <alertId>             Acknowledge one alert so the digest drops it.

Exit codes: 0 ok, 1 refused (the message names the fix), 2 usage error.`;

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const rawArgs = process.argv.slice(2).filter((arg) => arg !== "--");

const positional: string[] = [];
const flags = new Map<string, string>();
let parseError: string | undefined;

for (let index = 0; index < rawArgs.length; index += 1) {
  const arg = rawArgs[index];
  if (arg === undefined) continue;
  if (!arg.startsWith("--")) {
    positional.push(arg);
    continue;
  }
  const name = arg.slice(2);
  if (!VALUE_FLAGS.has(name)) {
    flags.set(name, "true");
    continue;
  }
  const value = rawArgs[index + 1];
  if (value === undefined || value.startsWith("--")) {
    parseError ??= `--${name} needs a value.`;
    continue;
  }
  flags.set(name, value);
  index += 1;
}

const command = positional[0];

if (command === undefined || flags.has("help")) {
  console.log(USAGE);
  process.exit(0);
}

const usageError = (message: string): never => {
  console.error(`${message}\n\n${USAGE}`);
  return process.exit(2);
};

if (parseError !== undefined) usageError(parseError);

if (!COMMANDS.some((known) => known === command)) {
  usageError(`Unknown command "${command}".`);
}

const fail = (message: string): never => {
  console.error(message);
  return process.exit(1);
};

/** The profile key every keyed subcommand needs, or a usage error naming it. */
const requiredKey = (): string =>
  positional[1] ?? usageError(`"${command}" needs a <profileKey>.`);

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** `196608` -> `196 608`. Deterministic, unlike `toLocaleString`. */
const groupDigits = (value: number): string =>
  Math.round(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, " ");

const money = (value: number | undefined, digits = 3): string =>
  value === undefined ? "—" : `$${value.toFixed(digits)}`;

const num = (value: number | undefined | null, digits = 0): string =>
  value === undefined || value === null ? "—" : value.toFixed(digits);

const stamp = (value: Date | null | undefined): string =>
  value ? value.toISOString().slice(0, 16).replace("T", " ") : "never";

const isoStamp = (value: string): string =>
  value.slice(0, 16).replace("T", " ");

const section = (title: string): void => {
  console.log(`\n${title}`);
  console.log("-".repeat(title.length));
};

/**
 * The pool that actually goes on the wire, as one cell. `open` is not "no
 * policy" — it is the breaker having widened routing because quarantines
 * exhausted the vetted list, with the quarantined hosts still excluded.
 */
const poolCell = (only: readonly string[] | undefined): string =>
  only === undefined || only.length === 0 ? "open" : only.length.toString();

const healthCell = (state: LiveModelState): string =>
  state.healthScore === null
    ? state.health
    : `${state.health} ${state.healthScore.toFixed(0)}`;

const endpointTable = (endpoints: readonly EndpointStat[]): void => {
  if (endpoints.length === 0) {
    console.log("  (no endpoint data — the sync has not measured this model)");
    return;
  }
  console.log(
    `  ${"provider".padEnd(18)}${"context".padStart(10)}${"$in".padStart(10)}${"$out".padStart(10)}${"tps p50".padStart(9)}${"up 1d".padStart(8)}${"zdr".padStart(6)}${"quant".padStart(9)}`,
  );
  for (const endpoint of [...endpoints].sort((a, b) =>
    a.provider.localeCompare(b.provider),
  )) {
    console.log(
      `  ${endpoint.displayName.padEnd(18)}` +
        groupDigits(endpoint.contextLength).padStart(10) +
        money(endpoint.pricing.inputPerMTok).padStart(10) +
        money(endpoint.pricing.outputPerMTok).padStart(10) +
        num(endpoint.throughputP50).padStart(9) +
        (endpoint.uptime1d === undefined
          ? "—"
          : `${endpoint.uptime1d.toFixed(1)}%`
        ).padStart(8) +
        // `null` on the wire means the gateway has no established stance for
        // that host, not that it retains — which is why it prints as `?` and
        // not as `no`. Routing still carries `zeroDataRetention: true`.
        (endpoint.hasZdr === undefined
          ? "?"
          : endpoint.hasZdr
            ? "yes"
            : "no"
        ).padStart(6) +
        (endpoint.quantization ?? "—").padStart(9),
    );
  }
};

/**
 * A policy report, rule by rule. Hard failures are the ones that gate; soft
 * failures inform health and never disable anything on their own. A rule the
 * policy did not set, or that no source could answer, is ABSENT rather than
 * passing — so "we did not check" never reads here as "it is fine".
 */
const policyTable = (report: PolicyReport | null): void => {
  if (report === null) {
    console.log("  (never evaluated — no sync has graded this model yet)");
    return;
  }
  console.log(
    `  evaluated ${isoStamp(report.evaluatedAt)} — ${report.passed ? "PASSED" : "FAILED"} (${report.hardFailures.toString()} hard, ${report.softFailures.toString()} soft)`,
  );
  console.log(
    `  ${"rule".padEnd(24)}${"sev".padEnd(6)}${"verdict".padEnd(9)}detail`,
  );
  for (const rule of report.rules) {
    console.log(
      `  ${rule.rule.padEnd(24)}${rule.severity.padEnd(6)}${(rule.passed ? "pass" : "FAIL").padEnd(9)}${rule.detail}`,
    );
  }
  if (report.excludedProviders.length > 0) {
    console.log("  providers dropped while building the pool:");
    for (const excluded of report.excludedProviders) {
      console.log(`    ${excluded.provider.padEnd(18)}${excluded.reason}`);
    }
  }
};

const benchTable = (rows: readonly ModelBenchRunRow[]): void => {
  if (rows.length === 0) {
    console.log(
      "  (no bench rows — run `bun run models:bench -- --profile <key> --save`)",
    );
    return;
  }
  console.log(
    `  ${"ran at".padEnd(18)}${"upstream".padEnd(16)}${"transport".padEnd(12)}${"tok/s".padStart(8)}${"best".padStart(8)}${"intact".padStart(8)}${"cold $".padStart(10)}${"warm $".padStart(10)}${"429".padStart(6)}${"fail".padStart(6)}`,
  );
  for (const row of rows) {
    const m = row.metrics;
    console.log(
      `  ${stamp(row.ranAt).padEnd(18)}${row.provider.padEnd(16)}${row.transport.padEnd(12)}` +
        num(m.tokensPerSecondMedian, 1).padStart(8) +
        num(m.tokensPerSecondBest, 1).padStart(8) +
        (m.intactTotal === undefined
          ? "—"
          : `${(m.intactPassed ?? 0).toString()}/${m.intactTotal.toString()}`
        ).padStart(8) +
        num(m.coldCostUsd, 5).padStart(10) +
        num(m.warmCostUsd, 5).padStart(10) +
        num(m.http429Count).padStart(6) +
        num(m.failures).padStart(6),
    );
  }
  const noted = rows.filter((row) => row.metrics.note !== undefined);
  for (const row of noted) {
    console.log(`  note  ${row.provider}: ${row.metrics.note ?? ""}`);
  }
};

const incidentTable = (
  rows: readonly { provider: string; kind: IncidentKind; total: number }[],
  windowHours: number,
): void => {
  if (rows.length === 0) {
    console.log(
      `  none in the last ${windowHours.toString()} h — our own traffic saw nothing wrong.`,
    );
    return;
  }
  console.log(`  ${"upstream".padEnd(18)}${"kind".padEnd(26)}count`);
  for (const row of rows) {
    console.log(
      `  ${row.provider.padEnd(18)}${row.kind.padEnd(26)}${row.total.toString()}`,
    );
  }
};

/**
 * `alibaba/qwen-3-235b` -> `alibaba-qwen-3-235b`, inside the 64-char key column.
 *
 * Deliberately IDENTICAL to `candidateKey` in the sync's `run.ts`: a model added
 * by hand and the same model found later by discovery have to collide on one
 * row rather than end up as two, and the collision is what makes the second
 * insert a no-op instead of a duplicate.
 */
const slugForModelId = (modelId: string): string =>
  modelId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

/**
 * Everything below reads or writes the database, and importing
 * `@fretik/shared/db` RUNS MIGRATIONS at module load and throws outright
 * without `DATABASE_URL`. `--help` has to work on a machine with no database
 * and no environment at all, so the registry services are pulled in HERE rather
 * than at the top of the file — the same deferral, for the same reason, that
 * `check-model-catalog.ts` applies to its own key-bearing imports.
 */
const { default: db } = await import("@fretik/shared/db");
const { modelAlerts, modelBenchRuns } =
  await import("@fretik/shared/db/schema");
const {
  acknowledgeAlert,
  addCatalogueModel,
  promoteCandidate,
  retireModel,
  setEnabled,
  setTransport,
} = await import("@fretik/shared/services/model-registry/admin");
const {
  BREAKER_QUARANTINE_DAYS,
  BREAKER_THRESHOLDS,
  activeQuarantines,
  effectivePoolFor,
  quarantineProvider,
  releaseProvider,
} = await import("@fretik/shared/services/model-registry/breaker");
const { listRecentAlerts } =
  await import("@fretik/shared/services/model-registry/alerts");
const { summarizeIncidents } =
  await import("@fretik/shared/services/model-registry/incidents");
const { readAllLiveStateRows, readLiveStateRow } =
  await import("@fretik/shared/services/model-registry/live");

const now = new Date();

const mustRead = async (profileKey: string): Promise<LiveModelState> => {
  const state = await readLiveStateRow(profileKey);
  if (state) return state;
  const known = (await readAllLiveStateRows())
    .map((row) => row.profileKey)
    .sort();
  return fail(
    `Unknown model "${profileKey}". Known keys:\n  ${known.join("\n  ")}\n\nAdd a model the catalogue serves with: models:admin -- add <creator/model>`,
  );
};

const loadBenchRuns = async (profileKey: string): Promise<ModelBenchRunRow[]> =>
  db
    .select()
    .from(modelBenchRuns)
    .where(eq(modelBenchRuns.profileKey, profileKey))
    .orderBy(desc(modelBenchRuns.ranAt))
    .limit(BENCH_RUN_LIMIT);

/**
 * What routing looks like right now for a model, in one place. `declared` is
 * what curation vetted, `wire` is what the breaker leaves of it — comparing the
 * two is how an operator sees a quarantine's effect without reading JSON.
 */
const routingLines = (state: LiveModelState): string[] => {
  const declared = state.providerPool[state.transport];
  const wire = effectivePoolFor(state, state.transport, now);
  return [
    `  declared pool  only=[${(declared?.only ?? []).join(", ")}] order=[${(declared?.order ?? []).join(", ")}] ignore=[${(declared?.ignore ?? []).join(", ")}]`,
    `  wire pool      only=[${(wire.only ?? []).join(", ")}] ignore=[${(wire.ignore ?? []).join(", ")}]${wire.only === undefined ? "   (open routing minus the exclusions)" : ""}`,
    `  widened        ${state.poolWidened ? "YES — the vetted pool was exhausted by quarantines" : "no"}`,
    `  last resort    ${state.lastResort ? "YES — roles fall back to their fallback MODEL, teams degrade to the default" : "no"}`,
  ];
};

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const runList = async (): Promise<void> => {
  const all = flags.has("all");
  const rows = (await readAllLiveStateRows())
    .filter((state) => all || state.status === "published")
    .sort(
      (a, b) =>
        a.status.localeCompare(b.status) ||
        a.profileKey.localeCompare(b.profileKey),
    );

  if (rows.length === 0) {
    console.log(
      all
        ? "No rows in model_live_state. The seed runs at service boot — start @fretik/ai once."
        : "No published models. Re-run with --all to see candidates and retired rows.",
    );
    return;
  }

  // Sized to the longest key actually present, not to a guess. Auto-discovered
  // keys are derived from catalogue ids and run long
  // (`alibaba-qwen-3-6-max-preview` is 28), so a fixed width silently welded
  // the name to the next column and made the row unreadable exactly for the
  // models an operator is least familiar with.
  const keyWidth = Math.max(
    "profile".length,
    ...rows.map((state) => state.profileKey.length),
  );
  console.log(
    `${"profile".padEnd(keyWidth)} ${"status".padEnd(11)}${"transport".padEnd(12)}${"on".padEnd(5)}${"health".padEnd(14)}${"context".padStart(10)}${"pool".padStart(7)}${"quar".padStart(6)}  last sync`,
  );
  for (const state of rows) {
    const wire = effectivePoolFor(state, state.transport, now);
    console.log(
      `${state.profileKey.padEnd(keyWidth)} ` +
        state.status.padEnd(11) +
        state.transport.padEnd(12) +
        (state.enabled ? "yes" : "no").padEnd(5) +
        healthCell(state).padEnd(14) +
        groupDigits(state.effectiveContextLength).padStart(10) +
        poolCell(wire.only).padStart(7) +
        activeQuarantines(state, now).length.toString().padStart(6) +
        `  ${stamp(state.syncedAt)}`,
    );
  }

  const degraded = rows.filter((state) => state.lastResort);
  const disabled = rows.filter((state) => !state.enabled);
  console.log(
    `\n${rows.length.toString()} model(s)${all ? "" : " (published only — --all adds candidates and retired)"}.`,
  );
  console.log(
    "`pool` is what goes ON THE WIRE — the vetted list minus live quarantines. `open` means routing was widened because quarantines exhausted it.",
  );
  if (disabled.length > 0) {
    console.log(
      `${disabled.length.toString()} disabled: ${disabled.map((s) => `${s.profileKey} (${s.disabledReason ?? "no reason recorded"})`).join(", ")}`,
    );
  }
  if (degraded.length > 0) {
    console.log(
      `${degraded.length.toString()} LAST RESORT — every upstream quarantined on every transport, so roles bound to them serve from their fallback model: ${degraded.map((s) => s.profileKey).join(", ")}`,
    );
  }
};

const runShow = async (): Promise<void> => {
  const state = await mustRead(requiredKey());

  section(`model  ${state.profileKey}`);
  console.log(
    `  status         ${state.status}, ${state.enabled ? "enabled" : `DISABLED (${state.disabledReason ?? "no reason recorded"})`}`,
  );
  console.log(
    `  transport      ${state.transport}   ids: ${Object.entries(state.modelIds)
      .map(([transport, id]) => `${transport}=${id}`)
      .join("  ")}`,
  );
  console.log(`  health         ${healthCell(state)} / 100`);
  console.log(
    `  context        ${groupDigits(state.effectiveContextLength)} usable (smallest allowed endpoint, minus the safety margin), max output ${state.effectiveMaxOutput === null ? "unreported" : groupDigits(state.effectiveMaxOutput)}`,
  );
  console.log(
    `  pricing        ${money(state.pricing.inputPerMTok)} in / ${money(state.pricing.outputPerMTok)} out per MTok, cache read ${money(state.pricing.cacheReadPerMTok)}, credit multiplier ${num(state.creditMultiplier, 2)}`,
  );
  for (const line of routingLines(state)) console.log(line);
  console.log(
    `  bound roles    ${state.boundRoles.length === 0 ? "none — no internal role depends on this model" : state.boundRoles.join(", ")}`,
  );
  console.log(
    `  source         ${state.source}, last sync ${stamp(state.syncedAt)}`,
  );
  if (state.dynamicProfile !== null) {
    const dynamic = state.dynamicProfile;
    console.log(
      `  profile        catalogue-derived: ${dynamic.displayName} (${dynamic.family}), tools ${dynamic.supportsTools ? "yes" : "no"}, reasoning ${dynamic.supportsReasoning ? "yes" : "no"}, from ${dynamic.derivedFrom.source} at ${isoStamp(dynamic.derivedFrom.at)}`,
    );
  }

  section("policy report (as the last sync recorded it)");
  policyTable(state.policyReport);

  section(`endpoints (${state.endpointStats.length.toString()})`);
  endpointTable(state.endpointStats);

  const quarantines = activeQuarantines(state, now);
  section(`active quarantines (${quarantines.length.toString()})`);
  if (quarantines.length === 0) {
    console.log("  none");
  } else {
    console.log(
      `  ${"upstream".padEnd(18)}${"transport".padEnd(12)}${"kind".padEnd(26)}${"since".padEnd(12)}${"release".padEnd(12)}reason`,
    );
    for (const entry of quarantines) {
      console.log(
        `  ${entry.provider.padEnd(18)}${entry.transport.padEnd(12)}${entry.kind.padEnd(26)}${entry.quarantinedAt.slice(0, 10).padEnd(12)}${entry.releaseAt.slice(0, 10).padEnd(12)}${entry.reason}`,
      );
    }
    console.log(
      "  The release date is a REVIEW TRIGGER, not an amnesty: the sync re-probes on it and extends the quarantine when the probe still fails.",
    );
  }

  section(`incidents, last ${SHOW_INCIDENT_WINDOW_HOURS.toString()} h`);
  incidentTable(
    await summarizeIncidents({
      modelKey: state.profileKey,
      windowHours: SHOW_INCIDENT_WINDOW_HOURS,
      now,
    }),
    SHOW_INCIDENT_WINDOW_HOURS,
  );
};

/**
 * The promotion aid. Everything a person needs in order to answer one question:
 * would we run a team's work on this model?
 *
 * The policy it grades against is DEFAULT_CANDIDATE_POLICY — the strict
 * DISCOVERY policy — not the looser one a published model is held to. That is
 * deliberate: this screen is read when deciding to START running something, and
 * the looser policy answers "is it still serviceable", which is a different
 * question asked at a different time.
 */
const printScorecard = (input: {
  state: LiveModelState;
  endpoints: readonly EndpointStat[];
  endpointSource: string;
  excluded: readonly { provider: string; reason: string }[];
  benchRuns: readonly ModelBenchRunRow[];
  incidents: readonly { provider: string; kind: IncidentKind; total: number }[];
}): PolicyReport => {
  const { state, endpoints, excluded, benchRuns, incidents } = input;

  section(
    `scorecard  ${state.profileKey}   (${state.status}, ${state.enabled ? "enabled" : "disabled"}, transport ${state.transport})`,
  );
  console.log(
    `  ids            ${Object.entries(state.modelIds)
      .map(([transport, id]) => `${transport}=${id}`)
      .join("  ")}`,
  );
  console.log(
    `  pool pricing   ${money(state.pricing.inputPerMTok)} in / ${money(state.pricing.outputPerMTok)} out per MTok, credit multiplier ${num(state.creditMultiplier, 2)}`,
  );
  console.log(
    `  context        ${groupDigits(state.effectiveContextLength)} usable, max output ${state.effectiveMaxOutput === null ? "unreported" : groupDigits(state.effectiveMaxOutput)}`,
  );

  section("Artificial Analysis");
  const aa = state.aaMetrics;
  if (aa === null) {
    console.log(
      "  no entry — AA does not cover this model, or its slug does not match. Judge on the endpoint figures and a bench run.",
    );
  } else {
    console.log(
      `  intelligence ${num(aa.intelligenceIndex, 1)}   coding ${num(aa.codingIndex, 1)}   agentic ${num(aa.agenticIndex, 1)}   index v${aa.indexVersion ?? "?"}`,
    );
    console.log(
      `  first answer token ${num(aa.timeToFirstAnswerTokenSeconds, 2)} s${aa.slug === undefined ? "" : `   slug ${aa.slug}`}   fetched ${aa.fetchedAt === undefined ? "unknown" : isoStamp(aa.fetchedAt)}`,
    );
    console.log(
      "  AA figures are per EFFORT LEVEL — the same model scores materially differently across its ladder, so read them against the level this profile actually runs. Prices and throughput are deliberately absent: read those off the pool pricing and the endpoint table above, which measure the routes we reach.",
    );
  }

  section(
    `endpoints allowed by the discovery policy (${endpoints.length.toString()}, from ${input.endpointSource})`,
  );
  endpointTable(endpoints);
  if (excluded.length > 0) {
    console.log("  dropped while building the pool:");
    for (const entry of excluded) {
      console.log(`    ${entry.provider.padEnd(18)}${entry.reason}`);
    }
  }

  section(
    `bench runs (model_bench_runs, ${BENCH_RUN_LIMIT.toString()} most recent)`,
  );
  benchTable(benchRuns);
  console.log(
    "  `intact` is the gate: an upstream that truncates the answer whenever a response ends in tool calls is unusable whatever its speed, and every agent turn ends exactly like that.",
  );

  const report = evaluatePolicy(
    DEFAULT_CANDIDATE_POLICY,
    {
      endpoints: [...endpoints],
      excludedProviders: [...excluded],
      aa,
      requiresTools: true,
    },
    now,
  );
  section("policy — DEFAULT_CANDIDATE_POLICY, evaluated now");
  policyTable(report);

  section(
    `incidents, last ${(SCORECARD_INCIDENT_WINDOW_HOURS / 24).toString()} days`,
  );
  incidentTable(incidents, SCORECARD_INCIDENT_WINDOW_HOURS);

  const hard = report.rules.filter((r) => r.severity === "hard" && !r.passed);
  const soft = report.rules.filter((r) => r.severity === "soft" && !r.passed);
  section("verdict");
  if (report.passed) {
    console.log(
      `  ${state.profileKey} PASSES DEFAULT_CANDIDATE_POLICY on every hard rule.`,
    );
  } else {
    console.log(
      `  ${state.profileKey} FAILS DEFAULT_CANDIDATE_POLICY — ${hard.length.toString()} hard rule(s):`,
    );
    for (const rule of hard) console.log(`    ${rule.rule}: ${rule.detail}`);
  }
  if (soft.length > 0) {
    console.log(
      `  ${soft.length.toString()} soft failure(s) — these never gate, they cost health score:`,
    );
    for (const rule of soft) console.log(`    ${rule.rule}: ${rule.detail}`);
  }
  console.log(
    "  A policy pass is a floor, not a recommendation: a catalogue says nothing about which HOST a call lands on, and tool-calling accuracy for one model has spanned 22 % to 37 % across its hosts. Bench it before promoting.",
  );
  return report;
};

/**
 * Endpoints for a scorecard, preferring what the sync stored. The stored list is
 * MERGED across both catalogue sources (it is the only place `quantization` ever
 * appears), so a live re-fetch is a fallback for a row the sync has not reached
 * yet — a freshly added candidate above all — and not an improvement on it.
 */
const scorecardEndpoints = async (
  state: LiveModelState,
): Promise<{ endpoints: EndpointStat[]; source: string }> => {
  if (state.endpointStats.length > 0) {
    return {
      endpoints: state.endpointStats,
      source: `the last sync, ${stamp(state.syncedAt)}`,
    };
  }
  const gatewayId = state.modelIds.gateway;
  if (gatewayId === undefined) {
    return {
      endpoints: [],
      source: "nothing — no stored stats, no gateway id",
    };
  }
  try {
    return {
      endpoints: await fetchGatewayEndpoints(gatewayId),
      source: "a live gateway fetch (the sync has not measured this row yet)",
    };
  } catch (err: unknown) {
    console.warn(
      `  (live endpoint fetch failed: ${err instanceof Error ? err.message : String(err)})`,
    );
    return { endpoints: [], source: "nothing — the live fetch failed" };
  }
};

const runScorecard = async (): Promise<void> => {
  const state = await mustRead(requiredKey());
  const { endpoints, source } = await scorecardEndpoints(state);
  // Graded against the DISCOVERY policy's own filters, so the endpoint list on
  // screen is the one the verdict was computed from rather than a wider set.
  const pool = buildAllowedPool({
    ...(state.providerPool[state.transport] === undefined
      ? {}
      : { declaredPool: state.providerPool[state.transport] }),
    poolWidened: state.poolWidened,
    quarantined: activeQuarantines(state, now)
      .filter((entry) => entry.transport === state.transport)
      .map((entry) => entry.provider),
    endpoints,
    requireTools: DEFAULT_CANDIDATE_POLICY.toolCallingRequired,
    requireZdr: DEFAULT_CANDIDATE_POLICY.zdrRequired,
    ...(DEFAULT_CANDIDATE_POLICY.quantizationFloor === undefined
      ? {}
      : { quantizationFloor: DEFAULT_CANDIDATE_POLICY.quantizationFloor }),
  });
  printScorecard({
    state,
    endpoints: pool.endpoints,
    endpointSource: source,
    excluded: pool.excluded,
    benchRuns: await loadBenchRuns(state.profileKey),
    incidents: await summarizeIncidents({
      modelKey: state.profileKey,
      windowHours: SCORECARD_INCIDENT_WINDOW_HOURS,
      now,
    }),
  });
};

const runAdd = async (): Promise<void> => {
  const modelId =
    positional[1] ?? usageError("add needs a <creator/model> gateway id.");

  const catalog = await fetchGatewayCatalog();
  const entry = catalog.find((candidate) => candidate.id === modelId);
  if (entry === undefined) {
    const near = catalog
      .filter((candidate) =>
        candidate.id.includes(modelId.split("/").at(-1) ?? modelId),
      )
      .slice(0, 8)
      .map((candidate) => candidate.id);
    return fail(
      `"${modelId}" is not in the Vercel AI Gateway catalogue (${catalog.length.toString()} entries read from /v1/models).${
        near.length > 0 ? `\nDid you mean:\n  ${near.join("\n  ")}` : ""
      }\nThe catalogue is public — check the exact id at https://ai-gateway.vercel.sh/v1/models. Model ids differ between transports (\`x-ai/grok-4.5\` vs \`spacexai/grok-4.5\`); this command takes the GATEWAY spelling.`,
    );
  }
  // Only a DECLARED `false` refuses. `undefined` means the catalogue does not
  // classify — two of the three do not — and rejecting the unclassified would
  // make most of the market unaddable by hand. An embedding model that slips
  // through is caught by the policy below: it advertises no `tools`.
  if (entry.isLanguageModel === false) {
    return fail(
      `"${modelId}" is not a language model in the gateway catalogue. Only language models route through the profile registry — embeddings and rerankers are env-selected single-purpose models with their own dimension rules.`,
    );
  }

  const profileKey = flags.get("key") ?? slugForModelId(entry.id);
  const existing = await readLiveStateRow(profileKey);
  if (existing !== undefined) {
    return fail(
      `A row already exists for key "${profileKey}" (${existing.status}, ids ${Object.values(existing.modelIds).join(", ")}). Inspect it with \`models:admin -- show ${profileKey}\`, or pass --key <otherKey> to add this model under a different key.`,
    );
  }

  const endpoints = await fetchGatewayEndpoints(entry.id);
  const pool = buildAllowedPool({
    poolWidened: false,
    quarantined: [],
    endpoints,
    requireTools: DEFAULT_CANDIDATE_POLICY.toolCallingRequired,
    requireZdr: DEFAULT_CANDIDATE_POLICY.zdrRequired,
    ...(DEFAULT_CANDIDATE_POLICY.quantizationFloor === undefined
      ? {}
      : { quantizationFloor: DEFAULT_CANDIDATE_POLICY.quantizationFloor }),
  });
  // Refusing here rather than inserting zeros: `effectiveContextLength` and
  // `pricing` are what compaction budgets against and what credits bill off, and
  // a row carrying 0 for either is worse than no row at all.
  if (pool.endpoints.length === 0) {
    return fail(
      `${entry.id} has ${endpoints.length.toString()} endpoint(s) but none survives the discovery policy, so there is nothing to derive an honest context or price from:\n${pool.excluded
        .map((excluded) => `  ${excluded.provider}: ${excluded.reason}`)
        .join("\n")}\nNothing was written.`,
    );
  }

  const context = computeEffectiveContext(pool.endpoints);
  const pricing = computePoolPricing(pool.endpoints);
  const dynamicProfile = deriveDynamicProfile(
    { ...entry, idsByTransport: { gateway: entry.id } },
    now,
  );

  await addCatalogueModel({
    profileKey,
    transport: "gateway",
    modelIds: { gateway: entry.id },
    dynamicProfile,
    effectiveContextLength: context.contextLength,
    ...(context.maxOutput === null
      ? {}
      : { effectiveMaxOutput: context.maxOutput }),
    pricing,
  });

  const state = await readLiveStateRow(profileKey);
  if (state === undefined) {
    return fail(
      `The insert for "${profileKey}" did not land — another process wrote the same key concurrently. Re-run \`models:admin -- show ${profileKey}\` to see what is there.`,
    );
  }

  console.log(
    `Added ${entry.id} as "${profileKey}" — status CANDIDATE, transport gateway, disabled.`,
  );
  console.log(
    "A candidate is invisible to teams. Nothing routes to it and no picker offers it until `models:admin -- promote` says so, which is the point: day-zero endpoints are measurably unstable and a catalogue entry says nothing about which host a call lands on.",
  );
  console.log(
    `Its profile is DERIVED from catalogue facts (tags, not names) — a hand-written TypeScript profile wins over it field by field if one is ever added under the same key.`,
  );

  const report = printScorecard({
    state,
    endpoints: pool.endpoints,
    endpointSource: "a live gateway fetch, just now",
    excluded: pool.excluded,
    benchRuns: [],
    incidents: [],
  });
  console.log(
    `\nNext: \`bun run models:bench -- --profile ${profileKey} --transport gateway --save\`, then \`models:admin -- promote ${profileKey}\`${report.passed ? "" : " once the hard failures above are understood"}.`,
  );
};

const runPromote = async (): Promise<void> => {
  const state = await mustRead(requiredKey());
  if (state.status === "published") {
    console.log(
      `${state.profileKey} is already published — nothing changed. It is ${state.enabled ? "enabled" : `disabled (${state.disabledReason ?? "no reason recorded"})`}; use \`enable\` for that.`,
    );
    return;
  }
  const verdict = await promoteCandidate(state.profileKey);
  console.log(
    `${state.profileKey}: ${state.status} -> published, ${verdict.enabled ? "enabled" : `DISABLED (${verdict.disabledReason ?? "unknown"})`}.`,
  );
  if (!verdict.enabled) {
    console.log(
      `Its pool costs ${money(state.pricing.inputPerMTok)} in / ${money(state.pricing.outputPerMTok)} out per MTok, past the ${money(PROMOTION_PRICE_CAPS.inputPerMTok)}/${money(PROMOTION_PRICE_CAPS.outputPerMTok)} budget. Discovery no longer filters on price — the model is published and visible, it is simply not being paid for. \`enable ${state.profileKey}\` overrides that deliberately; the nightly sync will re-disable it only if the price rises again, and re-enable it on its own if the price falls back under budget.`,
    );
  }
  console.log(
    "Teams can select it from the next model construction onward, fleet-wide, with no deploy. Curation still holds a veto: a profile marked `enabled: false` in TypeScript stays hidden whatever this row says.",
  );
  if (state.dynamicProfile !== null) {
    console.log(
      "It has NO hand-written TypeScript profile — it runs on catalogue-derived facts. That is supported, and it means nobody has recorded a reasoning envelope, a cache strategy or a native-input policy for it.",
    );
  }
};

const runRetire = async (): Promise<void> => {
  const state = await mustRead(requiredKey());
  if (state.boundRoles.length > 0) {
    return fail(
      `${state.profileKey} serves internal role(s): ${state.boundRoles.join(", ")}. Retiring it would take those roles down rather than degrade one team's choice — rebind them in ROLE_BINDINGS first (that is a reviewed pull request).`,
    );
  }
  await retireModel(state.profileKey);
  console.log(`${state.profileKey}: ${state.status} -> retired, disabled.`);
  console.log(
    "It leaves every picker on the next model construction. Nothing is deleted: incidents, alerts and bench runs keep pointing at this key, so its history stays readable.",
  );
};

const runEnable = async (): Promise<void> => {
  const state = await mustRead(requiredKey());
  await setEnabled(state.profileKey, true);
  console.log(
    `${state.profileKey}: enabled${state.enabled ? " (it already was)" : ""}, disabledReason cleared, policy-fail streak reset to 0.`,
  );
  console.log(
    "The streak reset matters: without it, yesterday's consecutive hard-policy failures would disable the model again on the next sync even though the underlying problem is fixed.",
  );
  if (state.status !== "published") {
    console.log(
      `Status is still ${state.status}, so teams still cannot select it. Run \`promote ${state.profileKey}\` for that.`,
    );
  }
};

const runDisable = async (): Promise<void> => {
  const state = await mustRead(requiredKey());
  const rawReason = flags.get("reason");
  const reason = DISABLED_REASONS.find((known) => known === rawReason);
  if (rawReason !== undefined && reason === undefined) {
    usageError(
      `--reason "${rawReason}" is not one of: ${DISABLED_REASONS.join(", ")}.`,
    );
  }
  await setEnabled(state.profileKey, false, reason);
  console.log(
    `${state.profileKey}: disabled, reason "${reason ?? "unavailable"}".`,
  );
  console.log(
    "No running turn breaks. A team whose stored selection just became unselectable degrades to the code default at resolution time — a path that already exists for unknown keys.",
  );
  if (state.boundRoles.length > 0) {
    console.log(
      `WARNING: ${state.profileKey} is bound to internal role(s) ${state.boundRoles.join(", ")}. \`enabled\` gates TEAM SELECTION only — ROLE_BINDINGS resolves profiles directly and bypasses it, so those roles keep running on this model.`,
    );
  }
};

const runSetTransport = async (): Promise<void> => {
  const profileKey = requiredKey();
  const rawTransport =
    positional[2] ??
    usageError("set-transport needs a transport: gateway or openrouter.");
  if (!isTransportId(rawTransport)) {
    usageError(
      `"${rawTransport}" is not a transport id. Implemented today: gateway, openrouter.`,
    );
    return;
  }
  const transport: TransportId = rawTransport;
  const state = await mustRead(profileKey);
  if (state.transport === transport) {
    console.log(`${profileKey} is already on ${transport} — nothing changed.`);
    return;
  }
  try {
    await setTransport(profileKey, transport);
  } catch (err: unknown) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  console.log(`${profileKey}: ${state.transport} -> ${transport}.`);
  console.log(
    "This takes effect on the NEXT MODEL CONSTRUCTION, fleet-wide, with no deploy and no restart: the write invalidates every replica's live-state snapshot over Redis and drops every memoized model instance built from the old one.",
  );
  console.log(
    "Routing starts from a clean slate — `poolWidened` and `lastResort` are cleared, because the previous transport's widening described a different set of hosts entirely. Quarantines are KEPT: they are recorded per transport.",
  );
  const wire = effectivePoolFor(
    { ...state, transport, poolWidened: false },
    transport,
    now,
  );
  console.log(
    `Pool on ${transport}: only=[${(wire.only ?? []).join(", ")}]${wire.only === undefined ? " (open routing)" : ""} ignore=[${(wire.ignore ?? []).join(", ")}]`,
  );
  console.log(
    `Verify cost and caching on the new transport, then roll back with: models:admin -- set-transport ${profileKey} ${state.transport}`,
  );
};

const runQuarantine = async (): Promise<void> => {
  const profileKey = requiredKey();
  const provider =
    positional[2] ?? usageError("quarantine needs a <provider> to remove.");
  const rawKind = flags.get("kind");
  const kind =
    rawKind === undefined
      ? DEFAULT_QUARANTINE_KIND
      : INCIDENT_KINDS.find((known) => known === rawKind);
  if (kind === undefined) {
    usageError(
      `--kind "${rawKind ?? ""}" is not one of: ${INCIDENT_KINDS.join(", ")}.`,
    );
    return;
  }
  const before = await mustRead(profileKey);
  const reason =
    flags.get("reason") ??
    `Quarantined by hand through model-admin on ${now.toISOString().slice(0, 10)}.`;

  const changed = await quarantineProvider({
    modelKey: profileKey,
    provider,
    transport: before.transport,
    kind,
    reason,
    now,
  });

  const after = await mustRead(profileKey);
  const quarantines = activeQuarantines(after, now);

  if (!changed) {
    const already = quarantines.find(
      (entry) =>
        entry.transport === before.transport &&
        entry.provider.includes(
          provider.toLowerCase().replace(/[^a-z0-9]/g, ""),
        ),
    );
    if (already !== undefined) {
      console.log(
        `${provider} is already quarantined on ${profileKey}/${before.transport} until ${already.releaseAt.slice(0, 10)} (${already.kind}) — nothing changed.`,
      );
      return;
    }
    console.log(
      `${profileKey} was NOT changed: ${provider} is the last usable upstream on every transport, so it stays in service (an empty pool is a hard outage) and the model was marked LAST RESORT instead.`,
    );
    console.log(
      "Roles bound to it now serve from their fallback MODEL and teams that selected it degrade to the default. Widen the pool, add a transport, or replace the model.",
    );
    return;
  }

  const threshold = BREAKER_THRESHOLDS[kind];
  console.log(
    `${provider} removed from ${profileKey} on ${after.transport} — kind "${kind}", release due ${quarantines.find((entry) => entry.provider.startsWith(provider.slice(0, 4).toLowerCase()))?.releaseAt.slice(0, 10) ?? `in ${BREAKER_QUARANTINE_DAYS.toString()} days`}.`,
  );
  console.log(
    `The breaker files this kind by itself after ${threshold.generations.toString()} distinct generations inside ${threshold.windowMinutes.toString()} min — one pathological answer can never trip it, and neither can this command be undone by one.`,
  );
  for (const line of routingLines(after)) console.log(line);
  if (after.transport !== before.transport) {
    console.log(
      `Nothing clean was left on ${before.transport}, so ${profileKey} was SWITCHED to ${after.transport}, which serves it from a different set of hosts. Verify cost and caching there.`,
    );
  }
  console.log(
    `The release date is a review trigger: the sync re-probes on it, releases the host only if the probe is clean, and extends the quarantine otherwise. Undo now with: models:admin -- release ${profileKey} ${provider}`,
  );
};

const runRelease = async (): Promise<void> => {
  const profileKey = requiredKey();
  const provider =
    positional[2] ?? usageError("release needs a <provider> to restore.");
  const before = await mustRead(profileKey);
  await releaseProvider({
    modelKey: profileKey,
    provider,
    transport: before.transport,
    reason: `Released by hand through model-admin on ${now.toISOString().slice(0, 10)}.`,
  });
  const after = await mustRead(profileKey);

  if (
    after.quarantinedProviders.length === before.quarantinedProviders.length
  ) {
    const elsewhere = before.quarantinedProviders.filter(
      (entry) => entry.transport !== before.transport,
    );
    return fail(
      `Nothing to release: ${provider} is not quarantined on ${profileKey}/${before.transport}.${
        elsewhere.length > 0
          ? `\nQuarantines DO exist on another transport: ${elsewhere.map((entry) => `${entry.provider} on ${entry.transport}`).join(", ")}. Quarantine is recorded per transport — move the model there first with \`set-transport\` if that is the one you meant.`
          : ""
      }`,
    );
  }

  console.log(`${provider} restored to ${profileKey} on ${before.transport}.`);
  console.log(
    "Routing re-narrows to the vetted pool and the last-resort flag is lifted, provided the vetted pool still has a member. Effective on the next model construction, fleet-wide.",
  );
  for (const line of routingLines(after)) console.log(line);
};

const runAlerts = async (): Promise<void> => {
  const ackId = flags.get("ack");
  if (ackId !== undefined) {
    let existing: ModelAlertRow | undefined;
    try {
      [existing] = await db
        .select()
        .from(modelAlerts)
        .where(eq(modelAlerts.id, ackId))
        .limit(1);
    } catch {
      return fail(
        `"${ackId}" is not a valid alert id. Ids are UUIDs — copy one from \`models:admin -- alerts\`.`,
      );
    }
    if (existing === undefined) {
      return fail(
        `No alert with id "${ackId}". List them with \`models:admin -- alerts\`.`,
      );
    }
    await acknowledgeAlert(ackId);
    console.log(
      `Acknowledged: ${existing.kind}${existing.modelKey === null ? "" : ` on ${existing.modelKey}`}.`,
    );
    console.log(
      "The digest sweep stops carrying it. Acknowledging changes nothing about the DECISION the alert reports — a quarantine stays in force until its re-probe releases it.",
    );
    return;
  }

  const rawLimit = flags.get("limit");
  const limit = rawLimit === undefined ? 30 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1) {
    usageError("--limit must be a positive integer.");
  }
  const alerts = await listRecentAlerts(limit);
  if (alerts.length === 0) {
    console.log("No alerts. The engine has taken no decision worth reporting.");
    return;
  }
  for (const alert of alerts) {
    console.log(
      `${stamp(alert.createdAt).padEnd(18)}${alert.severity.toUpperCase().padEnd(10)}${alert.kind.padEnd(22)}${[alert.modelKey, alert.provider].filter(Boolean).join("/")}${alert.acknowledgedAt === null ? "" : "   [acked]"}`,
    );
    console.log(`    ${alert.message}`);
    console.log(`    id ${alert.id}`);
  }
  const unacked = alerts.filter((alert) => alert.acknowledgedAt === null);
  console.log(
    `\n${alerts.length.toString()} alert(s), ${unacked.length.toString()} unacknowledged. Acknowledge one with: models:admin -- alerts --ack <id>`,
  );
};

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * `audit` — everything the engine can contradict itself about, checked without
 * touching the network or a model.
 *
 * It exists because every one of these had already happened once. A tier that
 * disagrees with the model's own measurements, a row naming a transport it has
 * no id for, a TypeScript profile saying `enabled` while the row says disabled,
 * a display name outliving the model it named: each was found by hand, months
 * apart, by someone who happened to look. Reading a database and a few
 * TypeScript tables is cheap enough to do on every deploy.
 *
 * Deliberately offline. An audit that needs a catalogue fetch is an audit that
 * gets skipped in CI and fails on a bad afternoon for the wrong reason.
 */
const runAudit = async (): Promise<void> => {
  const [
    { MODEL_PROFILES, ROLE_BINDINGS },
    { MODEL_DISPLAY_NAME },
    { ROLE_FALLBACK },
    gatewayIds,
    { getEffectiveProfile },
    { selectableForFunction },
    { teamAiSettings },
  ] = await Promise.all([
    import("../src/lib/model-registry/profiles"),
    import("../src/lib/model-registry/display"),
    import("../src/lib/model-registry/resolve"),
    import("../src/lib/model-registry/gateway-ids"),
    import("../src/lib/model-registry/effective"),
    import("../src/lib/model-registry/functions"),
    import("@fretik/shared/db/schema"),
  ]);
  const rows = await readAllLiveStateRows();
  const byKey = new Map(rows.map((row) => [row.profileKey, row]));

  const findings: { check: string; detail: string }[] = [];
  const note = (check: string, detail: string): void => {
    findings.push({ check, detail });
  };

  for (const row of rows) {
    if (row.modelIds[row.transport] === undefined) {
      note(
        "no id for its own transport",
        `${row.profileKey} routes through ${row.transport} and carries ids for ${Object.keys(row.modelIds).join(", ") || "nothing"}. Every call fails.`,
      );
    }

    if (row.aaSlug !== null && row.aaMetrics === null) {
      note(
        "aaSlug set but never matched",
        `${row.profileKey} pins Artificial Analysis slug "${row.aaSlug}" and carries no grades — the slug is wrong, or AA dropped the record.`,
      );
    }

    const declared = row.providerPool[row.transport]?.only ?? [];
    const answering = new Set(row.endpointStats.map((stat) => stat.provider));
    const absent = declared.filter((provider) => !answering.has(provider));
    if (absent.length > 0) {
      note(
        "pool names upstreams no endpoint answers to",
        `${row.profileKey} (${row.transport}) pins [${absent.join(", ")}]; routing still works, on a set nobody vetted.`,
      );
    }

    if (row.status === "published" && row.pricing.inputPerMTok > 0) {
      const budget = promotionEnablement(row.pricing);
      if (row.enabled && !budget.enabled && row.boundRoles.length === 0) {
        note(
          "enabled above the promotion caps",
          `${row.profileKey} costs $${row.pricing.inputPerMTok.toString()}/$${row.pricing.outputPerMTok.toString()} against caps $${PROMOTION_PRICE_CAPS.inputPerMTok.toString()}/$${PROMOTION_PRICE_CAPS.outputPerMTok.toString()} and no role needs it.`,
        );
      }
    }
  }

  // Curation and the row each hold a veto; they are allowed to differ, but a
  // difference nobody decided is how a model silently leaves the picker.
  for (const [key, profile] of Object.entries(MODEL_PROFILES)) {
    const row = byKey.get(key);
    if (row === undefined) {
      note(
        "curated profile with no live row",
        `${key} is in TypeScript and absent from model_live_state — it resolves on curated defaults only, with no pool, no quarantine and no price.`,
      );
      continue;
    }
    if (profile.assessment.enabled && !row.enabled && row.disabledReason) {
      note(
        "curation says enabled, the row disagrees",
        `${key}: TypeScript enables it, the engine disabled it (${row.disabledReason}). Expected after an automatic disable; unexplained otherwise.`,
      );
    }
  }

  const known = new Set([...Object.keys(MODEL_PROFILES), ...byKey.keys()]);
  for (const key of Object.keys(MODEL_DISPLAY_NAME)) {
    if (!known.has(key)) {
      note(
        "display name for a model that no longer exists",
        `MODEL_DISPLAY_NAME["${key}"] names nothing — the card would fall back to the key if the model came back under it.`,
      );
    }
  }
  // `GATEWAY_MODEL_IDS` only — `GATEWAY_AUX_MODEL_IDS` is keyed by OpenRouter id
  // and holds the embedding and rerank models, which have no profile BY DESIGN.
  for (const key of Object.keys(gatewayIds.GATEWAY_MODEL_IDS)) {
    if (!known.has(key)) {
      note("orphan gateway id", `GATEWAY_MODEL_IDS["${key}"] names nothing.`);
    }
  }
  for (const key of gatewayIds.PROFILES_WITHOUT_GATEWAY_ID) {
    if (!known.has(key)) {
      note(
        "orphan gateway exclusion",
        `PROFILES_WITHOUT_GATEWAY_ID lists "${key}", which names nothing.`,
      );
    }
  }

  // A fallback that resolves to its own primary is not redundancy, and it fails
  // exactly when redundancy was the point.
  for (const binding of Object.values(ROLE_BINDINGS)) {
    const fallback = ROLE_FALLBACK[binding.role];
    if (fallback === undefined) continue;
    const fallbackKey = ROLE_BINDINGS[fallback].profileKey;
    if (binding.profileKey === fallbackKey) {
      note(
        "a fallback pointing at its own primary",
        `${binding.role} falls back to ${fallback}, and both resolve to "${binding.profileKey}".`,
      );
    }
  }

  // What teams actually stored. The one check that reads a row a PERSON wrote
  // rather than one the engine did: a model can be retired, cost-disabled or
  // driven to last-resort long after a team picked it, and the resolver
  // degrades in silence — correctly, since a turn must not fail — which is
  // exactly why nothing else would ever surface it.
  const teamRows = await db
    .select({
      teamId: teamAiSettings.teamId,
      keys: teamAiSettings.functionProfileKeys,
    })
    .from(teamAiSettings);
  for (const team of teamRows) {
    for (const [fn, key] of Object.entries(team.keys)) {
      if (!isModelFunctionKey(fn)) {
        note(
          "a stored key under an unknown function",
          `team ${team.teamId} stores "${key}" under "${fn}", which is not a model function — it can never be read.`,
        );
        continue;
      }
      const profile = getEffectiveProfile(key);
      if (!profile) {
        note(
          "a team points a function at a model that no longer exists",
          `team ${team.teamId}: ${fn} → "${key}". Every turn silently serves the default instead.`,
        );
      } else if (!selectableForFunction(profile, fn)) {
        note(
          "a team points a function at a model it can no longer use",
          `team ${team.teamId}: ${fn} → "${key}". Still stored, never served.`,
        );
      }
    }
  }

  section(
    `audit — ${rows.length.toString()} live rows, ${Object.keys(MODEL_PROFILES).length.toString()} curated profiles, ${teamRows.length.toString()} team settings rows`,
  );
  if (findings.length === 0) {
    console.log("Nothing to report.");
    return;
  }
  const grouped = new Map<string, string[]>();
  for (const finding of findings) {
    grouped.set(finding.check, [
      ...(grouped.get(finding.check) ?? []),
      finding.detail,
    ]);
  }
  for (const [check, details] of grouped) {
    console.log(`\n${check} (${details.length.toString()})`);
    for (const detail of details) console.log(`  ${detail}`);
  }
  console.log(
    `\n${findings.length.toString()} finding(s). Nothing was changed — this command only reads.`,
  );
  process.exit(1);
};

const RUNNERS: Record<(typeof COMMANDS)[number], () => Promise<void>> = {
  list: runList,
  show: runShow,
  scorecard: runScorecard,
  add: runAdd,
  promote: runPromote,
  retire: runRetire,
  enable: runEnable,
  disable: runDisable,
  "set-transport": runSetTransport,
  quarantine: runQuarantine,
  release: runRelease,
  alerts: runAlerts,
  audit: runAudit,
};

const runner = COMMANDS.find((known) => known === command);
if (runner === undefined) usageError(`Unknown command "${command}".`);
else {
  try {
    await RUNNERS[runner]();
  } catch (err: unknown) {
    fail(
      `${command} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// The pg client and the Redis subscriber both keep the event loop alive, so a
// short-lived CLI has to say when it is done.
process.exit(0);
