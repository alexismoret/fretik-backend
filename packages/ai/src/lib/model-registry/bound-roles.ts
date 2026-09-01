import { writeBoundRoles } from "@fretik/shared/services/model-registry/seed";
import { ROLE_BINDINGS } from "./role-bindings";

/**
 * Publish `ROLE_BINDINGS` to the live table, so the sync knows which models the
 * fleet depends on.
 *
 * This is the whole of what code still tells the database about models, and it
 * is not a fact about any of them: it is which JOBS point where. A model the
 * fleet runs on is alerted on rather than disabled when it fails policy, because
 * disabling it would take the chatbot down instead of degrading one team's
 * choice — so the sync has to know, and only this file does.
 *
 * It replaces a boot-time seed that wrote a curated registry into the table on
 * every restart. See `writeBoundRoles` for what that cost.
 */
const boundRolesByProfile = (): ReadonlyMap<string, string[]> => {
  const byProfile = new Map<string, string[]>();
  for (const [role, binding] of Object.entries(ROLE_BINDINGS)) {
    const existing = byProfile.get(binding.profileKey) ?? [];
    existing.push(role);
    byProfile.set(binding.profileKey, existing);
  }
  // Sorted so the `is distinct from` guard compares content and not insertion
  // order — otherwise every boot rewrites every row.
  for (const roles of byProfile.values()) roles.sort();
  return byProfile;
};

export const publishBoundRoles = async (): Promise<{
  bound: number;
  cleared: number;
}> => writeBoundRoles(boundRolesByProfile());

/**
 * The profile keys the fleet cannot run without — every model an internal role
 * resolves to. Used at boot to say plainly which of them the database cannot
 * describe yet, rather than letting the first request discover it.
 */
export const boundProfileKeys = (): readonly string[] => [
  ...new Set(Object.values(ROLE_BINDINGS).map((b) => b.profileKey)),
];
