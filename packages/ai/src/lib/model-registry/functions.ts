import type {
  CapabilitySignals,
  UnmetRequirement,
} from "@fretik/shared/model-registry/eligibility";
import {
  eligibleFunctions,
  functionEligibility,
  signalsFromLive,
} from "@fretik/shared/model-registry/eligibility";
import type { ModelFunctionKey } from "@fretik/shared/model-registry/functions";
import { MODEL_FUNCTION_KEYS } from "@fretik/shared/model-registry/functions";
import type { LiveModelState } from "@fretik/shared/model-registry/types";
import { getLiveStateSync } from "@fretik/shared/services/model-registry/live";
import type { ModelProfile, ModelRole } from "./types";

/**
 * Which internal role belongs to which team-facing function.
 *
 * The map is TOTAL over `ModelRole` and a unit test says so, because the
 * failure mode of an incomplete one is silent: a role with no function reads a
 * team's settings, finds nothing, and quietly serves the code default forever.
 * A role that genuinely must not be steerable says `"auto"` — an answer, not a
 * gap.
 */
export const ROLE_FUNCTION: Record<ModelRole, ModelFunctionKey | "auto"> = {
  chat: "assistant",
  workflow: "assistant",
  "dispatch-cheap": "assistant",

  "pre-extract": "documents",
  transform: "documents",
  "compaction-summarizer": "documents",

  "memory-extract": "memory",
  "memory-distill": "memory",
  // Was `fixed` since P8.2 to stop a team's utility pick degrading a system
  // judge below the 120b that makes temporal re-anchoring reliable. That
  // protection is now a RULE rather than a lock: the `memory` floors keep out
  // exactly the models the pin was defending against, and a team that wants a
  // stronger writer is no longer told no by a constant.
  "memory-consolidate": "memory",
  "memory-promote": "memory",

  // Was `fixed` since P5-bis: gpt-oss-20b measured unstable as the recall judge
  // at every effort level, and a team's utility pick must not silently degrade
  // the memory of every turn. The `recall` group encodes what that pin was
  // really protecting — a 15 s ceiling on the hot path — as a speed floor and a
  // first-token ceiling, which 20b fails on neither. What it actually failed
  // was judgement quality, so its own binding stays the code default and the
  // recommendation still points there.
  "active-memory": "recall",

  "cheap-tasks": "quick-tasks",
  // Was `fixed`: repair sits on the hot path of every malformed tool call. The
  // `quick-tasks` floors (speed OR price, and a real context) are what that pin
  // was standing in for.
  "tool-repair": "quick-tasks",

  // Was `fixed`. ONE file-capable model backs both the `vision` tool and the
  // extract engine, and the hard image-modality gate is what keeps a team from
  // pointing it at a model that cannot see.
  vision: "vision",

  // Was `fixed` since 2026-08-18, when the builder was found resolving at
  // module load — so every page a team generated came from the code default
  // whatever flagship they had picked. A page is the one artefact a team keeps
  // and reopens; it is now steerable, behind the same floors the assistant has.
  "page-build": "pages",

  // AUTOMATIC, and deliberately not offered. A fallback a team could repoint
  // onto its own primary is not redundancy — it fails exactly when redundancy
  // was the point (the invariant is a DIFFERENT family, not a better model).
  // The page critic is the same argument from the other side: a cheaper critic
  // would not fail loudly, it would praise, which is the one outcome a review
  // exists to prevent.
  "chat-fallback": "auto",
  "pre-extract-fallback": "auto",
  "vision-fallback": "auto",
  "transform-fallback": "auto",
  "page-review": "auto",
};

/**
 * The role whose CODE DEFAULT is a function's recommendation — the "recommended"
 * badge, and what an unset or unusable stored key degrades to.
 */
export const FUNCTION_REPRESENTATIVE: Record<ModelFunctionKey, ModelRole> = {
  assistant: "chat",
  documents: "pre-extract",
  memory: "memory-extract",
  recall: "active-memory",
  "quick-tasks": "cheap-tasks",
  vision: "vision",
  pages: "page-build",
};

/**
 * A profile's capability signals, with curation filling what the row cannot say.
 *
 * The live row owns everything MEASURED — intelligence, the effective window,
 * pool speed, price. The curated catalogue owns what a hand-written profile
 * declares and no database column holds: which modalities we actually send, and
 * whether the model takes tools. Reading modalities off the row would answer
 * `unknown` for every curated model, which would make the entire fleet
 * ineligible for `vision` — including the model that serves it.
 */
export const signalsForProfile = (
  profile: ModelProfile,
  live: LiveModelState | undefined = getLiveStateSync(profile.key),
): CapabilitySignals => ({
  ...(live === undefined ? {} : signalsFromLive(live)),
  ...(live === undefined
    ? { contextTokens: profile.catalog.contextLength }
    : {}),
  inputModalities: profile.catalog.inputModalities,
  tools: profile.catalog.supportedParameters.includes("tools"),
});

/**
 * Whether a team may point a function at a profile.
 *
 * Only a MEASURED failure refuses. `unknown` passes, and that asymmetry is the
 * whole rule: a model nobody has graded must not be auto-recommended, and must
 * not be taken away from a team that chose it either. The same two vetoes as
 * before still apply first — curation's `enabled` and the live row's.
 */
export const selectableForFunction = (
  profile: ModelProfile,
  fn: ModelFunctionKey,
  live: LiveModelState | undefined = getLiveStateSync(profile.key),
): boolean => {
  if (!profile.assessment.enabled) return false;
  if (live && (!live.enabled || live.status !== "published" || live.lastResort))
    return false;
  return (
    functionEligibility(fn, signalsForProfile(profile, live)).verdict !==
    "ineligible"
  );
};

/**
 * What this function asked of the model and did not get — the actionable half
 * of a refusal, structured so the client can word it in its own language.
 *
 * `selectableForFunction` DECIDES; this only EXPLAINS. Nothing may re-derive
 * the decision from a card's own figures: the card reports the throughput of
 * the endpoint a turn is most likely to land on, while eligibility grades the
 * pool MEDIAN, so a client evaluating the same rule against the number it was
 * shown would contradict the verdict it was given.
 *
 * Empty is a legitimate answer, and means the refusal came from one of the two
 * vetoes (curation's `enabled`, or an unusable live row) rather than from a
 * measurement. The caller says "not available here" in that case.
 */
export const unmetForFunction = (
  profile: ModelProfile,
  fn: ModelFunctionKey,
  live: LiveModelState | undefined = getLiveStateSync(profile.key),
): UnmetRequirement[] =>
  functionEligibility(fn, signalsForProfile(profile, live)).unmet;

/**
 * The functions a profile MEASURES UP TO — the positive badge the hub shows,
 * which is a stricter question than `selectableForFunction`: this one grants
 * only on `eligible`, so an ungraded model is offerable without being
 * advertised.
 */
export const functionsForProfile = (
  profile: ModelProfile,
  live?: LiveModelState,
): ModelFunctionKey[] => eligibleFunctions(signalsForProfile(profile, live));

export { MODEL_FUNCTION_KEYS };
export type { ModelFunctionKey };
