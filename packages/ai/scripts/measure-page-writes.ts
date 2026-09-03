/**
 * What page writes actually cost, read back from Langfuse.
 *
 * The claim this whole redesign rests on — "a fix touching 7% of a page
 * re-emitted 100% of it" — was measured once, by hand, from two conversations.
 * This is the same measurement as a command, so the next argument about the
 * page builder is settled with a number instead of an anecdote.
 *
 *   bun run pages:measure-writes -- --hours 6
 *   bun run pages:measure-writes -- --hours 48 --team <teamId>
 *
 * Reads the `page-write <mode>` events emitted by `services/page-project/
 * write-stats.ts`. Read-only, and outside the tsconfig include like every
 * other script here.
 */

import { z } from "zod";

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var: ${name}`);
  return value;
};

const observationSchema = z.object({
  id: z.string(),
  name: z.string(),
  traceId: z.string().nullish(),
  startTime: z.string(),
  metadata: z
    .object({
      mode: z.string().nullish(),
      path: z.string().nullish(),
      linesChanged: z.number().nullish(),
      linesTotal: z.number().nullish(),
      charsEmitted: z.number().nullish(),
      rewriteRatio: z.number().nullish(),
      lintDelta: z.array(z.string()).nullish(),
    })
    .nullish(),
});

const responseSchema = z.object({
  data: z.array(observationSchema),
  meta: z.object({ page: z.number(), totalPages: z.number() }),
});

type Observation = z.infer<typeof observationSchema>;

const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const fetchPage = async (
  page: number,
  since: Date,
): Promise<z.infer<typeof responseSchema>> => {
  const baseUrl = requireEnv("LANGFUSE_BASE_URL").replace(/\/+$/, "");
  const auth = btoa(
    `${requireEnv("LANGFUSE_PUBLIC_KEY")}:${requireEnv("LANGFUSE_SECRET_KEY")}`,
  );
  const params = new URLSearchParams({
    type: "EVENT",
    fromStartTime: since.toISOString(),
    limit: "100",
    page: page.toString(),
  });
  const res = await fetch(
    `${baseUrl}/api/public/v2/observations?${params.toString()}`,
    { headers: { Authorization: `Basic ${auth}`, Accept: "application/json" } },
  );
  if (!res.ok) {
    throw new Error(
      `GET observations → HTTP ${res.status.toString()}: ${(await res.text().catch(() => "")).slice(0, 300)}`,
    );
  }
  return responseSchema.parse(await res.json());
};

const percentile = (values: number[], p: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.floor((p / 100) * sorted.length),
  );
  return sorted[index] ?? 0;
};

const main = async (): Promise<void> => {
  const hours = Number(arg("hours") ?? "24");
  const since = new Date(Date.now() - hours * 3_600_000);

  const events: Observation[] = [];
  let page = 1;
  let totalPages = 1;
  while (page <= totalPages && page <= 50) {
    // eslint-disable-next-line no-await-in-loop -- pagination is sequential
    const body = await fetchPage(page, since);
    totalPages = body.meta.totalPages;
    for (const observation of body.data) {
      if (observation.name.startsWith("page-write ")) events.push(observation);
    }
    page += 1;
  }

  const writes = events.filter((e) => e.metadata?.mode === "write");
  const edits = events.filter((e) => e.metadata?.mode === "edit");
  const builds = events.filter((e) => e.metadata?.mode === "build");

  if (events.length === 0) {
    console.log(
      `No page writes in the last ${hours.toString()}h. (Builds emit these only when a trace is active.)`,
    );
    return;
  }

  console.log(`\npage writes — last ${hours.toString()}h\n`);
  console.log(
    "  mode    calls   median chars   median ratio   p90 ratio   lint findings",
  );
  for (const [mode, group] of [
    ["write", writes],
    ["edit", edits],
  ] as const) {
    const chars = group.map((e) => e.metadata?.charsEmitted ?? 0);
    const ratios = group
      .map((e) => e.metadata?.rewriteRatio ?? 0)
      .filter((ratio) => ratio > 0);
    const lints = group.reduce(
      (total, e) => total + (e.metadata?.lintDelta?.length ?? 0),
      0,
    );
    console.log(
      `  ${mode.padEnd(8)}${group.length.toString().padEnd(8)}${percentile(chars, 50).toString().padEnd(15)}${percentile(ratios, 50).toFixed(2).padEnd(15)}${percentile(ratios, 90).toFixed(2).padEnd(12)}${lints.toString()}`,
    );
  }

  const traces = new Set(events.map((e) => e.traceId ?? "?"));
  console.log(
    `\n  ${builds.length.toString()} builds over ${traces.size.toString()} runs — ${(
      (writes.length + edits.length) /
      Math.max(traces.size, 1)
    ).toFixed(
      1,
    )} writes per run, ${((edits.length / Math.max(writes.length + edits.length, 1)) * 100).toFixed(0)}% of them edits.`,
  );

  // The one number the redesign is answerable to. The measured whole-file
  // rewrites ran 6-14; a fix that stays surgical sits near 1.
  const fixRatios = edits
    .map((e) => e.metadata?.rewriteRatio ?? 0)
    .filter((ratio) => ratio > 0);
  if (fixRatios.length > 0) {
    console.log(
      `  median rewrite ratio on fixes: ${percentile(fixRatios, 50).toFixed(2)} (target < 3; whole-file rewrites measured 6-14)\n`,
    );
  }
};

await main();
