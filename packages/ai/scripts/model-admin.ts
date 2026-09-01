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
 * # One layer, and every subcommand writes it
 *
 * `model_live_state` is the registry. What a model IS comes from the
 * catalogues, what it COSTS from its endpoints' prices, and what we have
 * measured about it — a quarantine, a vetted pool, a transport — is written
 * here by whatever measured it. There is no TypeScript half any more: 22
 * hand-written profiles were deleted on 2026-08-30 after measurement showed
 * them staler than the rows they overrode.
 *
 * That is what makes these commands instant and survivable: `set-transport`,
 * `enable`, `disable`, `promote`, `retire`, `quarantine` and `release` are all
 * one write, and a bad call is undone by the opposite call rather than by a
 * revert and a deploy.
 *
 * The one thing still decided in code is which model serves which internal ROLE
 * (`src/lib/model-registry/role-bindings.ts`), because no API publishes that.
 * `enable`/`disable` gate TEAM SELECTION only — a role resolves its model
 * directly and bypasses the check.
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
import type { ModelBenchRunRow } from "@fretik/shared/db/schema";
import { describeConsequence } from "@fretik/shared/model-registry/consequence-text";
import {
  DEFAULT_QUARANTINE_KIND,
  DISABLED_REASONS,
  INCIDENT_KINDS,
  isTransportId,
  type Consequence,
  type EndpointStat,
  type IncidentKind,
  type LiveModelState,
  type PolicyReport,
  type TransportId,
} from "@fretik/shared/model-registry/types";
import type { EndpointSource } from "@fretik/shared/services/model-registry/scorecard";
import { desc, eq } from "drizzle-orm";

/** How much incident history a promotion decision looks at, versus `show`. */
const SHOW_INCIDENT_WINDOW_HOURS = 24;
const SCORECARD_INCIDENT_WINDOW_HOURS = 24 * 7;

/** Recent bench rows shown on a scorecard. Enough to see a trend, not a log. */
const BENCH_RUN_LIMIT = 12;

/** Alert ids are `uuid_generate_v7()` values; anything else is a typo. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
 * failures inform health and never disable anything on their own.
 *
 * A rule the policy SETS is never absent: it reads `pass`, `FAIL`, or one of
 * the two skip verdicts. `no-data` is a rule whose figures should have arrived
 * and did not — a missing credential, a host gone quiet — and it is somebody's
 * problem tonight. `n/a` is a rule no consulted catalogue can ever answer. The
 * distinction is the point: these rules used to vanish from the report
 * entirely, so "we did not check" printed exactly like "everything passed",
 * and the throughput floor went months without evaluating once.
 */
const policyTable = (report: PolicyReport | null): void => {
  if (report === null) {
    console.log("  (never evaluated — no sync has graded this model yet)");
    return;
  }
  const skipped = report.rules.filter((rule) => rule.skipped !== undefined);
  console.log(
    `  evaluated ${isoStamp(report.evaluatedAt)} — ${report.passed ? "PASSED" : "FAILED"} (${report.hardFailures.toString()} hard, ${report.softFailures.toString()} soft${skipped.length > 0 ? `, ${skipped.length.toString()} not evaluated` : ""})`,
  );
  console.log(
    `  ${"rule".padEnd(24)}${"sev".padEnd(6)}${"verdict".padEnd(9)}detail`,
  );
  for (const rule of report.rules) {
    const verdict =
      rule.skipped === "not-measured"
        ? "no-data"
        : rule.skipped === "not-published-by-source"
          ? "n/a"
          : rule.passed
            ? "pass"
            : "FAIL";
    console.log(
      `  ${rule.rule.padEnd(24)}${rule.severity.padEnd(6)}${verdict.padEnd(9)}${rule.detail}`,
    );
  }
  const unmeasured = skipped.filter(
    (rule) => rule.skipped === "not-measured",
  ).length;
  if (unmeasured > 0) {
    console.log(
      `  ${unmeasured.toString()} rule(s) had no data to grade — check the sync's last status for a missing credential.`,
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
const { modelBenchRuns } = await import("@fretik/shared/db/schema");
// Every WRITE goes through `operations`, not through the services directly:
// that is what keeps this terminal and the web surface agreeing on what a
// change means, and what puts a line in the action log for each one.
const {
  acknowledgeModelAlert,
  addModelFromCatalogue,
  promoteModel,
  quarantineUpstream,
  releaseUpstream,
  retireModelOperation,
  setModelEnabled,
  switchModelTransport,
} = await import("@fretik/shared/services/model-registry/operations");
const { BREAKER_QUARANTINE_DAYS, activeQuarantines, effectivePoolFor } =
  await import("@fretik/shared/services/model-registry/breaker");
// The scorecard's two decisions — which policy grades it, and what to do when
// the sync has never measured the row — are shared with the web surface rather
// than restated here.
const { evaluateScorecardPolicy, scorecardEndpoints, scorecardPool } =
  await import("@fretik/shared/services/model-registry/scorecard");
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

  const report = evaluateScorecardPolicy({ endpoints, excluded, aa, now });
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

/** The discriminant `scorecardEndpoints` returns, spelled out for a reader. */
const endpointSourceLine = (
  state: LiveModelState,
  source: EndpointSource,
): string => {
  if (source === "stored") return `the last sync, ${stamp(state.syncedAt)}`;
  if (source === "live")
    return "a live gateway fetch (the sync has not measured this row yet)";
  if (source === "no-gateway-id")
    return "nothing — no stored stats, no gateway id";
  return "nothing — the live fetch failed";
};

const runScorecard = async (): Promise<void> => {
  const state = await mustRead(requiredKey());
  const { endpoints, source, error } = await scorecardEndpoints(state);
  if (error !== undefined) {
    console.warn(`  (live endpoint fetch failed: ${error})`);
  }
  const pool = scorecardPool(state, endpoints, now);
  printScorecard({
    state,
    endpoints: pool.endpoints,
    endpointSource: endpointSourceLine(state, source),
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
  const key = flags.get("key");

  // The catalogue lookup, the language-model check, the key collision and the
  // empty-pool refusal all live in the service now. They were catalogue LOGIC
  // sitting in a terminal script, so a second surface would have had to
  // reimplement four refusals — or ship without them.
  const outcome = await addModelFromCatalogue({
    modelId,
    ...(key === undefined ? {} : { profileKey: key }),
    actor: { kind: "cli" },
    now,
  });

  if (outcome.kind === "not-in-catalogue") {
    return fail(
      `"${modelId}" is not in the Vercel AI Gateway catalogue (${outcome.catalogueSize.toString()} entries read from /v1/models).${
        outcome.near.length > 0
          ? `\nDid you mean:\n  ${outcome.near.join("\n  ")}`
          : ""
      }\nThe catalogue is public — check the exact id at https://ai-gateway.vercel.sh/v1/models. Model ids differ between transports (\`x-ai/grok-4.5\` vs \`spacexai/grok-4.5\`); this command takes the GATEWAY spelling.`,
    );
  }
  if (outcome.kind === "not-a-language-model") {
    return fail(
      `"${modelId}" is not a language model in the gateway catalogue. Only language models route through the profile registry — embeddings and rerankers are env-selected single-purpose models with their own dimension rules.`,
    );
  }
  if (outcome.kind === "key-exists") {
    return fail(
      `A row already exists for key "${outcome.profileKey}" (${outcome.status}, ids ${outcome.modelIds.join(", ")}). Inspect it with \`models:admin -- show ${outcome.profileKey}\`, or pass --key <otherKey> to add this model under a different key.`,
    );
  }
  if (outcome.kind === "no-eligible-endpoint") {
    return fail(
      `${modelId} has ${outcome.endpointCount.toString()} endpoint(s) but none survives the discovery policy, so there is nothing to derive an honest context or price from:\n${outcome.excluded
        .map((excluded) => `  ${excluded.provider}: ${excluded.reason}`)
        .join("\n")}\nNothing was written.`,
    );
  }
  if (outcome.kind === "insert-lost-race") {
    return fail(
      `Another process added "${outcome.profileKey}" at the same moment, so this call wrote nothing. Run \`models:admin -- show ${outcome.profileKey}\` to see what is there.`,
    );
  }

  console.log(
    `Added ${modelId} as "${outcome.profileKey}" — status CANDIDATE, transport gateway, disabled.`,
  );
  console.log(
    "A candidate is invisible to teams. Nothing routes to it and no picker offers it until `models:admin -- promote` says so, which is the point: day-zero endpoints are measurably unstable and a catalogue entry says nothing about which host a call lands on.",
  );
  console.log(
    `Its profile is DERIVED from catalogue facts (tags, not names) — a hand-written TypeScript profile wins over it field by field if one is ever added under the same key.`,
  );

  const report = printScorecard({
    state: outcome.state,
    endpoints: outcome.endpoints,
    endpointSource: "a live gateway fetch, just now",
    excluded: outcome.excluded,
    benchRuns: [],
    incidents: [],
  });
  console.log(
    `\nNext: \`bun run models:bench -- --profile ${outcome.profileKey} --transport gateway --save\`, then \`models:admin -- promote ${outcome.profileKey}\`${report.passed ? "" : " once the hard failures above are understood"}.`,
  );
};

/**
 * Print what a write MEANT, from the codes the operation reported.
 *
 * The conditional paragraphs this replaces used to be re-derived here from the
 * row: whether the price was over budget, whether a profile was
 * catalogue-derived, which roles a model is bound to. Deciding that twice is
 * how two surfaces come to disagree about the same write.
 */
const printConsequences = (consequences: readonly Consequence[]): void => {
  for (const consequence of consequences) {
    console.log(describeConsequence(consequence));
  }
};

const runPromote = async (): Promise<void> => {
  const state = await mustRead(requiredKey());
  const { outcome, consequences } = await promoteModel({
    profileKey: state.profileKey,
    actor: { kind: "cli" },
    now,
  });
  if (outcome.kind === "unknown-model") {
    return fail(`Unknown model "${state.profileKey}".`);
  }
  if (outcome.kind === "already-published") {
    console.log(
      `${state.profileKey} is already published — nothing changed. It is ${state.enabled ? "enabled" : `disabled (${state.disabledReason ?? "no reason recorded"})`}; use \`enable\` for that.`,
    );
    return;
  }
  console.log(
    `${state.profileKey}: ${state.status} -> published, ${outcome.enabled ? "enabled" : `DISABLED (${outcome.disabledReason ?? "unknown"})`}.`,
  );
  printConsequences(consequences);
  console.log(
    "Teams can select it from the next model construction onward, fleet-wide, with no deploy. Curation still holds a veto: a profile marked `enabled: false` in TypeScript stays hidden whatever this row says.",
  );
};

const runRetire = async (): Promise<void> => {
  const state = await mustRead(requiredKey());
  const { outcome } = await retireModelOperation({
    profileKey: state.profileKey,
    actor: { kind: "cli" },
    now,
  });
  if (outcome.kind === "unknown-model") {
    return fail(`Unknown model "${state.profileKey}".`);
  }
  // The refusal now comes from the service, so it protects every caller rather
  // than only this one.
  if (outcome.kind === "refused-bound-roles") {
    return fail(
      `${state.profileKey} serves internal role(s): ${outcome.roles.join(", ")}. Retiring it would take those roles down rather than degrade one team's choice — rebind them in ROLE_BINDINGS first (that is a reviewed pull request).`,
    );
  }
  console.log(
    `${state.profileKey}: ${outcome.previousStatus} -> retired, disabled.`,
  );
  console.log(
    "It leaves every picker on the next model construction. Nothing is deleted: incidents, alerts and bench runs keep pointing at this key, so its history stays readable.",
  );
};

const runEnable = async (): Promise<void> => {
  const state = await mustRead(requiredKey());
  const { outcome, consequences } = await setModelEnabled({
    profileKey: state.profileKey,
    enabled: true,
    actor: { kind: "cli" },
    now,
  });
  if (outcome.kind === "unknown-model") {
    return fail(`Unknown model "${state.profileKey}".`);
  }
  console.log(
    `${state.profileKey}: enabled, disabledReason cleared, policy-fail streak reset to 0.`,
  );
  printConsequences(consequences);
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
  const { outcome, consequences } = await setModelEnabled({
    profileKey: state.profileKey,
    enabled: false,
    ...(reason === undefined ? {} : { reason }),
    actor: { kind: "cli" },
    now,
  });
  if (outcome.kind === "unknown-model") {
    return fail(`Unknown model "${state.profileKey}".`);
  }
  console.log(
    `${state.profileKey}: disabled, reason "${outcome.disabledReason ?? "unavailable"}".`,
  );
  console.log(
    "No running turn breaks. A team whose stored selection just became unselectable degrades to the code default at resolution time — a path that already exists for unknown keys.",
  );
  printConsequences(consequences);
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
  const { outcome, consequences } = await switchModelTransport({
    profileKey,
    transport,
    actor: { kind: "cli" },
    now,
  });
  if (outcome.kind === "unknown-model") {
    return fail(`Unknown model "${profileKey}".`);
  }
  if (outcome.kind === "no-model-id") {
    return fail(
      `"${profileKey}" has no model id for transport "${transport}" — it is known as ${outcome.available.join(", ")}. Model ids differ between transports; add one to its row first.`,
    );
  }
  if (outcome.kind === "already-on-transport") {
    console.log(`${profileKey} is already on ${transport} — nothing changed.`);
    return;
  }
  console.log(`${profileKey}: ${outcome.from} -> ${outcome.to}.`);
  console.log(
    "This takes effect on the NEXT MODEL CONSTRUCTION, fleet-wide, with no deploy and no restart: the write invalidates every replica's live-state snapshot over Redis and drops every memoized model instance built from the old one.",
  );
  console.log(
    "Routing starts from a clean slate — `poolWidened` and `lastResort` are cleared, because the previous transport's widening described a different set of hosts entirely.",
  );
  printConsequences(consequences);
  const wire = effectivePoolFor(
    { ...state, transport, poolWidened: false },
    transport,
    now,
  );
  console.log(
    `Pool on ${transport}: only=[${(wire.only ?? []).join(", ")}]${wire.only === undefined ? " (open routing)" : ""} ignore=[${(wire.ignore ?? []).join(", ")}]`,
  );
  console.log(
    `Verify cost and caching on the new transport, then roll back with: models:admin -- set-transport ${profileKey} ${outcome.from}`,
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

  const { outcome, consequences } = await quarantineUpstream({
    profileKey,
    provider,
    transport: before.transport,
    kind,
    reason,
    actor: { kind: "cli" },
    now,
  });

  // The rung comes back named, so none of what follows has to be inferred from
  // a re-read. This used to search the after-state for a provider whose name
  // merely CONTAINED the argument, and read the release date off one whose
  // first four characters matched — two guesses that could answer for the
  // wrong host.
  if (outcome.kind === "already-quarantined") {
    console.log(
      `${provider} is already quarantined on ${profileKey}/${before.transport} until ${outcome.entry.releaseAt.slice(0, 10)} (${outcome.entry.kind}) — nothing changed.`,
    );
    return;
  }
  if (outcome.kind === "no-live-row") {
    return fail(
      `${profileKey} has no live-state row, so there is no pool to edit. The finding was recorded as an alert.`,
    );
  }
  if (outcome.kind === "last-resort") {
    console.log(
      `${profileKey}'s pool was NOT changed: ${provider} is the last usable upstream on every transport.`,
    );
    printConsequences(consequences);
    return;
  }

  const after = await mustRead(profileKey);
  console.log(
    `${provider} removed from ${profileKey} on ${after.transport} — kind "${kind}", release due ${outcome.entry.releaseAt.slice(0, 10)} (${BREAKER_QUARANTINE_DAYS.toString()} days).`,
  );
  for (const line of routingLines(after)) console.log(line);
  printConsequences(consequences);
  console.log(
    `Undo now with: models:admin -- release ${profileKey} ${provider}`,
  );
};

const runRelease = async (): Promise<void> => {
  const profileKey = requiredKey();
  const provider =
    positional[2] ?? usageError("release needs a <provider> to restore.");
  const before = await mustRead(profileKey);
  const { outcome, consequences } = await releaseUpstream({
    profileKey,
    provider,
    transport: before.transport,
    reason: `Released by hand through model-admin on ${now.toISOString().slice(0, 10)}.`,
    actor: { kind: "cli" },
    now,
  });

  if (outcome.kind === "no-live-row") {
    return fail(`${profileKey} has no live-state row — nothing to release.`);
  }
  // `elsewhere` arrives with the outcome. It used to be reconstructed here by
  // comparing `quarantinedProviders.length` across a re-read, which also read
  // an expired entry as a successful release.
  if (outcome.kind === "not-quarantined") {
    return fail(
      `Nothing to release: ${provider} is not quarantined on ${profileKey}/${before.transport}.${
        outcome.elsewhere.length > 0
          ? `\nQuarantines DO exist on another transport: ${outcome.elsewhere.map((entry) => `${entry.provider} on ${entry.transport}`).join(", ")}. Quarantine is recorded per transport — move the model there first with \`set-transport\` if that is the one you meant.`
          : ""
      }`,
    );
  }

  const after = await mustRead(profileKey);
  console.log(
    `${provider} restored to ${profileKey} on ${before.transport}. Effective on the next model construction, fleet-wide.`,
  );
  printConsequences(consequences);
  for (const line of routingLines(after)) console.log(line);
};

const runAlerts = async (): Promise<void> => {
  const ackId = flags.get("ack");
  if (ackId !== undefined) {
    // The uuid shape is checked here rather than by letting Postgres reject
    // the cast: the service reads the row, and a malformed id would surface
    // as a driver error instead of "that is not an id".
    if (!UUID_PATTERN.test(ackId)) {
      return fail(
        `"${ackId}" is not a valid alert id. Ids are UUIDs — copy one from \`models:admin -- alerts\`.`,
      );
    }
    const { outcome } = await acknowledgeModelAlert({
      alertId: ackId,
      actor: { kind: "cli" },
      now,
    });
    if (outcome.kind === "unknown-alert") {
      return fail(
        `No alert with id "${ackId}". List them with \`models:admin -- alerts\`.`,
      );
    }
    console.log(
      `Acknowledged: ${outcome.alertKind}${outcome.modelKey === null ? "" : ` on ${outcome.modelKey}`}.`,
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
 * The checks themselves live in `src/services/model-audit/run.ts`, because the
 * web surface asks the same question and two implementations of "is the engine
 * consistent" would disagree on the afternoon it mattered. Each finding carries
 * its parameters AND the English sentence printed below, so this output is
 * unchanged while a screen can translate the code.
 *
 * The exit code stays HERE: `runModelAudit` never calls `process.exit`, since
 * an audit that finds problems is a successful audit everywhere except in CI.
 */
const runAudit = async (): Promise<void> => {
  const { AUDIT_CHECK_LABELS, runModelAudit } =
    await import("../src/services/model-audit/run");
  const { findings, counts } = await runModelAudit();

  section(
    `audit — ${counts.liveRows.toString()} live rows (${counts.published.toString()} published), ${counts.roleBindings.toString()} role bindings, ${counts.teamSettingsRows.toString()} team settings rows`,
  );
  if (findings.length === 0) {
    console.log("Nothing to report.");
    return;
  }
  const grouped = new Map<string, string[]>();
  for (const finding of findings) {
    const check = AUDIT_CHECK_LABELS[finding.code];
    grouped.set(check, [...(grouped.get(check) ?? []), finding.detail]);
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
