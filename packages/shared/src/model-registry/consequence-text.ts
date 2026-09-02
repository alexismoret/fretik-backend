import type { Consequence } from "./types";

/**
 * A consequence, in English, for a terminal.
 *
 * The other half of the split `EligibilityResult` already makes: `unmet` is
 * structure that crosses an API boundary, `failed` is the same information
 * flattened to English for logs and the CLI. Here the structured `Consequence`
 * is the contract and this is one of its two renderings — the web surface has
 * the other, in `en.ts` and `fr.ts`.
 *
 * That is duplication of TEXT, not of decision: nothing here chooses whether a
 * consequence applies, and the two renderings are free to differ in length.
 * The alternative — teaching the backend to read locale files — would be worse
 * for a message whose only reader is a shell.
 *
 * The wording is deliberately unhurried. It is read by a person at three in
 * the morning deciding whether they have just made things worse, which is the
 * one moment where a terse log line is the wrong economy.
 */
export const describeConsequence = (consequence: Consequence): string => {
  switch (consequence.code) {
    case "published-disabled-on-cost":
      return `Its pool costs $${consequence.inputPerMTok.toString()} in / $${consequence.outputPerMTok.toString()} out per MTok, past the $${consequence.capInputPerMTok.toString()}/$${consequence.capOutputPerMTok.toString()} budget. Discovery no longer filters on price — the model is published and visible, it is simply not being paid for. \`enable\` overrides that deliberately; the nightly sync re-disables it only if the price rises again, and re-enables it on its own if the price falls back under budget.`;
    case "catalogue-derived-profile-only":
      return "It has NO hand-written TypeScript profile — it runs on catalogue-derived facts. That is supported, and it means nobody has recorded a reasoning envelope, a cache strategy or a native-input policy for it.";
    case "was-already-enabled":
      return "It was already enabled; the disabled reason and the policy-fail streak were cleared anyway. The streak reset matters: without it, yesterday's consecutive hard-policy failures would disable the model again on the next sync even though the underlying problem is fixed.";
    case "still-unpublished":
      return `Status is still ${consequence.status}, so teams still cannot select it. Run \`promote\` for that.`;
    case "roles-bypass-enabled":
      return `WARNING: this model is bound to internal role(s) ${consequence.roles.join(", ")}. \`enabled\` gates TEAM SELECTION only — ROLE_BINDINGS resolves profiles directly and bypasses it, so those roles keep running on this model.`;
    case "quarantines-kept-per-transport":
      return `${consequence.kept.toString()} active quarantine(s) were KEPT: they are recorded per transport, so they still apply if the model comes back.`;
    case "pool-widened":
      return `That was the last VETTED upstream, so routing is now OPEN to the ${consequence.remaining.toString()} remaining endpoint(s) minus the quarantined ones — an unmeasured host beats a known-bad one. The vetted pool comes back on its own once quarantines expire and re-probe clean.`;
    case "transport-switched":
      return `Nothing clean was left on ${consequence.from}, so the model was SWITCHED to ${consequence.to}, which serves it from a different set of hosts. Verify cost and caching there.`;
    case "now-last-resort":
      return "The upstream stays in service — an empty pool is a hard outage — but the MODEL is now last-resort: roles bound to it fall back to their fallback model, and teams that selected it fall back to the default. Widen the pool, add a transport, or replace the model.";
    case "breaker-would-need":
      return `The breaker files "${consequence.kind}" by itself after ${consequence.generations.toString()} distinct generations inside ${consequence.windowMinutes.toString()} min — one pathological answer can never trip it, and neither can this be undone by one.`;
    case "release-is-review-trigger":
      return `Release is due ${consequence.releaseAt.slice(0, 10)}, and that date is a review trigger rather than an amnesty: the sync re-probes on it, releases the host only if the probe is clean, and extends the quarantine otherwise.`;
    case "pool-renarrowed":
      return "Routing re-narrowed to the vetted pool, which had a member left.";
    case "last-resort-lifted":
      return "The last-resort flag is lifted, so roles and team selections point back at this model.";
    case "exclusion-is-durable":
      return "This is an exclusion, not a quarantine: nothing releases it. No re-probe runs and no date expires — it stands until somebody puts the host back, which is what makes it the right instrument for a reason a probe cannot settle.";
    case "pool-emptied":
      return "That was the last vetted member. Routing widens to whatever else the catalogue lists for this model, which is a set nobody vetted — put a host back or expect the breaker to be the only thing between a turn and an unknown upstream.";
    case "returns-on-next-sync":
      return "The host is eligible again. It re-enters the pool on the next sync pass, once the endpoints are re-read — not immediately.";
  }
};
