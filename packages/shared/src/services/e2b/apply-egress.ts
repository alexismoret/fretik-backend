import type { Sandbox } from "@e2b/code-interpreter";
import { policyFingerprint, type SandboxNetworkPolicy } from "./network-policy";

/**
 * Apply an egress policy to a LIVE sandbox.
 *
 * The policy used to be fixed at `Sandbox.create`, which meant a sandbox kept
 * whatever was true the first time a conversation ran code: a changed org
 * setting, a newly connected app or a rotated dev tunnel only reached it after
 * the sandbox was recycled. `updateNetwork` replaces allow, deny and rules
 * atomically on a running OR just-resumed sandbox — measured at ~180 ms
 * against the live API — so the policy is now re-applied on every
 * code-running turn instead.
 *
 * That same call is what brokers this turn's credential: the `rules` entry
 * makes E2B's egress proxy add `Authorization` on the way out, so a new JWT
 * takes effect immediately and dropping the rule revokes it just as fast.
 */

/** sandboxId → what we last sent, so an unchanged policy costs no round trip. */
interface AppliedEgress {
  fingerprint: string;
  allowOut: string[];
}

const lastApplied = new Map<string, AppliedEgress>();

/**
 * Sandboxes die, and nothing tells this module when. Cap the map rather than
 * wire a teardown hook into every kill path: the entries are two small strings
 * and the only cost of evicting a live one is one extra `updateNetwork`.
 */
const MAX_TRACKED_SANDBOXES = 500;

const remember = (sandboxId: string, applied: AppliedEgress): void => {
  lastApplied.set(sandboxId, applied);
  if (lastApplied.size <= MAX_TRACKED_SANDBOXES) return;
  const oldest = lastApplied.keys().next();
  if (!oldest.done) lastApplied.delete(oldest.value);
};

/**
 * The allowlist currently in force for a sandbox, or `undefined` when this
 * process has not applied one. Read by the egress hint, which has to name the
 * host a blocked request was aiming at — a refusal arrives as a killed TLS
 * handshake and says nothing about policy.
 */
export const getAppliedEgress = (sandboxId: string): string[] | undefined =>
  lastApplied.get(sandboxId)?.allowOut;

export interface ApplySandboxEgressResult {
  /** `false` when the identical policy was already in force. */
  applied: boolean;
  durationMs: number;
}

/**
 * Send the policy. Throws on failure — the caller decides what a sandbox
 * without its intended policy means (the JWT transport, for one, falls back to
 * writing the credential into the workspace for that turn).
 */
export const applySandboxEgress = async (
  sandbox: Sandbox,
  sandboxId: string,
  policy: SandboxNetworkPolicy,
): Promise<ApplySandboxEgressResult> => {
  const fingerprint = policyFingerprint(policy);
  // A brokered credential rotates every turn while the fingerprint stays the
  // same — it deliberately excludes the JWT — so a policy carrying rules is
  // always re-sent. Only a rule-less policy can be skipped.
  const unchanged =
    policy.rules === undefined &&
    lastApplied.get(sandboxId)?.fingerprint === fingerprint;
  if (unchanged) return { applied: false, durationMs: 0 };

  const startedAt = Date.now();
  await sandbox.updateNetwork({
    allowOut: policy.allowOut,
    denyOut: policy.denyOut,
    // `updateNetwork` CLEARS what it is not given, so every call carries the
    // whole policy. Omitting `rules` is how the credential is revoked.
    ...(policy.rules === undefined ? {} : { rules: policy.rules }),
  });
  remember(sandboxId, { fingerprint, allowOut: policy.allowOut });
  return { applied: true, durationMs: Date.now() - startedAt };
};
