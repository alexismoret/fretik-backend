import { reasoningLevelSchema } from "@fretik/shared/schemas/reasoning";
import { beforeAll, describe, expect, test } from "bun:test";
import { normalizeFamily } from "../../../src/lib/model-registry/display";
import {
  MODEL_FUNCTION_KEYS,
  selectableForFunction,
} from "../../../src/lib/model-registry/functions";
import {
  clearResolvedModelCache,
  createOrphanThinkStreamStripper,
  effectiveReasoningLevel,
  getProfileForRole,
  MAX_TOKENS_BUDGET_BY_LEVEL,
  openrouterReasoning,
  reasoningParamForProfile,
  selectableReasoningLevels,
  settingsForRole,
  stripOrphanThinkTags,
} from "../../../src/lib/model-registry/resolve";
import { ROLE_BINDINGS } from "../../../src/lib/model-registry/role-bindings";
import {
  REASONING_LEVELS,
  type ModelRole,
} from "../../../src/lib/model-registry/types";
import { shouldInjectCacheControl } from "../../../src/lib/openrouter-cache";
import {
  dynamic,
  FLEET,
  installBoundFleet,
  profileOf,
  row,
} from "../../lib/live-fleet";

// Role resolution reads the database now, so the suite installs rows for the
// models `ROLE_BINDINGS` names. See `live-fleet.ts` — they are fixture data
// matching what the sync has measured, not configuration.
beforeAll(() => {
  installBoundFleet();
  clearResolvedModelCache();
});

/**
 * C1 invariant: the registry is a refactor with ZERO behaviour change.
 * These tests pin (a) the request settings byte-for-byte against the
 * historical per-role objects from `lib/openrouter.ts`, and (b) the
 * default model ids against what prod served before the registry
 * existed. Any intentional change here must go through the C3
 * promotion gate first.
 *
 * Gated change 2026-06-12: `chat` flipped to minimax-m3 through the
 * C3 promotion gate (run 3aeec9d1-… vs the M2.7 baseline). M3 carries
 * the documented `zdr: false` exemption, so the chat envelope pin
 * tracks it; every other binding keeps the historical envelope.
 */

/**
 * The vetted upstream pool for deepseek-v4-flash, asserted on every role that
 * carries it. Pinned here because widening it is a QUALITY change, not a
 * routing tweak: membership is decided by whether an upstream returns the
 * answer INTACT when the response ends in a tool call, whether it populates the
 * implicit prompt cache (a miss bills ~4.6× per turn), and whether its reasoning
 * converges — none of which `sort: "throughput"` can see. See the profile for
 * the 2026-08-13 measurements and the per-provider exclusion reasons.
 *
 * Together was REMOVED on 2026-08-13 for truncating answers mid-sentence at the
 * tool-call boundary; Fireworks and CoreWeave replaced it once their own
 * exclusions (HTTP 429, no cache) re-benched clean.
 *
 * CoreWeave was REMOVED on 2026-08-28 for corrupting emitted text: U+200B and
 * fullwidth punctuation inserted next to NUMBERS, reproduced 2/3 runs against
 * 0/3 on DeepInfra and 0/2 on Fireworks. Both defects that cost a pool member
 * so far were answer-integrity, not speed or price — which is why membership
 * is pinned here rather than left to `sort`.
 */
const VETTED_DEEPSEEK_UPSTREAMS = [
  "baseten",
  "fireworks",
  "venice",
  "deepinfra",
];

describe("settingsForRole — parity with historical settings objects", () => {
  test("chat-fallback carries minimax-m3's own envelope, not the historical one", () => {
    // Rebound to minimax-m3 on 2026-08-02 so the fallback shares neither
    // family nor upstream with the DeepSeek primary.
    //
    // The Novita PIN is gone as of 2026-08-23. This role is what the page
    // builder falls back to when a build dies, so every M3 turn was being
    // served by one upstream — and `order` disables `sort`, so nothing faster
    // could ever win. What this test pins is that the fallback routes through a
    // POOL: `sort` present, `order` absent.
    //
    // The budget is the shared level→budget table's `low`, not a per-model pin.
    // M3 carried a hand-set 5 000 until 2026-08-30; a live probe at three
    // budgets returned 5 452 / 4 322 / 2 996 reasoning tokens for 512 / 1 500 /
    // 8 000 requested — non-monotonic, so the pin never bound anything.
    expect(
      settingsForRole(
        ROLE_BINDINGS["chat-fallback"],
        getProfileForRole("chat-fallback"),
      ),
    ).toEqual({
      provider: {
        require_parameters: true,
        zdr: true,
        only: ["Novita", "DeepInfra"],
        sort: "throughput",
      },
      reasoning: { enabled: true, max_tokens: MAX_TOKENS_BUDGET_BY_LEVEL.low },
      usage: { include: true },
    });
  });

  test("dispatch-cheap carries the deepseek-v4-flash vetted pool + throughput sort", () => {
    expect(
      settingsForRole(
        ROLE_BINDINGS["dispatch-cheap"],
        getProfileForRole("dispatch-cheap"),
      ),
    ).toEqual({
      provider: {
        require_parameters: true,
        zdr: true,
        only: VETTED_DEEPSEEK_UPSTREAMS,
        sort: "throughput",
      },
      // An EFFORT, not a budget — deepseek-v4-flash publishes `low/high/max`,
      // and a model with a ladder is steered by the ladder. It used to send a
      // hand-set 1 500-token budget because the curated profile declared no
      // ladder for it; the catalogue always had one.
      reasoning: { enabled: true, effort: "high" },
      usage: { include: true },
    });
  });

  // The two pre-extract roles no longer share one envelope, and that is the
  // point: the kind carries the PROFILE's pool on top of its own role-level
  // sort. Bound to deepseek-v4-flash, `pre-extract` used to run on the full ZDR
  // pool because this kind dropped `only`/`ignore` — reaching the upstreams the
  // profile excludes on measurement.
  test("preextract carries the bound profile's vetted pool + the role's throughput sort", () => {
    expect(
      settingsForRole(
        ROLE_BINDINGS["pre-extract"],
        getProfileForRole("pre-extract"),
      ),
    ).toEqual({
      reasoning: { effort: "minimal" },
      provider: {
        require_parameters: true,
        zdr: true,
        only: VETTED_DEEPSEEK_UPSTREAMS,
        sort: "throughput",
      },
    });
    // gpt-oss-120b declares no POOL, so it gains no `only` — a profile without
    // one must not inherit another's. It does carry its own `ignore`: the
    // Fireworks exclusion moved onto the gpt-oss profiles on 2026-08-29 (it was
    // hardcoded in the memory-utility builder, where it also hit models the
    // measurement never covered). On the model, it now travels to every role
    // gpt-oss serves — which is what a defect in a serving stack warrants.
    expect(
      settingsForRole(
        ROLE_BINDINGS["pre-extract-fallback"],
        getProfileForRole("pre-extract-fallback"),
      ),
    ).toEqual({
      reasoning: { effort: "minimal" },
      provider: {
        require_parameters: true,
        zdr: true,
        sort: "throughput",
        ignore: ["fireworks"],
        only: ["cerebras", "groq", "deepinfra"],
      },
    });
  });

  // `only` is the recall judge's LATENCY guard, and it is pinned here because
  // widening it silently re-admits an upstream whose spread reaches the 15 s
  // recall timeout — where the cost is a turn with no memory block at all, not
  // a slow turn. Measured 2026-08 over 200 judge calls: DeepInfra mean 4.6 s /
  // max 9.7 s against Cerebras 1.0 / 4.9 and Groq 2.1 / 4.5.
  test("active-memory envelope = the P5-bis recall envelope (throughput sort + quality floor + latency shortlist)", () => {
    expect(
      settingsForRole(
        ROLE_BINDINGS["active-memory"],
        getProfileForRole("active-memory"),
      ),
    ).toEqual({
      provider: {
        require_parameters: true,
        zdr: true,
        sort: "throughput",
        ignore: ["fireworks"],
        // Derived from the endpoints now, and sent only where filtering leaves
        // a host standing. It used to be sent to any model that declared no
        // pool — a test that read as "always exempt" once the sync began
        // computing a pool for every model.
        quantizations: ["bf16", "fp16", "unknown"],
        only: ["cerebras", "groq"],
      },
      // `enabled: true` arrived when the two memory kinds started resolving
      // reasoning THROUGH the profile (`reasoningParamForProfile`) instead of
      // hardcoding `{ effort }`. For an effort-style family like gpt-oss the
      // pair is semantically the same switch; the change exists so that
      // `max-tokens`-style profiles stop receiving an `effort` their pool
      // ignores, which ran them with unbounded reasoning.
      reasoning: { enabled: true, effort: "medium" },
    });
  });

  test("bare roles carry their profile's provider policy (zdr always; sort when the profile asks), WITHOUT require_parameters", () => {
    // The reasoning/usage envelope is left to the call site, but the
    // provider block (zdr especially) must never be dropped. Unlike `chat`,
    // bare roles omit `require_parameters` — they never tool-call, and the
    // flag would exclude a pinned model's only ZDR endpoint when it omits a
    // sent parameter (Gemini's Vertex route doesn't advertise `temperature`).
    // A bare role now carries the row's whole vetted pool, `only` included —
    // it used to carry only what a curated profile happened to declare, so a
    // model nobody hand-wrote a profile for ran these calls on open routing.
    const geminiPool = {
      provider: { zdr: true, only: ["google-vertex"] },
    };
    // cheap-tasks is bound to gpt-oss-20b, the model the Fireworks
    // noise-injection was measured on (6/6). The exclusion is on the row, so
    // even a bare role carries it.
    expect(
      settingsForRole(
        ROLE_BINDINGS["cheap-tasks"],
        getProfileForRole("cheap-tasks"),
      ),
    ).toEqual({
      provider: {
        zdr: true,
        ignore: ["fireworks"],
        only: ["groq", "deepinfra"],
        sort: "throughput",
      },
    });
    expect(
      settingsForRole(ROLE_BINDINGS.vision, getProfileForRole("vision")),
    ).toEqual(geminiPool);
    expect(
      settingsForRole(
        ROLE_BINDINGS["vision-fallback"],
        getProfileForRole("vision-fallback"),
      ),
    ).toEqual(geminiPool);
    // A throughput-sorted profile with a vetted pool (deepseek-v4-flash)
    // surfaces both `sort` and `only`.
    expect(
      settingsForRole(
        ROLE_BINDINGS["compaction-summarizer"],
        getProfileForRole("compaction-summarizer"),
      ),
    ).toEqual({
      provider: {
        zdr: true,
        sort: "throughput",
        only: VETTED_DEEPSEEK_UPSTREAMS,
      },
    });
  });

  // REGRESSION GUARD, and the reason this test is worth its weight: `order` and
  // `sort` do not compose — OpenRouter consults the pin first, so a profile
  // carrying both routes unsorted. deepseek-v4-flash shipped exactly that from
  // 2026-08-02 to 2026-08-05, which pinned every agent turn to DeepInfra and
  // made its declared throughput sort dead config. Measured on a 4 096-token
  // generation, that pin was the SLOWEST working upstream in the pool: 67 tok/s
  // and 62.0s, against BaseTen's 283 tok/s and 14.9s.
  test("chat routes on live throughput within the vetted pool — never on a pin", () => {
    const chat = settingsForRole(ROLE_BINDINGS.chat, getProfileForRole("chat"));
    expect(chat?.provider).toEqual({
      require_parameters: true,
      zdr: true,
      only: VETTED_DEEPSEEK_UPSTREAMS,
      sort: "throughput",
    });
    expect(chat?.provider).not.toHaveProperty("order");
  });

  test("transform runs ZDR + throughput-sorted over the vetted pool (deepseek-v4-flash policy)", () => {
    expect(
      settingsForRole(ROLE_BINDINGS.transform, getProfileForRole("transform")),
    ).toEqual({
      provider: {
        zdr: true,
        sort: "throughput",
        only: VETTED_DEEPSEEK_UPSTREAMS,
      },
    });
  });
});

describe("role bindings — default model ids pinned (chat: gated M3 flip)", () => {
  const expectedIds: Record<ModelRole, string> = {
    chat: "deepseek/deepseek-v4-flash-0731",
    "chat-fallback": "minimax/minimax-m3",
    // Workflow executor defaults to the chat profile (reliability first).
    workflow: "deepseek/deepseek-v4-flash-0731",
    "dispatch-cheap": "deepseek/deepseek-v4-flash-0731",
    "pre-extract": "deepseek/deepseek-v4-flash-0731",
    "pre-extract-fallback": "openai/gpt-oss-120b",
    // P5-bis (2026-07): 120b @ medium = 16/16 recall evals; 20b unstable.
    // Stays on gpt-oss while the three WRITE roles below moved: it is the only
    // memory role on a turn's hot path, behind a 15 s ceiling, and
    // deepseek-v4-flash runs at 40-60 TPS.
    "active-memory": "openai/gpt-oss-120b",
    // The write path moved to deepseek-v4-flash on 2026-08-04: memory-eval
    // 15/16 against gpt-oss 13/16 at TEN repeats, with the three cases gpt-oss
    // lost being the ones that write permanent rows (see the rationale on the
    // bindings themselves). Re-pin these three only against another 10-repeat
    // run — at 3 repeats this suite reported 16/16 while four cases were broken.
    "memory-extract": "deepseek/deepseek-v4-flash-0731",
    "memory-distill": "deepseek/deepseek-v4-flash-0731",
    "compaction-summarizer": "deepseek/deepseek-v4-flash-0731",
    "cheap-tasks": "openai/gpt-oss-20b",
    // ONE file-capable model backs both the `vision` tool and the `extract`
    // engine (no separate extraction role) — 3.5-flash-lite since 2026-07-25
    // (5×/3× cheaper, 12/12 full-recall free-form replays), cheap 3.1-lite
    // fallback. See ROLE_BINDINGS.vision.
    vision: "google/gemini-3.5-flash-lite",
    "vision-fallback": "google/gemini-3.1-flash-lite",
    // Its own role, not `vision`'s: judging whether a screen was designed is a
    // different job from reading a document. Left Gemini on 2026-08-19 when the
    // BUILDER landed there — the two may never share a family, or the critic
    // reviews its own work (see both bindings).
    "page-review": "openai/gpt-5.6-luna",
    // Its own role since 2026-08-18. Before that the page BUILDER resolved
    // `resolveModel("chat")` at module load, so no pin — not the team's
    // flagship, not the eval header — could reach it, and every page the
    // product ever generated came from the code default. Repointed 2026-08-19
    // on a neutral-judge A/B (the control failed to save a page at all on the
    // canonical case). GLM 5.3 Flash held it for one evening on 2026-09-04 —
    // a bench, not a judge — and the A/B that followed sent it back: −0.65
    // design, −0.07 correctness, one dead pager, at a third of the price.
    // Pinned here so the next move is a deliberate edit with a run behind it,
    // exactly like the critic above.
    "page-build": "google/gemini-3.7-flash",
    transform: "deepseek/deepseek-v4-flash-0731",
    "transform-fallback": "google/gemini-3.7-flash",
    "tool-repair": "openai/gpt-oss-120b",
    // Stayed on gpt-oss: deepseek runs away on reasoning here (see binding).
    "memory-consolidate": "openai/gpt-oss-120b",
    // Split out of `memory-consolidate` — the two tasks that shared that role
    // want opposite models (10/10 vs 6/10 on the over-generalization guard).
    "memory-promote": "deepseek/deepseek-v4-flash-0731",
  };

  for (const [role, id] of Object.entries(expectedIds)) {
    test(`${role} → ${id}`, () => {
      expect(getProfileForRole(role as ModelRole).catalog.id).toBe(id);
    });
  }

  test("cache wrapping mirrors the historical wiring", () => {
    const wrapped: ModelRole[] = [
      "chat",
      "chat-fallback",
      "workflow",
      "dispatch-cheap",
      "pre-extract",
      "pre-extract-fallback",
      // The builder is a multi-step agent replaying a byte-stable system
      // prompt on every step — the same shape the chat roles wrap for, and the
      // reason its binding declares the chat envelope rather than `bare`.
      "page-build",
    ];
    for (const [role, binding] of Object.entries(ROLE_BINDINGS)) {
      expect(binding.wrapCache).toBe(wrapped.includes(role as ModelRole));
    }
  });

  test("the page builder and its critic never share a family", () => {
    // The critic exists to catch what the builder cannot see in its own work,
    // and a model asked to grade its own family praises it — the documented
    // failure the role was created around. Both bindings carried that rule in
    // prose and it still had to be remembered by hand on 2026-08-19, when the
    // builder moved onto the critic's model. Cheaper as an assertion.
    //
    // Family is derived from the model id now, so the check no longer needs a
    // registry: `gemini-3.7-flash` and `gpt-5.6-luna` cannot be the same maker
    // whatever the rows say.
    const builder = ROLE_BINDINGS["page-build"].profileKey;
    const critic = ROLE_BINDINGS["page-review"].profileKey;
    expect(builder).not.toBe(critic);
    expect(normalizeFamily(builder.split("-")[0] ?? "")).not.toBe(
      normalizeFamily(critic.split("-")[0] ?? ""),
    );
  });
});

describe("role bindings — structural integrity", () => {
  test("every binding names its own role and a non-empty profile key", () => {
    // That a key RESOLVES is no longer a static fact: profiles come from the
    // database. The boot checks it for real against the live rows and names
    // whatever is missing (`index.ts`), which is a stronger check than a
    // TypeScript lookup ever was — it catches a model that was retired
    // upstream, not just one that was never typed.
    for (const [role, binding] of Object.entries(ROLE_BINDINGS)) {
      expect(binding.role).toBe(role as ModelRole);
      expect(`${role}:${binding.profileKey.length > 0}`).toBe(`${role}:true`);
    }
  });

  test("the applied chat / workflow defaults carry passing eval evidence", () => {
    // THE replacement for the old flagship selection gate. Selection is now
    // governed by `enabled` alone, so evals guard exactly one thing: which
    // model actually serves by default. Swapping `ROLE_BINDINGS.chat` without
    // a gate run must fail CI.
    // The evidence moved onto the BINDING on 2026-08-30. It used to sit on the
    // profile, which could not express what a gate run actually measures — a
    // model doing a JOB, against the model that held the job before it. The
    // proof it could not: `minimax-m3` carried a stamp whose own comment
    // claimed it was the `chat` default four weeks after the flip moved `chat`
    // to `deepseek-v4-flash`, and nothing caught it, because the stamp was
    // never tied to the decision it was evidence for.
    for (const role of ["chat", "workflow"] as const) {
      const binding = ROLE_BINDINGS[role];
      expect(`${role}:${binding.evalGate?.status ?? "MISSING"}`).toBe(
        `${role}:passed`,
      );
      // A run id, so the claim is checkable rather than asserted.
      expect(`${role}:${binding.evalGate?.lastRunId ?? "MISSING"}`).not.toBe(
        `${role}:MISSING`,
      );
    }
  });
});

/**
 * The invariants below used to iterate the 22 curated profiles. They now run
 * over the DERIVATION, on a synthetic fleet spanning the shapes it has to
 * handle. That is the stronger form: the old version could only fail when
 * somebody edited a file, this one fails when the RULE is wrong — for every
 * model the sync will ever discover.
 */
describe("registry integrity — over the derivation", () => {
  test("profile keys and ids come from the row, coherently", () => {
    const ids = new Set<string>();
    for (const profile of FLEET) {
      expect(profile.key.length).toBeGreaterThan(0);
      expect(ids.has(`${profile.key}:${profile.catalog.id}`)).toBe(false);
      ids.add(`${profile.key}:${profile.catalog.id}`);
    }
  });

  test("every function has at least one model a team can pick", () => {
    // The picker-relevant invariant: no function may render an empty menu.
    // Selection is `enabled` plus a MEASURED eligibility verdict, so a model
    // with no measurement passes on `unknown` — automatic attribution refuses
    // to GRANT on unknown, it never revokes on it.
    for (const fn of MODEL_FUNCTION_KEYS) {
      const options = FLEET.filter((p) => selectableForFunction(p, fn));
      expect(`${fn}:${options.length > 0}`).toBe(`${fn}:true`);
    }
  });

  test("nativeInput activation is a subset of catalog facts (C5)", () => {
    // The product may only send a modality natively when the model truly
    // accepts it upstream. The catalog is the hard ceiling; nativeInput is the
    // product decision under it.
    for (const profile of FLEET) {
      const { nativeInput } = profile.assessment;
      const modalities = profile.catalog.inputModalities;
      if (nativeInput.image) expect(modalities).toContain("image");
      if (nativeInput.video) expect(modalities).toContain("video");
      if (nativeInput.audio) expect(modalities).toContain("audio");
      if (nativeInput.fileMimeTypes.length > 0) {
        expect(modalities).toContain("file");
      }
    }
  });

  test("native input is activated wherever the catalog allows it", () => {
    // Replaces a frozen allow-list of nine profile keys, which pinned WHICH
    // models may read an attachment and had left most of the fleet routing
    // images through the `vision` tool despite accepting them natively.
    for (const modalities of [
      ["text"],
      ["text", "image"],
      ["text", "image", "file"],
      ["text", "file"],
    ]) {
      const profile = profileOf({
        dynamicProfile: dynamic({ inputModalities: modalities }),
      });
      const { nativeInput } = profile.assessment;
      expect(`image:${nativeInput.image}`).toBe(
        `image:${modalities.includes("image")}`,
      );
      expect(`pdf:${nativeInput.fileMimeTypes.join(",")}`).toBe(
        `pdf:${modalities.includes("file") ? "application/pdf" : ""}`,
      );
    }
  });

  test("audio and video stay inactive even where the catalog allows them", () => {
    // Nothing in the product produces an audio or video part, so activating
    // either would ship untested surface. That is a fact about US, which is
    // why it does not follow the catalogue like image and file do.
    const profile = profileOf({
      dynamicProfile: dynamic({
        inputModalities: ["text", "image", "audio", "video"],
      }),
    });
    expect(profile.assessment.nativeInput.audio).toBe(false);
    expect(profile.assessment.nativeInput.video).toBe(false);
  });

  test("the applied chat / workflow defaults carry passing eval evidence", () => {
    // THE replacement for the old flagship selection gate. Selection is now
    // governed by `enabled` alone, so evals guard exactly one thing: which
    // model actually serves by default. Swapping `ROLE_BINDINGS.chat` without
    // a gate run must fail CI.
    // The evidence moved onto the BINDING on 2026-08-30. It used to sit on the
    // profile, which could not express what a gate run actually measures — a
    // model doing a JOB, against the model that held the job before it. The
    // proof it could not: `minimax-m3` carried a stamp whose own comment
    // claimed it was the `chat` default four weeks after the flip moved `chat`
    // to `deepseek-v4-flash`, and nothing caught it, because the stamp was
    // never tied to the decision it was evidence for.
    for (const role of ["chat", "workflow"] as const) {
      const binding = ROLE_BINDINGS[role];
      expect(`${role}:${binding.evalGate?.status ?? "MISSING"}`).toBe(
        `${role}:passed`,
      );
      // A run id, so the claim is checkable rather than asserted.
      expect(`${role}:${binding.evalGate?.lastRunId ?? "MISSING"}`).not.toBe(
        `${role}:MISSING`,
      );
    }
  });

  test("steerability is derived from the catalog, not hand-listed", () => {
    // Sanity on the derivation itself: neither empty nor everything, or the
    // rule is silently degenerate and every picker would look the same.
    const steerable = FLEET.filter(
      (profile) => selectableReasoningLevels(profile).length > 0,
    );
    expect(steerable.length).toBeGreaterThan(0);
    expect(steerable.length).toBeLessThan(FLEET.length);
  });

  test("a profile never defaults to a reasoning level upstream rejects", () => {
    for (const profile of FLEET) {
      const { style, defaultLevel } = profile.assessment.reasoning;
      const catalogReasoning = profile.catalog.reasoning;
      // Budget-style profiles send `max_tokens`, not an effort string, so the
      // effort ladder does not constrain them.
      if (style !== "effort") continue;
      // Reasoning that cannot be switched off must never default to `none`.
      if (catalogReasoning?.mandatory === true) {
        expect(`${profile.key}:${defaultLevel}`).not.toBe(
          `${profile.key}:none`,
        );
      }
      const supported = catalogReasoning?.supportedEfforts;
      if (supported === undefined || defaultLevel === "none") continue;
      expect(`${profile.key}:${supported.includes(defaultLevel)}`).toBe(
        `${profile.key}:true`,
      );
    }
  });

  test("the cache STRATEGY and the cache-control MARKERS answer different questions", () => {
    // One field used to try to answer both: how a vendor CHARGES for caching,
    // and whether the caller must place `cache_control` breakpoints. They are
    // independent — every OpenAI model discounts reads (so: not `none`) and
    // none of them takes markers — and conflating them is what had the gpt-oss
    // pair recorded as `cache: none` while four of their hosts publish a read
    // discount. Only the charging half is derived from prices; the marker
    // question is a dialect fact `openrouter-cache.ts` answers from the id.
    const cached = profileOf({
      pricing: {
        inputPerMTok: 1,
        outputPerMTok: 4,
        cacheReadPerMTok: 0.1,
      },
    });
    expect(cached.assessment.cache.strategy).toBe("implicit");
    expect(shouldInjectCacheControl("anthropic/claude-sonnet-5")).toBe(true);
    expect(shouldInjectCacheControl("openai/gpt-5.6-luna")).toBe(false);
  });
});

/**
 * The user-facing thinking-depth picker (2026-07-27). It replaced the model
 * selector in the prompt bar, so what it offers has to be exactly what the
 * serving model honours — an inert control is worse than no control.
 */
describe("thinking depth — what a user may actually request", () => {
  test("the API's level enum matches the registry's, value for value", () => {
    // Two declarations exist on purpose: @fretik/shared needs VALUES at the
    // HTTP + DB boundary and must not import the registry (it ships inside the
    // Trigger.dev bundle). A divergence would let the API accept a level the
    // registry cannot map to a wire parameter, so pin them together.
    expect([...reasoningLevelSchema.options].sort()).toEqual(
      [...REASONING_LEVELS].sort(),
    );
  });

  test("only a real ladder offers a choice, whatever the wire style", () => {
    for (const profile of FLEET) {
      const levels = selectableReasoningLevels(profile);
      // Never a single dead option, and never a level upstream rejects.
      expect(levels.length === 0 || levels.length > 1).toBe(true);
      const supported = profile.catalog.reasoning?.supportedEfforts ?? [];
      for (const level of levels) {
        expect(`${profile.key}:${supported.includes(level)}`).toBe(
          `${profile.key}:true`,
        );
      }
      // Non-reasoning models expose nothing at all.
      if (profile.assessment.reasoning.style === "none") {
        expect(`${profile.key}:${levels.length}`).toBe(`${profile.key}:0`);
      }
    }
  });

  test("a model whose catalogue named no ladder is steered by budget", () => {
    // The style is NOT the gate on whether a level does anything: a contract
    // with no published ladder still answers to a level, which selects the
    // budget from the shared table. It offers no MENU (there are no rungs to
    // name), which is a different statement.
    const budget = profileOf({
      dynamicProfile: dynamic({
        supportsReasoning: true,
        reasoning: { mandatory: false },
      }),
    });
    expect(budget.assessment.reasoning.style).toBe("max-tokens");
    expect(selectableReasoningLevels(budget)).toEqual([]);
    expect(reasoningParamForProfile(budget, "high")).toEqual({
      enabled: true,
      max_tokens: MAX_TOKENS_BUDGET_BY_LEVEL.high,
    });
  });

  test("`max` reaches the wire instead of being served as `xhigh`", () => {
    // It used to be clamped. The reason given was that the OpenRouter SDK's
    // `effort` union stops at `xhigh` — true, and irrelevant: the API accepts
    // `max` (verified 2026-08-30 against `deepseek-v4-flash-0731`, which
    // returns 200, while an invalid value is refused with the API's own list
    // ending in `max`). A provider package's TYPING is not a capability, and
    // 47 of the 396 catalogue models publish this rung.
    const withMax = FLEET.find((profile) =>
      (profile.catalog.reasoning?.supportedEfforts ?? []).includes("max"),
    );
    expect(withMax).toBeDefined();
    expect(withMax && reasoningParamForProfile(withMax, "max")).toEqual({
      enabled: true,
      effort: "max",
    });
  });

  test("`max` is spelled through `extraBody`, the SDK's own escape hatch", () => {
    // The union cannot hold it, so it travels in the field the provider
    // documents for exactly this — no cast, and `reasoning` is left unset so
    // the two cannot contradict each other in one request body.
    const wire = openrouterReasoning({ enabled: true, effort: "max" });
    expect(wire.extraBody).toEqual({
      reasoning: { enabled: true, effort: "max" },
    });
    expect(wire.reasoning).toBeUndefined();

    // Every other rung stays on the typed field.
    const normal = openrouterReasoning({ enabled: true, effort: "high" });
    expect(normal.reasoning).toEqual({ enabled: true, effort: "high" });
    expect(normal.extraBody).toBeUndefined();
  });

  test("the product's ladder is exactly what the API accepts", () => {
    // Measured 2026-08-30 across all 396 catalogue models: the distinct
    // published efforts are none/minimal/low/medium/high/xhigh/max and nothing
    // else, and the API's own rejection message enumerates the same seven. So
    // there is no rung a model can offer that this product cannot express.
    expect([...REASONING_LEVELS]).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  test("a mandatory reasoner never offers to switch reasoning off", () => {
    for (const profile of FLEET) {
      if (profile.catalog.reasoning?.mandatory !== true) continue;
      expect(
        `${profile.key}:${selectableReasoningLevels(profile).includes("none")}`,
      ).toBe(`${profile.key}:false`);
    }
  });

  test("the assistant menu is never entirely inert", () => {
    // Not an assertion that every model steers — some publish no ladder. This
    // pins that the control is reachable by switching model.
    const assistant = FLEET.filter((p) =>
      selectableForFunction(p, "assistant"),
    );
    expect(assistant.length).toBeGreaterThan(1);
    expect(
      assistant.filter((p) => selectableReasoningLevels(p).length > 0).length,
    ).toBeGreaterThan(0);
  });

  describe('"No thinking" actually switches thinking off', () => {
    // Measured on GPT-5.6 Luna 2026-07-27: omitting the reasoning param leaves
    // 13 reasoning tokens (Azure's own default); `{ enabled: false }` and
    // `{ effort: "none" }` both leave 0. A user who picks "No thinking" must get
    // the off-switch, not the omission.
    const withNone = profileOf({
      dynamicProfile: dynamic({
        supportsReasoning: true,
        reasoning: {
          mandatory: false,
          supportedEfforts: ["none", "low", "medium", "high"],
        },
      }),
    });

    test("an explicit `none` sends the off-switch", () => {
      expect(reasoningParamForProfile(withNone, "none")).toEqual({
        enabled: false,
        effort: "none",
      });
    });

    test("a profile that merely DEFAULTS to none stays byte-identical", () => {
      // A default of `none` must not gain a parameter it never sent, or every
      // cached prefix on that path changes. Reached through a single-rung
      // `none` ladder, which is the only way a derivation produces that default.
      const alwaysOff = profileOf({
        dynamicProfile: dynamic({
          supportsReasoning: true,
          reasoning: { mandatory: false, supportedEfforts: ["none"] },
        }),
      });
      expect(alwaysOff.assessment.reasoning.defaultLevel).toBe("none");
      expect(reasoningParamForProfile(alwaysOff)).toBeUndefined();
    });

    test("a model with no reasoning support still sends nothing", () => {
      // `require_parameters` would empty the pool on a param it can't advertise.
      for (const profile of FLEET) {
        if (profile.assessment.reasoning.style !== "none") continue;
        expect(reasoningParamForProfile(profile, "none")).toBeUndefined();
        expect(reasoningParamForProfile(profile, "high")).toBeUndefined();
      }
    });
  });

  describe("effectiveReasoningLevel", () => {
    // A two-rung ladder with `high` as its middle-rung default — the smallest
    // real ladder there is, so it exercises every branch.
    const twoRung = profileOf({
      dynamicProfile: dynamic({
        supportsReasoning: true,
        reasoning: { mandatory: false, supportedEfforts: ["high", "xhigh"] },
      }),
    });
    const noLadder = profileOf({
      dynamicProfile: dynamic({
        supportsReasoning: true,
        reasoning: { mandatory: false },
      }),
    });

    test("passes a supported non-default level through", () => {
      // `xhigh` is the middle rung of a two-rung ladder, so `high` is the
      // non-default one here.
      expect(effectiveReasoningLevel(twoRung, "high")).toBe("high");
    });

    test("drops the profile's OWN default", () => {
      // Sending it explicitly changes the wire bytes of a turn nobody asked to
      // change, which costs every cached prefix on that path.
      expect(twoRung.assessment.reasoning.defaultLevel).toBe("xhigh");
      expect(effectiveReasoningLevel(twoRung, "xhigh")).toBeUndefined();
    });

    test("drops a level the model does not support", () => {
      // How a team's stored choice survives a model swap without breaking it.
      expect(effectiveReasoningLevel(twoRung, "minimal")).toBeUndefined();
      expect(effectiveReasoningLevel(twoRung, "garbage")).toBeUndefined();
    });

    test("drops everything for a model with no depth knob", () => {
      expect(effectiveReasoningLevel(noLadder, "high")).toBeUndefined();
    });

    test("unset stays unset", () => {
      expect(effectiveReasoningLevel(twoRung, null)).toBeUndefined();
      expect(effectiveReasoningLevel(twoRung, undefined)).toBeUndefined();
    });
  });
});

describe("transport model ids", () => {
  // There used to be a hand-written map of gateway spellings here, guarded by
  // two tests that checked it against the curated registry. Both are gone with
  // it: ids live on the row, the sync writes every spelling it finds, and it
  // DISCOVERS ones no map had (`glm-5.2` gained its Scaleway id with nobody
  // typing it). What is worth asserting is the property the rollback depends on.
  test("resolution reads ids from the row, and never invents one", () => {
    const both = row();
    expect(both.modelIds.openrouter).toBe("acme/frontier-9");
    expect(both.modelIds.gateway).toBe("acme/frontier9");
    // Never another transport's spelling: sending `acme/frontier9` to
    // OpenRouter is a 404, not a synonym.
    expect(profileOf({ transport: "openrouter" }).catalog.id).toBe(
      "acme/frontier-9",
    );
    expect(profileOf({ transport: "gateway" }).catalog.id).toBe(
      "acme/frontier9",
    );
  });
});

describe("orphan <think> strip — M3 leaks a dangling </think> into content", () => {
  test("no-op when no think token is present", () => {
    expect(stripOrphanThinkTags("plain answer")).toBe("plain answer");
  });

  test("removes a dangling close tag", () => {
    expect(stripOrphanThinkTags("done</think> answer")).toBe("done answer");
  });

  test("removes a tag on its own line without leaving a blank line", () => {
    expect(stripOrphanThinkTags("a\n</think>\nb")).toBe("a\nb");
  });

  test("catches a tag split across two streamed deltas", () => {
    const s = createOrphanThinkStreamStripper();
    const out = s.push("hi </thi") + s.push("nk> there") + s.flush();
    expect(out).toBe("hi  there");
  });
});
