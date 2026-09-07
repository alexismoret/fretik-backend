/**
 * What a host must be able to DO to serve a model — derived from the jobs the
 * model is bound to, not typed in per model.
 *
 * The registry already knew how to exclude a host for what it IS (quarantined,
 * unpriced, no tools, no ZDR, badly quantized). It had no way to exclude one
 * for what it CANNOT DO, and the gap was measurable on the live registry: on
 * 2026-09-07 a single host capped at 32 768 output tokens sat in
 * `deepseek-v4-flash`'s pool of seventeen, where every sibling advertised at
 * least 384 000. One host of seventeen decided what the whole model reported
 * itself capable of, because `computeEffectiveContext` reads the MINIMUM.
 *
 * Taking the minimum is the right reading GIVEN the pool — routing can land on
 * any member, so the pool can only promise what its weakest member delivers.
 * The defect was never the minimum. It was that nothing kept a host out of the
 * pool for being unable to do the work, so the only remedy was a hand-written
 * quarantine, repeated for every host a catalogue adds.
 *
 * ## Why the requirement belongs to the ROLE
 *
 * A ceiling on price is a business decision about one model. A floor on
 * capability is not: it is a property of the WORK. The same model serving the
 * chat loop needs room for a long answer under `max` reasoning, and serving a
 * memory write needs twelve thousand tokens and nothing more. Asking an
 * operator to restate that model by model asks them to re-derive, by hand,
 * something the code already knows — `role-bindings.ts` has declared it per
 * role since the registry existed, in `wrapCache`.
 *
 * So the requirement is READ from `boundRoles`, and the per-model columns are
 * OVERRIDES for the exception rather than the place the answer normally lives.
 *
 * ## Why the output floors are the numbers they are
 *
 * Each floor is the largest single response its role can legitimately produce:
 * the output budget the code actually asks for, plus the top reasoning rung,
 * because **reasoning tokens are charged against the output cap**. That is not
 * a precaution — it is the failure this file exists to prevent, recorded in
 * `role-bindings.ts` when it was last hit: "an 8K/32K cap was consumed by
 * mandatory thinking -> `length` cutoff -> 'No output generated.'" It was fixed
 * then by moving the binding to another model, which cures the symptom on one
 * role and leaves the low-capped host in the pool for every other.
 *
 * The budgets are read from the callers, never invented:
 * `structured-extract.ts` 60_000, `prose-transform.ts` / workflow step /
 * `page-review` 16_000, the memory services 12_000, `recall` 10_000,
 * `vision.ts` 8_000, `pre-extract` 4_000, titles 256. The reasoning ladder is
 * `MAX_TOKENS_BUDGET_BY_LEVEL`, whose top rung is 32_000.
 *
 * ## What is deliberately NOT here
 *
 * **No role context floor.** The same sweep found two models whose declared
 * context is halved by their pool — `inkling` and `minimax-m3`, 1 048 576 down
 * to 524 288 — and in BOTH cases half the pool genuinely sits at 524 288. A
 * floor would not be removing an outlier, it would be removing half the hosts
 * to buy a window we rarely fill. The existing relative rule
 * (`POOL_CONTEXT_SPREAD_RATIO`) already drops the true outliers, and an
 * under-declared context is SAFE in a way an under-declared output cap is not:
 * `compact.ts` reads `effectiveContextLength` and compacts earlier, while
 * nothing reads `effectiveMaxOutput` at request time at all — callers send
 * their own constants. Under-declaring context costs fidelity; under-declaring
 * output silently truncates. Only the second one earns an automatic filter.
 * `minContextLength` therefore exists as a per-model override, and the admin
 * table names the host that caps the window, so the choice is visible rather
 * than automatic.
 */

/** What a host must offer to be allowed to serve a model. */
export interface PoolRequirements {
  /** Smallest output cap a host must advertise, in tokens. */
  minMaxOutput?: number;
  /** Smallest context window a host must advertise, in tokens. */
  minContextLength?: number;
  /** Exclude hosts PROVEN not to cache. `unknown` never excludes. */
  requireCache?: boolean;
}

/** The per-model overrides an operator may store on the row. */
export interface RequirementOverrides {
  minMaxOutput?: number | null;
  minContextLength?: number | null;
  /** `null` means "inherit from the bound roles". */
  requireCache?: boolean | null;
}

/**
 * The top rung of `MAX_TOKENS_BUDGET_BY_LEVEL` (`ai/lib/model-registry/
 * resolve.ts`), duplicated as a number rather than imported: the sync runs in
 * `shared` and `jobs`, and reaching into the AI package for it would drag the
 * whole profile layer into the nightly pass. A unit test in `ai` asserts the
 * two agree, which is the cheap half of an import.
 */
const MAX_REASONING_BUDGET = 32_000;

/**
 * Every model a team can reach, whatever it is bound to.
 *
 * A team may point any enabled model at any function through
 * `functionProfileKeys`, so a floor that only applied to role-bound rows would
 * miss exactly the models a team chose for itself. 16 000 is the output budget
 * the most demanding team-reachable path asks for (a workflow step, a prose
 * transform, a page review) with no reasoning allowance added: the baseline is
 * meant to catch a host that cannot hold ONE ordinary answer, not to encode any
 * particular job. Roles raise it; nothing lowers it.
 *
 * Checked against the live registry before being set: the lowest in-pool cap on
 * any published model is 16 384 (`deepinfra` on `gpt-oss-120b` and on
 * `deepseek-v4-pro`), so this baseline costs zero hosts today and takes effect
 * the day a lower one appears — `meta-llama-llama-3-3-70b-instruct` already
 * carries a 2 048 host in the candidate set.
 */
export const FLEET_REQUIREMENTS: PoolRequirements = {
  minMaxOutput: 16_000,
};

/**
 * Per-role requirements, keyed by the role names written into `bound_roles`.
 *
 * Keyed by plain string because `bound_roles` is a text array and `ModelRole`
 * lives in the AI package; a test there asserts every member of that union
 * appears here, so a new role cannot be added without deciding what it needs.
 *
 * A role absent from this table contributes nothing and falls back to the fleet
 * baseline. That is the honest entry for `cheap-tasks` and `tool-repair`, whose
 * largest ask is a 256-token title.
 *
 * `requireCache` mirrors `wrapCache` in `role-bindings.ts`, and for the same
 * reason: these are the loops that resend a long stable prefix turn after turn,
 * where a host that does not cache is not merely dearer but changes the shape
 * of what the turn costs.
 */
export const ROLE_REQUIREMENTS: Record<string, PoolRequirements> = {
  // The agent loops. No caller sets `maxOutputTokens` on the chat path, so the
  // cap in play is the model's own, and a step may spend the top reasoning rung
  // before emitting a token: 16 000 of answer behind 32 000 of thinking.
  chat: { minMaxOutput: 16_000 + MAX_REASONING_BUDGET, requireCache: true },
  "chat-fallback": {
    minMaxOutput: 16_000 + MAX_REASONING_BUDGET,
    requireCache: true,
  },
  // `WORKFLOW_STEP_MAX_OUTPUT_TOKENS`, default 16 000, env-capped at 64 000.
  workflow: { minMaxOutput: 16_000 + MAX_REASONING_BUDGET, requireCache: true },
  "dispatch-cheap": {
    minMaxOutput: 16_000 + MAX_REASONING_BUDGET,
    requireCache: true,
  },
  // Writes a page's source files across many steps under an 8 000-token
  // thinking allowance (`PAGE_BUILD_REASONING_MAX_TOKENS`). Held to the same
  // floor as the other loops: a build that stops mid-file wastes the whole run.
  "page-build": {
    minMaxOutput: 16_000 + MAX_REASONING_BUDGET,
    requireCache: true,
  },
  // The structured-extraction engine asks for 60 000 output tokens
  // (`EXTRACT_MAX_OUTPUT_TOKENS`) under `{effort:"minimal"}` reasoning. This is
  // the largest single ask in the product.
  vision: { minMaxOutput: 64_000 },
  "vision-fallback": { minMaxOutput: 64_000 },
  // `TRANSFORM_MAX_OUTPUT_TOKENS`, no reasoning allowance of its own.
  transform: { minMaxOutput: 16_000 },
  "transform-fallback": { minMaxOutput: 16_000 },
  // `page-review` MAX_OUTPUT_TOKENS.
  "page-review": { minMaxOutput: 16_000 },
  // The memory services all ask 12 000 behind a 256-token thinking budget
  // (`MEMORY_REASONING_MAX_TOKENS`).
  "active-memory": { minMaxOutput: 12_256 },
  "memory-extract": { minMaxOutput: 12_256 },
  "memory-distill": { minMaxOutput: 12_256 },
  "memory-consolidate": { minMaxOutput: 12_256 },
  "memory-promote": { minMaxOutput: 12_256 },
  "compaction-summarizer": { minMaxOutput: 12_256 },
  // `PREEXTRACT_MAX_OUTPUT_TOKENS` is 4 000; the floor is rounded up to leave
  // room for the minimal reasoning these profiles carry.
  "pre-extract": { minMaxOutput: 8_000, requireCache: true },
  "pre-extract-fallback": { minMaxOutput: 8_000, requireCache: true },
  // `cheap-tasks` and `tool-repair` are deliberately absent: a 256-token title
  // needs nothing the fleet baseline does not already guarantee.
};

const higher = (a: number | undefined, b: number | undefined) =>
  a === undefined ? b : b === undefined ? a : Math.max(a, b);

/**
 * What the hosts of this model must be able to do.
 *
 * Roles combine by taking the STRICTEST of each floor, because one pool serves
 * every role bound to the row: a model that both chats and writes memory must
 * satisfy the chat floor, or the chat turns are the ones that break. Where that
 * costs a host the memory role would have accepted, the cost is a few hosts on
 * a model that has many — and the alternative, a pool per role, would multiply
 * every row in the registry to spare them.
 *
 * An override REPLACES the derived value rather than tightening it, in both
 * directions. An operator who types a lower floor than the roles imply means
 * it — usually because a pool has thinned and they would rather run on a
 * weaker host than not at all — and a rule that silently ignored them would be
 * worse than no override at all.
 */
export const requirementsFor = (
  boundRoles: readonly string[],
  overrides?: RequirementOverrides,
): PoolRequirements => {
  let minMaxOutput = FLEET_REQUIREMENTS.minMaxOutput;
  let minContextLength = FLEET_REQUIREMENTS.minContextLength;
  let requireCache = FLEET_REQUIREMENTS.requireCache === true;

  for (const role of boundRoles) {
    const required = ROLE_REQUIREMENTS[role];
    if (required === undefined) continue;
    minMaxOutput = higher(minMaxOutput, required.minMaxOutput);
    minContextLength = higher(minContextLength, required.minContextLength);
    if (required.requireCache === true) requireCache = true;
  }

  // `null` is the CLEARED state and means "inherit"; a number or a boolean is a
  // decision. `undefined` never reaches here from a row — the column is either
  // set or null — but the field is optional so callers can forecast a change
  // without restating what they are not touching.
  if (overrides?.minMaxOutput !== undefined && overrides.minMaxOutput !== null)
    minMaxOutput = overrides.minMaxOutput;
  if (
    overrides?.minContextLength !== undefined &&
    overrides.minContextLength !== null
  )
    minContextLength = overrides.minContextLength;
  if (overrides?.requireCache !== undefined && overrides.requireCache !== null)
    requireCache = overrides.requireCache;

  return {
    ...(minMaxOutput === undefined ? {} : { minMaxOutput }),
    ...(minContextLength === undefined ? {} : { minContextLength }),
    ...(requireCache ? { requireCache: true } : {}),
  };
};

/**
 * Which roles put each floor where it is — what the admin page shows next to an
 * inherited value, so a reader can see WHY a host was dropped without opening
 * this file.
 */
export const requirementSources = (
  boundRoles: readonly string[],
): { role: string; requirements: PoolRequirements }[] => {
  const sources: { role: string; requirements: PoolRequirements }[] = [];
  for (const role of boundRoles) {
    const requirements = ROLE_REQUIREMENTS[role];
    if (requirements === undefined) continue;
    sources.push({ role, requirements });
  }
  return sources;
};
