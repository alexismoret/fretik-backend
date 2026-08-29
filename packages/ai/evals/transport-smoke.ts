/**
 * Transport smoke — the small, cheap check that the model engine is wired to
 * reality on the transport the fleet is ACTUALLY on.
 *
 *     bun run evals:transport-smoke                 # the live transport
 *     bun run evals:transport-smoke -- --transport gateway
 *
 * This is deliberately NOT part of the curated eval suite, and it is not a
 * quality measurement. The suite grades answers; this grades PLUMBING, and the
 * two fail for unrelated reasons. Everything here is a claim the engine makes
 * that only a live call can confirm:
 *
 *   1. a role routes, calls a tool, and comes back with a cost and the name of
 *      the upstream that served it — the two fields the breaker and the cost
 *      ledger are built on, and both are transport-specific parsing;
 *   2. a quarantine written to the database changes what leaves the process on
 *      the NEXT call, with no restart and no deploy — the single claim the whole
 *      engine exists to make;
 *   3. the context the compaction threshold budgets against is the one the pool
 *      can actually serve, not the catalogue's headline number.
 *
 * Roles are sampled rather than exhausted: `models:check --gateway-probe` walks
 * all twenty, and paying for twenty tool round-trips to learn the same thing is
 * how a check stops being run.
 */
import type { TransportId } from "@fretik/shared/model-registry/types";
import {
  getLiveRegistry,
  getLiveStateSync,
  readLiveStateRow,
} from "@fretik/shared/services/model-registry/live";
import { generateText, tool } from "ai";
import { z } from "zod";
import {
  getProfileForRole,
  resolveModel,
  resolveModelOnTransport,
  warmModelRegistry,
} from "../src/lib/model-registry/resolve";
import { extractGatewayReport } from "../src/lib/model-registry/transports/gateway";
import { extractOpenRouterReport } from "../src/lib/model-registry/transports/openrouter";
import type { ModelRole } from "../src/lib/model-registry/types";

/**
 * The service warms the registry at boot and subscribes to invalidations
 * there. A script that skipped it would read an empty in-process cache and
 * report a propagation failure that only its own shortcut caused.
 */
await warmModelRegistry();

const reportFor = (transport: TransportId, metadata: unknown) =>
  transport === "gateway"
    ? extractGatewayReport(metadata)
    : extractOpenRouterReport(metadata);

const argTransport = ((): TransportId | undefined => {
  const index = process.argv.indexOf("--transport");
  const value = index === -1 ? undefined : process.argv[index + 1];
  return value === "gateway" || value === "openrouter" ? value : undefined;
})();

/**
 * One per settings shape, because the envelope is what differs: a chat role
 * carries the full provider block, a bare role carries none, and a reasoning
 * role carries a budget the transport has to render.
 */
const SAMPLED_ROLES: ModelRole[] = [
  "chat",
  "cheap-tasks",
  "vision",
  "transform",
];

const weather = tool({
  description: "Current weather for a city.",
  inputSchema: z.object({ city: z.string() }),
  execute: ({ city }: { city: string }) =>
    Promise.resolve({ city, celsius: 21 }),
});

let failures = 0;
const fail = (what: string, why: string): void => {
  failures += 1;
  console.error(`FAIL ${what} — ${why}`);
};

console.log(
  `transport: ${argTransport ?? "as the live registry decides, per model"}\n`,
);

// --- 1. a role routes, calls a tool, and reports who served it -------------
for (const role of SAMPLED_ROLES) {
  const resolved =
    argTransport === undefined
      ? resolveModel(role)
      : resolveModelOnTransport(role, argTransport);
  try {
    const result = await generateText({
      model: resolved.model,
      prompt: "What is the weather in Lyon? Call the tool, then answer.",
      maxOutputTokens: 2000,
      tools: { weather },
    });
    const calls = result.steps.flatMap((step) => step.toolCalls);
    const report = reportFor(
      resolved.transport,
      result.steps.at(-1)?.providerMetadata,
    );
    if (calls.length === 0) {
      fail(`${role} tool round-trip`, "the model emitted no tool call");
      continue;
    }
    // A missing serving provider is not cosmetic: it is the key a quarantine is
    // filed under, so an incident on this transport would be unattributable.
    if (report.servingProvider === undefined) {
      fail(
        `${role} attribution`,
        `routed and called a tool, but the response names no serving upstream — an incident here could not be filed against anyone`,
      );
      continue;
    }
    console.log(
      `OK   ${role.padEnd(14)} ${resolved.transport.padEnd(11)} ${report.servingProvider.padEnd(14)} ${
        report.costUsd === undefined
          ? "cost n/a"
          : `$${report.costUsd.toFixed(6)}`
      }`,
    );
  } catch (err) {
    fail(
      `${role} on ${resolved.transport}`,
      err instanceof Error ? err.message.slice(0, 180) : String(err),
    );
  }
}

// --- 2. a database write changes the wire on the next call -----------------
// Exercised through the adapter rather than by making a paid call: what is
// being tested is that live state reaches the request, and the provider block
// is where that becomes observable.
{
  const { quarantineProvider, releaseProvider } =
    await import("@fretik/shared/services/model-registry/breaker");
  const { invalidateLiveRegistry } =
    await import("@fretik/shared/services/model-registry/live");
  const profileKey = getProfileForRole("chat").key;
  const before = await readLiveStateRow(profileKey);
  const transport = before?.transport ?? "openrouter";
  const victim = before?.endpointStats[0]?.provider;
  if (victim === undefined) {
    fail(
      "live-state propagation",
      `${profileKey} has no endpoint on record, so there is nothing to quarantine — run the model sync first`,
    );
  } else {
    // Start from a known-clean state. Without this the check passes for the
    // wrong reason: a quarantine left behind by an interrupted earlier run
    // makes the next `quarantineProvider` a no-op, which the old code read as
    // "the ladder protected the pool" and printed OK — a green line for a
    // claim it never tested.
    await releaseProvider({
      modelKey: profileKey,
      provider: victim,
      transport,
      reason: "transport smoke test — clearing prior state",
    });
    const applied = await quarantineProvider({
      modelKey: profileKey,
      provider: victim,
      transport,
      kind: "upstream-cut",
      reason: "transport smoke test",
      incidentIds: [],
    });
    await invalidateLiveRegistry();

    // Two separate promises, because they fail for different reasons and only
    // one of them is a catastrophe.
    //
    // NO HOLE is the invariant: an invalidation must never make the synchronous
    // accessor answer `undefined`, because `undefined` legitimately means "no
    // live row, use code defaults" — so a hole does not degrade routing, it
    // silently reverts it, quarantines included. This must hold on the very
    // next instruction.
    if (getLiveStateSync(profileKey) === undefined) {
      fail(
        "live-state hole",
        `${profileKey} vanished from the in-process registry the instant live state changed — every model would fall back to code defaults, dropping the quarantine that was just written`,
      );
    } else {
      console.log(`OK   ${profileKey} still resolvable during invalidation`);
    }

    // CONVERGENCE is the weaker, bounded promise: within one reload every
    // replica sees the write. The reload is started by the invalidation, so
    // awaiting the registry is what any caller a few milliseconds later gets.
    await getLiveRegistry();
    const held =
      getLiveStateSync(profileKey)?.quarantinedProviders.some(
        (q) => q.provider === victim,
      ) ?? false;
    if (!applied) {
      // From a clean start the only remaining refusal is the pool guard, and a
      // one-host pool is a real configuration — but it leaves propagation
      // untested, so it is reported as a SKIP rather than a pass.
      console.log(
        `SKIP quarantine of ${victim} refused — the ladder protected the pool, so propagation was not exercised`,
      );
    } else if (!held) {
      fail(
        "live-state propagation",
        `quarantined ${victim} on ${profileKey}, but a reloaded registry still does not see it — a 3 a.m. decision would not reach a running replica`,
      );
    } else {
      console.log(`OK   quarantine of ${victim} visible without a restart`);
    }
    await releaseProvider({
      modelKey: profileKey,
      provider: victim,
      transport,
      reason: "transport smoke test cleanup",
    });
    // Awaited for the same reason as above: the release converges within one
    // reload, and reading synchronously right after would be timing the
    // background fetch rather than testing the release.
    await invalidateLiveRegistry();
    await getLiveRegistry();
    const after = getLiveStateSync(profileKey);
    if (after?.quarantinedProviders.some((q) => q.provider === victim) === true)
      fail(
        "live-state release",
        `${victim} is still quarantined after release`,
      );
  }
}

// --- 3. the context we budget against is one the pool can serve ------------
for (const role of SAMPLED_ROLES) {
  const profile = getProfileForRole(role);
  // Read the row, not the in-process cache: the quarantine round-trip above
  // deliberately invalidates that cache, and a `continue` on the empty result
  // would let this whole section pass by doing nothing at all.
  const live = await readLiveStateRow(profile.key);
  if (live === undefined) {
    fail(
      `${profile.key} context`,
      "no live row — the model sync has never written this profile",
    );
    continue;
  }
  const smallest = Math.min(
    ...live.endpointStats.map((endpoint) => endpoint.contextLength),
  );
  if (!Number.isFinite(smallest)) {
    fail(
      `${profile.key} context`,
      "no endpoint reports a context length, so the compaction budget rests on nothing measured",
    );
    continue;
  }
  if (live.effectiveContextLength > smallest) {
    fail(
      `${profile.key} context`,
      `budgeting ${live.effectiveContextLength.toString()} tokens against a pool whose smallest endpoint holds ${smallest.toString()} — a turn landing there overflows`,
    );
  } else {
    console.log(
      `OK   ${profile.key.padEnd(22)} budgets ${live.effectiveContextLength.toString()} within the pool's ${smallest.toString()}`,
    );
  }
}

if (failures > 0) {
  console.error(`\n${failures.toString()} smoke check(s) failed.`);
  process.exit(1);
}
console.log("\nTransport smoke passed.");
process.exit(0);
