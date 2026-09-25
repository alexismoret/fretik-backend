/**
 * Measure the providers a QUERY embedding could be raced across — the evidence
 * `QUERY_EMBEDDING_ROUTES` (`src/lib/embedding-routes.ts`) is written from.
 *
 *     bun run measure:embedding-routes                          # the model's listed routes
 *     bun run measure:embedding-routes -- --providers nebius,deepinfra,siliconflow
 *     bun run measure:embedding-routes -- --rounds 40
 *
 * For the model in `OPENROUTER_EMBEDDING_MODEL`, under the data policy every
 * production request carries (`EMBEDDING_PROVIDER_POLICY`), it checks the three
 * conditions a route has to meet and then times it:
 *
 * 1. DIMENSION — every vector is `EMBEDDING_DIMENSIONS` long. A provider that
 *    ignores `dimensions` fails here, and would fail every query in production.
 * 2. COMPATIBILITY — the same texts, embedded by each provider, compared by
 *    cosine against the first provider listed. The index was embedded by
 *    whichever provider indexing reached, so a route whose vectors differ
 *    retrieves worse, silently. At or above 0.9999 is arithmetic noise (Nebius
 *    against DeepInfra: 0.99991 to 0.99996); a quantized endpoint lands lower.
 * 3. POLICY — a provider the policy excludes answers with an error, reported as
 *    REFUSED, which is the answer (SiliconFlow's fp8 endpoint: a 404, "no
 *    endpoints found for the request with quantization").
 *
 * Then ROUNDS rounds: each provider alone, and the race across all of them
 * (`firstToAnswer`, the function production uses), in a shuffled order each
 * round so every routing sees the same conditions. Each round prints its line
 * as it lands — an interrupted run still shows what it measured.
 *
 * Measure over a long enough window to catch a slow spell: the 2026-09-24
 * table was 40 rounds, and one provider's tail only showed up after the tenth.
 *
 * Cost: a query embedding is about $0.0000001; 40 rounds of three providers
 * is under a hundredth of a cent. Nothing is written anywhere.
 */
import { z } from "zod";
import {
  EMBEDDING_PROVIDER_POLICY,
  firstToAnswer,
  queryRoutesFor,
} from "../src/lib/embedding-routes";
import { EMBEDDING_DIMENSIONS } from "../src/lib/embeddings";

const KEY = process.env.OPENROUTER_API_KEY ?? "";
const MODEL = process.env.OPENROUTER_EMBEDDING_MODEL ?? "";

const argv = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
const providers = opt("--providers")?.split(",").filter(Boolean) ?? [
  ...queryRoutesFor(MODEL),
];
const ROUNDS = Number.parseInt(opt("--rounds") ?? "20", 10);
if (providers.length === 0) {
  console.error(
    `No routes are listed for ${MODEL}: pass --providers a,b (OpenRouter slugs).`,
  );
  process.exit(1);
}

/** Queries shaped like recall's: a short message, three phrasings. */
const QUERIES = [
  "Fais un point rapide sur le contrat du fournisseur principal",
  "Quelles conditions avons-nous actées pour le renouvellement ?",
  "Prépare le récap hebdomadaire des commandes en retard",
];
/** Longer texts, closer to what the corpus holds, for the cosine check. */
const REFERENCE_TEXTS = [
  "Négociation du contrat d'approvisionnement 2027 : commande minimale de 500 unités par trimestre, remise de 8 % sur le tarif catalogue, livraison toutes les deux semaines.",
  "Invoice from Contoso Office Supplies for 24 ergonomic chairs, total 5,760 EUR excluding VAT, payable within 30 days.",
  "Relances fournisseurs : ton ferme mais courtois, rappeler la référence du contrat et la date de livraison prévue.",
];

interface Answer {
  ms: number;
  provider: string | null;
  vectors: number[][];
}

const EmbeddingsResponse = z.object({
  provider: z.string().optional(),
  data: z.array(z.object({ embedding: z.array(z.number()) })),
});

const embedOn = async (
  slug: string,
  input: string[],
  signal?: AbortSignal,
): Promise<Answer> => {
  const started = performance.now();
  const res = await fetch("https://openrouter.ai/api/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      input,
      dimensions: EMBEDDING_DIMENSIONS,
      provider: {
        ...EMBEDDING_PROVIDER_POLICY,
        only: [slug],
        allow_fallbacks: false,
      },
    }),
    signal: signal ?? AbortSignal.timeout(20_000),
  });
  const body: unknown = await res.json();
  const parsed = EmbeddingsResponse.safeParse(body);
  if (!res.ok || !parsed.success) {
    throw new Error(
      `${slug}: HTTP ${res.status.toString()} ${JSON.stringify(body).slice(0, 160)}`,
    );
  }
  return {
    ms: Math.round(performance.now() - started),
    provider: parsed.data.provider ?? null,
    vectors: parsed.data.data.map((d) => d.embedding),
  };
};

const cosine = (a: number[], b: number[]): number => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return dot / Math.sqrt(na * nb);
};

// ── 1-3: dimension, compatibility, policy ──────────────────────────────────
console.log(
  `${MODEL} · ${EMBEDDING_DIMENSIONS} dims · providers: ${providers.join(", ")}\n`,
);
const reference = new Map<string, number[][] | string>();
for (const slug of providers) {
  try {
    reference.set(slug, (await embedOn(slug, REFERENCE_TEXTS)).vectors);
  } catch (error) {
    reference.set(slug, error instanceof Error ? error.message : String(error));
  }
}
const baseline = reference.get(providers[0] ?? "");
for (const slug of providers) {
  const vectors = reference.get(slug);
  if (typeof vectors === "string" || vectors === undefined) {
    console.log(`  ${slug.padEnd(12)} REFUSED  ${vectors ?? ""}`);
    continue;
  }
  const dims = vectors.every((v) => v.length === EMBEDDING_DIMENSIONS);
  const minCos =
    Array.isArray(baseline) && slug !== providers[0]
      ? Math.min(...vectors.map((v, i) => cosine(v, baseline[i] ?? [])))
      : 1;
  const compatible = minCos >= 0.9999;
  console.log(
    `  ${slug.padEnd(12)} dims ${dims ? "ok" : "WRONG"}  cosine vs ${providers[0] ?? "?"} ${minCos.toFixed(6)}  ${dims && compatible ? "eligible" : "NOT eligible"}`,
  );
}

// ── latency: each provider alone, and the race ─────────────────────────────
const timings = new Map<string, number[]>();
const failures = new Map<string, number>();
const routings = [...providers, "race"];
const record = (routing: string, ms: number | null): void => {
  if (ms === null) failures.set(routing, (failures.get(routing) ?? 0) + 1);
  else timings.set(routing, [...(timings.get(routing) ?? []), ms]);
};

console.log(`\n${ROUNDS.toString()} rounds (ms, "x" = failed):`);
for (let round = 1; round <= ROUNDS; round += 1) {
  const line: string[] = [];
  for (const routing of [...routings].sort(() => Math.random() - 0.5)) {
    const input = QUERIES.map((q) => `${q} (${round.toString()}${routing})`);
    const started = performance.now();
    try {
      if (routing === "race") {
        await firstToAnswer(
          providers.map((slug) => (signal) => embedOn(slug, input, signal)),
          AbortSignal.timeout(20_000),
        );
      } else {
        await embedOn(routing, input);
      }
      const ms = Math.round(performance.now() - started);
      record(routing, ms);
      line.push(`${routing} ${ms.toString()}`);
    } catch {
      record(routing, null);
      line.push(`${routing} x`);
    }
    await Bun.sleep(250);
  }
  console.log(`  ${round.toString().padStart(3)}  ${line.join("  ")}`);
}

const pct = (sorted: number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? NaN;
console.log(
  `\n  ${"routing".padEnd(12)}${"p50".padStart(7)}${"p90".padStart(7)}${"max".padStart(7)}${">2.5s".padStart(7)}${">5s".padStart(5)}${"failed".padStart(8)}`,
);
for (const routing of routings) {
  const ms = [...(timings.get(routing) ?? [])].sort((a, b) => a - b);
  console.log(
    `  ${routing.padEnd(12)}${String(pct(ms, 0.5)).padStart(7)}${String(pct(ms, 0.9)).padStart(7)}${String(ms.at(-1) ?? NaN).padStart(7)}${String(ms.filter((x) => x > 2500).length).padStart(7)}${String(ms.filter((x) => x > 5000).length).padStart(5)}${String(failures.get(routing) ?? 0).padStart(8)}`,
  );
}

// Importing `lib/embeddings` brings the service's Redis and Langfuse clients
// with it, and their open handles keep the process alive once the work is done.
process.exit(0);
