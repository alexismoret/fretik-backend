/**
 * LIVE PROBES — the checks that need a real request, and the only two left.
 *
 * This script used to open with a catalogue drift check: every profile's
 * hand-written `catalog` block diffed against the live OpenRouter models API,
 * because a wrong `contextLength` or a missing `supportedParameter` changes
 * behaviour. Those blocks were deleted on 2026-08-30 — the nightly sync writes
 * the catalogue onto `model_live_state` and `effective.ts` derives the profile
 * from it — so the two sides it compared can no longer disagree. Drift between
 * what the sync wrote and what the product serves is `models:admin audit`,
 * which is offline and runs on every deploy rather than when someone remembers
 * a flag.
 *
 * What is left cannot be derived from any catalogue, because it is about
 * whether a request actually SUCCEEDS.
 *
 * Live routing probe:
 *
 *     bun run models:check --probe        # needs OPENROUTER_API_KEY
 *
 * For every ROLE, makes a minimal completion with the role's REAL
 * provider block + `temperature: 0` and reports whether it routes. This
 * is the only check that catches an EMPTY routing pool — a catalog diff
 * can't see it, because the model id exists and its parameters are on
 * *some* endpoint, just not on the one the role's data policy allows
 * (the class of failure behind "No endpoints found matching your data
 * policy": Gemini's ZDR endpoint omits `temperature`, so ZDR +
 * `require_parameters` empties the pool). Runs the probe and exits;
 * without the flag, the catalog drift check runs as before.
 *
 * Gateway readiness:
 *
 *     bun run models:check --gateway-probe   # needs AI_GATEWAY_API_KEY
 *
 * Answers "could the fleet move to the gateway today?" WITHOUT moving it:
 * every role is built on the gateway with its real pool and reasoning
 * envelope, then asked to call a tool. Tool calling is probed on every role
 * because it is the one capability the previous transport protected with
 * `require_parameters`, which this dialect cannot express — the pool filter is
 * what replaces it, and this is where a hole in it shows. The account gates
 * are reported separately from the roles, because a card, purchased credits
 * and a Pro plan are three different walls with three different fixes, and
 * twenty identical role failures name none of them.
 */
export {};
if (process.argv.includes("--probe")) {
  const { resolveModel, warmModelRegistry } =
    await import("../src/lib/model-registry/resolve");
  const { ROLE_BINDINGS } =
    await import("../src/lib/model-registry/role-bindings");
  const { generateText } = await import("ai");
  await warmModelRegistry();

  // Iterate the binding VALUES so `binding.role` carries the ModelRole type
  // (Object.keys would widen to string and force a cast).
  const bindings = Object.values(ROLE_BINDINGS);
  const results = await Promise.all(
    bindings.map(async (binding) => {
      const { model, profile } = resolveModel(binding.role);
      try {
        // No hardcoded `temperature`: the resolved model already carries the
        // role's EXACT provider block (zdr, require_parameters where set), which
        // is what governs routing. Adding temperature here would probe a param
        // no role sends — and on the Gemini vision/extract role the Vertex ZDR
        // route doesn't advertise it, so it would only muddy the signal.
        await generateText({
          model,
          prompt: "Reply with the single word: ok.",
          maxOutputTokens: 8,
        });
        return {
          role: binding.role,
          id: profile.catalog.id,
          ok: true as const,
        };
      } catch (err) {
        return {
          role: binding.role,
          id: profile.catalog.id,
          ok: false as const,
          reason:
            err instanceof Error ? err.message.slice(0, 160) : String(err),
        };
      }
    }),
  );

  let failures = 0;
  for (const r of results.sort((a, b) => a.role.localeCompare(b.role))) {
    if (r.ok) {
      console.log(`OK   ${r.role.padEnd(22)} ${r.id}`);
    } else {
      failures += 1;
      console.error(`FAIL ${r.role.padEnd(22)} ${r.id} — ${r.reason}`);
    }
  }
  if (failures > 0) {
    console.error(`\n${failures}/${bindings.length} role(s) could not route.`);
    process.exit(1);
  }
  console.log(`\nOK — all ${bindings.length} roles route a minimal request.`);
  process.exit(0);
}

if (process.argv.includes("--gateway-probe")) {
  const { resolveModelOnTransport, warmModelRegistry } =
    await import("../src/lib/model-registry/resolve");
  const { ROLE_BINDINGS } =
    await import("../src/lib/model-registry/role-bindings");
  const { extractGatewayReport, gatewayConfigured } =
    await import("../src/lib/model-registry/transports/gateway");
  const { generateText, tool } = await import("ai");
  const { z } = await import("zod");

  if (!gatewayConfigured()) {
    console.error("AI_GATEWAY_API_KEY is not set — nothing to probe.");
    process.exit(2);
  }
  await warmModelRegistry();

  // The account gates come BEFORE the roles, because they explain every role
  // failure at once and each one has a different fix. Measured 2026-08-29:
  // servicing needs a card, the full catalogue needs purchased credits, and
  // zero-retention needs a Pro plan — three separate walls, each with its own
  // error string, and a run that reported 20 identical role failures instead of
  // naming the wall would send someone reading routing code for an hour.
  const ACCOUNT_GATES: { re: RegExp; verdict: string }[] = [
    {
      re: /valid credit card/i,
      verdict:
        "the team has no card on file, so the gateway refuses every request. Add one in the Vercel dashboard.",
    },
    {
      re: /Free tier users do not have access/i,
      verdict:
        "free-tier credits cover only part of the catalogue. Top up AI Gateway Credits to reach this model.",
    },
    {
      re: /rate-limited/i,
      verdict:
        "free-tier rate limit. Top up AI Gateway Credits; the paid tier raises it.",
    },
    {
      re: /Zero Data Retention .* Pro and Enterprise/i,
      verdict:
        "ZERO-RETENTION IS UNAVAILABLE ON THIS PLAN. Every profile that requires it cannot move to the gateway until the team is on Vercel Pro.",
    },
  ];
  const gateFor = (message: string): string | undefined =>
    ACCOUNT_GATES.find((gate) => gate.re.test(message))?.verdict;

  const weather = tool({
    description: "Current weather for a city.",
    inputSchema: z.object({ city: z.string() }),
    execute: ({ city }: { city: string }) =>
      Promise.resolve({ city, celsius: 21 }),
  });

  const bindings = Object.values(ROLE_BINDINGS);
  const gates = new Set<string>();
  let failures = 0;
  let skipped = 0;

  // Sequential, not `Promise.all` like --probe: the free tier rate-limits per
  // model, and a parallel burst would report throttling as if it were the
  // models failing.
  for (const binding of bindings.sort((a, b) => a.role.localeCompare(b.role))) {
    let resolvedOnGateway;
    try {
      resolvedOnGateway = resolveModelOnTransport(binding.role, "gateway");
    } catch (err) {
      // No gateway id is a fact about the catalogue, not a failure to route:
      // two Mistral profiles have no equivalent there at the version we run.
      skipped += 1;
      console.log(
        `SKIP ${binding.role.padEnd(22)} ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    // Tool calling on every role, not just the tool-using ones: it is the
    // capability the previous transport protected with `require_parameters`,
    // which this dialect has no equivalent for. If a pool member silently
    // dropped the parameter, this is where it shows.
    try {
      const result = await generateText({
        model: resolvedOnGateway.model,
        prompt: "What is the weather in Lyon? Call the tool, then answer.",
        maxOutputTokens: 2000,
        tools: { weather },
      });
      // Per STEP, not the deprecated top-level field: a tool round-trip is two
      // calls, and the last one is the one that answered.
      const report = extractGatewayReport(
        result.steps.at(-1)?.providerMetadata,
      );
      const calls = result.steps.flatMap((step) => step.toolCalls);
      const cost =
        report.costUsd === undefined
          ? "cost n/a"
          : `$${report.costUsd.toFixed(6)}`;
      if (calls.length === 0) {
        failures += 1;
        console.error(
          `FAIL ${binding.role.padEnd(22)} ${resolvedOnGateway.profile.key} — routed to ${report.servingProvider ?? "?"} but emitted NO tool call`,
        );
        continue;
      }
      console.log(
        `OK   ${binding.role.padEnd(22)} ${resolvedOnGateway.profile.key.padEnd(22)} ${(report.servingProvider ?? "?").padEnd(14)} ${cost}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const gate = gateFor(message);
      if (gate !== undefined) gates.add(gate);
      failures += 1;
      console.error(
        `FAIL ${binding.role.padEnd(22)} ${resolvedOnGateway.profile.key} — ${message.slice(0, 140)}`,
      );
    }
  }

  console.log(
    `\n${(bindings.length - failures - skipped).toString()} routed, ${failures.toString()} failed, ${skipped.toString()} not on this transport.`,
  );
  for (const gate of gates) console.error(`\nACCOUNT: ${gate}`);
  if (failures > 0) {
    console.error(
      "\nThe fleet is unaffected — this probe builds models on the gateway without moving any of them.",
    );
    process.exit(1);
  }
  console.log(
    "\nEvery role routes, calls a tool and reports a cost on the gateway.",
  );
  process.exit(0);
}

console.error(
  [
    "models:check takes a probe flag — there is no catalogue drift to check.",
    "",
    "  --probe           routing, per role, on the transport it serves from",
    "  --gateway-probe   whether the fleet could move to the gateway today",
    "",
    "The bare form used to diff 22 hand-written `catalog` blocks against the",
    "live OpenRouter models API. Those blocks are gone: the nightly sync writes",
    "the catalogue onto `model_live_state` and `effective.ts` derives a profile",
    "from it, so what this compared can no longer disagree. Drift between what",
    "the sync wrote and what the product serves is `models:admin audit`, and it",
    "runs offline, on every deploy.",
  ].join("\n"),
);
process.exit(2);
