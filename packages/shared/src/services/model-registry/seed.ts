import { sql } from "drizzle-orm";
import db from "../../db";
import { modelLiveState } from "../../db/schema/model-registry";
import { invalidateLiveRegistry } from "./live";

/**
 * Writing the one thing about a model that only CODE knows: which internal roles
 * depend on it.
 *
 * This used to be a whole curated registry being poured into the table at every
 * boot — model ids, prices, contexts, pools, AA slugs, all of it hand-written in
 * TypeScript and re-asserted over rows the nightly sync had already measured
 * better. That was the double source of truth the model engine exists to remove,
 * and it was not merely redundant: `model_ids` was overwritten wholesale on
 * every restart, so a spelling the sync had DISCOVERED on its own (`glm-5.2`
 * picked up its Scaleway id with nobody typing it) was erased at each deploy and
 * only came back the next night.
 *
 * What is left is genuinely irreducible. `ROLE_BINDINGS` is a set of decisions —
 * which model does the chatting, which one judges recall on a turn's hot path —
 * and no catalogue publishes it. The sync needs it because a model the fleet
 * depends on is ALERTED on rather than disabled: turning it off would take the
 * chatbot down instead of degrading one team's choice.
 *
 * Everything else about a model is now read from the row and synthesised by
 * `@fretik/ai` `model-registry/effective.ts`. A row is created by the sync or by
 * `models:admin add`, never here — which also means a database with no rows
 * serves no models until a sync has run, and that is the honest state rather
 * than a hidden one: a row nobody has measured has no price, no context and no
 * ladder, so serving from it would be inventing all three.
 */

/** Roles bound to each profile key, from `ROLE_BINDINGS`. */
export type BoundRolesByProfile = ReadonlyMap<string, readonly string[]>;

export const writeBoundRoles = async (
  rolesByProfile: BoundRolesByProfile,
): Promise<{ bound: number; cleared: number }> => {
  const entries = [...rolesByProfile.entries()].filter(
    ([, roles]) => roles.length > 0,
  );
  const keys = entries.map(([key]) => key);

  // Rows that used to serve a role and no longer do. Without this a rebinding
  // leaves the old model looking load-bearing, and the sync then refuses to
  // disable it for a policy failure it should have been disabled for.
  const cleared = await db
    .update(modelLiveState)
    .set({ boundRoles: [] })
    .where(
      keys.length === 0
        ? sql`cardinality(${modelLiveState.boundRoles}) > 0`
        : sql`cardinality(${modelLiveState.boundRoles}) > 0 and ${modelLiveState.profileKey} not in ${keys}`,
    )
    .returning({ key: modelLiveState.profileKey });

  // One set-based statement rather than a loop: the role list differs per key,
  // so the pairs travel as a VALUES join. Both halves of each pair are BOUND
  // PARAMETERS — the role names come from a compile-time union today, and
  // building the statement by string concatenation would be a habit that
  // survives longer than that guarantee.
  const bound =
    entries.length === 0
      ? []
      : await db
          .update(modelLiveState)
          .set({ boundRoles: sql`v.roles` })
          .from(
            sql`(values ${sql.join(
              entries.map(
                ([key, roles]) =>
                  // `array[$1, $2, …]` rather than binding the array itself:
                  // the driver expands a JS array into one parameter PER
                  // ELEMENT, so `${roles}::text[]` casts a record and Postgres
                  // refuses it ("cannot cast type record to text[]").
                  sql`(${key}, array[${sql.join(
                    roles.map((role) => sql`${role}`),
                    sql`, `,
                  )}]::text[])`,
              ),
              sql`, `,
            )}) as v(profile_key, roles)`,
          )
          .where(
            sql`${modelLiveState.profileKey} = v.profile_key and ${modelLiveState.boundRoles} is distinct from v.roles`,
          )
          .returning({ key: modelLiveState.profileKey });

  if (bound.length > 0 || cleared.length > 0) await invalidateLiveRegistry();
  return { bound: bound.length, cleared: cleared.length };
};
