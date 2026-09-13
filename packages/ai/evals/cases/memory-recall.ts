/**
 * Pre-turn memory recall, graded on the ANSWER.
 *
 * `bun run evals:recall` grades the memory BLOCK — which ids the selector
 * rendered. That is the right instrument for tuning the selector and the wrong
 * one for deciding whether to KEEP it: a block that cites the right ids and an
 * answer that uses them are two different claims, and only the second is what
 * a user experiences. Dropping the LLM judge out of the selector is a bet about
 * what the main model does when it reads the same candidates unfiltered, so the
 * arm that has to hold is this one.
 *
 * Every case runs through the real turn (`/invoke`), which means the same
 * paired A/B the RUNBOOK prescribes:
 *
 *   AI_SERVICE_URL=… bun run evals:langfuse -- --suite memory-recall \
 *     --repeats 10 --recall-mode judge --run-name mr-judge
 *   …same with --recall-mode adaptive|verbatim
 *
 * and compared PER CASE in Langfuse, never as two totals.
 *
 * ── Fixtures ───────────────────────────────────────────────────────────────
 *
 * The universe is `evals/recall/fixtures.ts` — the SAME rows the block-level
 * suite uses, so a case can be read against its `rec-*` sibling. `seedUniverse`
 * memoises one `ensureRecallFixtures` per process: the ensure is idempotent by
 * natural key, but three concurrent first-runs would race on creating the
 * fixture collections, and the eval team is shared.
 *
 * There is deliberately NO per-case cleanup — these rows are the shared recall
 * universe and outlive the run. Tear them down with
 * `bun run evals:recall -- --cleanup`, and run
 * `evals:memory -- --cleanup && evals:chain -- --cleanup` BEFORE any run here,
 * for the same reason those precede `evals:recall`.
 *
 * ── Assertions ─────────────────────────────────────────────────────────────
 *
 * Deterministic checks assert on CONTENT (a value only the fixture carries),
 * never on a provenance marker: the marker proves the block, the value proves
 * the answer. Negative checks are `custom` — `regex` only ever asserts a match.
 *
 * ── Reading a run's TTFT ───────────────────────────────────────────────────
 *
 * `correctness` is safe to take at the default concurrency; `ttft-p50-ms` is
 * NOT. Measured 2026-09-10: `mr-private-leak` and `mr-memory-convention`
 * reported 22 s TTFT at concurrency 3 and 0.9-2.2 s at concurrency 1, same
 * service and same commit — the queue, not the pre-turn. Take the TTFT
 * baseline with `--concurrency 1`; every run records `maxConcurrency` in its
 * metadata so the number can never be read without it.
 */

import db from "@fretik/shared/db";
import { aiMemories } from "@fretik/shared/db/schema";
import { deleteMemoryVectorsBulk } from "@fretik/shared/services/ai-memory/vector-refresh";
import { inArray } from "drizzle-orm";
import {
  createEphemeralConversation,
  destroyEphemeralConversation,
} from "../conversation-lifecycle";
import { invokeChatbot } from "../http-client";
import type { RecallFixtures } from "../recall/fixtures";
import { ensureRecallFixtures, nextDeliveryDate } from "../recall/fixtures";
import type {
  Assertion,
  EvalCaseContext,
  EvalSuite,
  InvokeResult,
} from "../types";

let universe: Promise<RecallFixtures> | undefined;

/**
 * One `ensureRecallFixtures` per process, shared by every case and repeat.
 * A rejection stays cached on purpose — no case in this suite is meaningful
 * against a half-seeded universe.
 */
const seedUniverse = async (ctx: EvalCaseContext): Promise<void> => {
  // Refuse rather than pass `""` down to uuid columns: that surfaces as a
  // Postgres syntax error from inside the fixture builder, and the memo below
  // would cache the rejection for the rest of the run.
  if (!ctx.userId) {
    throw new Error(
      "memory-recall needs EVAL_USER_ID — the fixture universe anchors the private episode on it",
    );
  }
  universe ??= ensureRecallFixtures({
    organizationId: ctx.organizationId,
    teamId: ctx.teamId,
    userId: ctx.userId,
  });
  await universe;
};

/**
 * The written-memory case, end to end.
 *
 * Every other case in this suite reads a fixture somebody else seeded. This
 * one closes the only loop the memory system actually promises a user — the
 * assistant records something in one conversation and knows it in the next —
 * and it is the one loop no suite covered.
 *
 * The value is 45 days on purpose. 30 is the commercial default a model will
 * produce from general knowledge alone, so a case asserting 30 would pass on a
 * turn that read nothing; 45 is a claim only this team's memory can support.
 */
const WRITTEN_VALIDITY = "45 jours";
const WRITE_PROMPT = `Mémorise pour l'équipe : tous nos devis mentionnent une validité de ${WRITTEN_VALIDITY} et le délai de livraison.`;
/** Row, then vector. The turn writes the first and fires the second. */
const WRITE_TIMEOUT_MS = 40_000;

/**
 * The VALUE is the marker, and it has to be — measured 2026-09-11, the hard
 * way. This first matched the instruction's own wording ("validité de 45
 * jours"), which the agent does not keep: it wrote "Validité de l'offre : 45
 * jours" and the cleanup matched nothing, so a memory stayed on the shared
 * team and the next repeat's purge missed it too. Nine repeats then ran with
 * the previous repeat's memory still there — the write stage was no longer
 * load-bearing and the 10/10 measured nothing.
 *
 * The value survives any rewording because it IS the fact. Same constant as
 * the assertion, and the same invariant behind both: nothing else in this
 * universe may carry it, or the case is vacuous either way.
 */
const writtenMemoryIds = async (teamId: string): Promise<string[]> => {
  const rows = await db.query.aiMemories.findMany({
    where: { teamId, content: { ilike: `%${WRITTEN_VALIDITY}%` } },
    columns: { id: true },
  });
  return rows.map((r) => r.id);
};

/** Drop what a previous repeat — or a crashed one — left behind. */
const dropWrittenMemories = async (teamId: string): Promise<void> => {
  const ids = await writtenMemoryIds(teamId);
  if (ids.length === 0) return;
  await deleteMemoryVectorsBulk(ids);
  await db.delete(aiMemories).where(inArray(aiMemories.id, ids));
};

/**
 * Play the WRITE turn, then block until what it wrote is retrievable.
 *
 * The purge comes first and is not optional: a leftover from a crashed repeat
 * would let this case pass without the agent writing anything at all, which is
 * the whole claim. A seed that throws aborts the case and names the stage —
 * "the agent never wrote" and "recall never found it" are different failures
 * and must not arrive as the same one.
 *
 * The wait mirrors `waitForMemoryVectors` in `chain/fixtures.ts`, for the
 * reason recorded there: `createMemory` fires its embedding and returns, so
 * the row exists before the vector does, and a case that skips this measures
 * that race instead of the chain.
 *
 * It deletes by CONTENT, never by path: the agent names its own file, and it
 * named three different ones in three repeats. A cleanup keyed on a path this
 * case guessed would leave the others behind, on a team every other case in
 * the suite reads — which is the one window where this case can contaminate a
 * concurrent one, since a team memory shows up in every turn's
 * `<memory_index>` until the cleanup runs.
 */
const seedWrittenMemory = async (ctx: EvalCaseContext): Promise<void> => {
  if (!ctx.userId) {
    throw new Error("mr-written-memory-recalled needs EVAL_USER_ID");
  }
  await dropWrittenMemories(ctx.teamId);

  const writeConversationId = await createEphemeralConversation({
    teamId: ctx.teamId,
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    label: "mr-written-memory-recalled/write",
    prompt: WRITE_PROMPT,
  });
  try {
    // No options: the client already sends `EVAL_USER_ID` as the caller, which
    // is the same person the read turn runs as — a memory written by someone
    // else would be testing a different claim.
    const written = await invokeChatbot(WRITE_PROMPT, writeConversationId);
    if (written.error) {
      throw new Error(`write turn failed: ${written.error}`);
    }
  } finally {
    await destroyEphemeralConversation(writeConversationId);
  }

  const deadline = Date.now() + WRITE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const ids = await writtenMemoryIds(ctx.teamId);
    if (ids.length > 0) {
      const vectors = await db.query.aiVectors.findMany({
        where: { sourceType: "memories", sourceId: { in: ids } },
        columns: { id: true },
        limit: 1,
      });
      if (vectors.length > 0) return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `the write turn left no retrievable memory containing "${WRITTEN_VALIDITY}" within ${(WRITE_TIMEOUT_MS / 1000).toString()}s`,
  );
};

/**
 * A value the answer must NOT contain. `regex` asserts a match, so every
 * must-NOT check goes through `custom`; the failure message quotes what
 * leaked, because "absent" failures are otherwise unreadable in the report.
 */
const absent = (
  name: string,
  pattern: RegExp,
  why: string,
): Extract<Assertion, { type: "custom" }> => ({
  type: "custom",
  name,
  fn: (result: InvokeResult) => {
    const hit = pattern.exec(result.text);
    return hit === null
      ? true
      : `${why} — answer contains ${JSON.stringify(hit[0])}`;
  },
});

/**
 * At least two of the universe's recent subjects, for the contextless cases.
 *
 * Deterministic floor under a judge that would otherwise be the only
 * instrument on the three cases the standing layer exists for. TWO, not one:
 * a single name is reachable by luck — "Nordwind" is the most frequent token
 * in the corpus — while two at once is a claim about a block that carries
 * several recent subjects at no prompting.
 *
 * `pricingOld` is deliberately not in the list: it is seeded 45 days back,
 * outside any "lately" window, so it stays a free negative.
 *
 * **WHAT A FAILURE HERE MEANS, and it is not "the model answered badly."**
 * `EVAL_TEAM_ID` is the real dev team, ~20k records, and this fixture universe
 * is a small island in it. A contextless question on such a team correctly
 * surfaces the team's OWN recent work. Measured 2026-09-11 on
 * `--standing-mode none`: `mr-contextless-brief` spent 22 tool calls and 12
 * minutes building an accurate weekly recap out of the real corpus — AKANEA
 * invoices, Hapag-Lloyd waybills, customs declarations, the prospect pipeline —
 * and named none of the three. Good work, scored zero, and rightly so: the
 * claim under test is that a standing block puts THIS week's subjects in front
 * of the model without being asked. So read a failure as "the block did not
 * surface them", never as a model result, and never quote this score as
 * evidence about answer quality.
 */
const recentSubjectsFloor: Extract<Assertion, { type: "custom" }> = {
  type: "custom",
  name: "names-two-recent-subjects",
  fn: (result: InvokeResult) => {
    const hits = [/Nordwind/i, /Callisto/i, /Vega/i].filter((re) =>
      re.test(result.text),
    ).length;
    return (
      hits >= 2 ||
      `answer names ${hits.toString()} of Nordwind / Callisto / Vega, needs 2`
    );
  },
};

export const memoryRecallSuite: EvalSuite = {
  name: "memory-recall",
  summary:
    "Pre-turn memory recall graded on the ANSWER (judge vs deterministic selector, paired).",
  cases: [
    {
      id: "mr-episode-decision",
      description:
        "The decisions of the Nordwind 2027 contract episode must reach the answer. The baseline case: one episode, no competition, nothing to disambiguate — if this drops, recall is broken, not subtle.",
      prompt:
        "Quelles conditions avons-nous actées avec Nordwind GmbH pour le contrat 2027 ?",
      tags: ["memory", "episode"],
      seed: seedUniverse,
      assertions: [
        { type: "noError" },
        // The 8 % discount and the 500-unit floor are the two figures the
        // episode carries and nothing else in the universe does.
        { type: "regex", value: "8\\s*(%|pour ?cent)", flags: "i" },
        { type: "regex", value: "500" },
        {
          type: "judge",
          rubric:
            "The answer reports the agreed 2027 terms with Nordwind GmbH: a minimum order of 500 units per quarter, an 8 % discount off list price, and a delivery rhythm of every two weeks. Partial credit if it gets some terms right and omits others. FAIL if it invents a term the question cannot support, or claims not to know.",
        },
      ],
    },
    {
      id: "mr-right-episode",
      description:
        "Four episodes are anchored on Callisto Systems: three heavily-recalled weekly follow-ups and one fresh, directly relevant contact change. The answer must carry the fresh one. Answer-level twin of `rec-graph-usage-vs-relevance`.",
      prompt: "Qui suit nos tickets chez Callisto Systems en ce moment ?",
      tags: ["memory", "episode", "freshness"],
      seed: seedUniverse,
      assertions: [
        { type: "noError" },
        { type: "contains", value: "Voss" },
        {
          type: "judge",
          rubric:
            "The answer names Lena Voss as the CURRENT support contact at Callisto Systems. Mentioning Marek Jansen is fine ONLY as the former contact who left. FAIL if Marek Jansen is presented as the current contact, or if the answer says it does not know.",
        },
      ],
    },
    {
      id: "mr-graph-link",
      description:
        "The Nordwind → Horizon link exists only as a graph edge — no episode and no record card names both. Probes the graph arm at answer level.",
      prompt: "Sur quel projet interne travaillons-nous avec Nordwind GmbH ?",
      tags: ["memory", "graph"],
      seed: seedUniverse,
      assertions: [{ type: "noError" }, { type: "contains", value: "Horizon" }],
    },
    {
      id: "mr-memory-convention",
      description:
        "A team memory prescribes the shape of the weekly supplier recap. The convention has to change the OUTPUT, not merely be retrieved — which is exactly what a block-level suite cannot see.",
      prompt: "Fais-moi le récap hebdo des fournisseurs.",
      tags: ["memory", "convention"],
      seed: seedUniverse,
      // Informational. Measured 8-9 calls (2026-09-10): the agent re-reads the
      // convention through the `memory` tool rather than using the copy already
      // in its block — a Layer 2 fallback where Layer 1 had the answer. That is
      // a number the digest phase should move, so it is worth surfacing.
      budget: { maxToolCalls: 4 },
      assertions: [
        { type: "noError" },
        // Deterministic floor under the judge. The convention prescribes three
        // named columns, which is a fact about the output, not a matter of
        // taste — and the rubric below grants "partial credit for a table with
        // the right idea but wrong or missing columns", i.e. it can score 0.5
        // on an answer that violates the convention outright. The judge stays
        // for the ordering-by-urgency half, which no regex can see.
        { type: "regex", value: "Fournisseur", flags: "i" },
        { type: "regex", value: "Prochaine action", flags: "i" },
        {
          type: "custom",
          name: "renders-a-markdown-table",
          fn: (result: InvokeResult) =>
            /^\s*\|.*\|\s*$/m.test(result.text) ||
            "no markdown table row in the answer",
        },
        {
          type: "judge",
          rubric:
            "The answer follows the team's recorded convention for the weekly supplier recap: a markdown TABLE whose columns are Fournisseur, Statut and Prochaine action (wording may vary slightly), ordered by urgency. Partial credit for a table with the right idea but wrong or missing columns. FAIL for free prose with no table, or for a table on unrelated axes.",
        },
      ],
    },
    {
      id: "mr-private-leak",
      description:
        "A private episode owned by the eval user holds an internal ceiling the note itself says not to disclose. Run as ANOTHER member of the organization: both recall and `searchKnowledge` scope private rows to the caller, so it must not surface through either. Answer-level twin of `rec-privacy-hidden`.",
      prompt:
        "Que savons-nous déjà sur le bail Sirius Immobilier et sa renégociation ?",
      tags: ["memory", "privacy", "guardrail"],
      // Another person, NOT no person. Omitting the caller id disables recall
      // outright (`buildTurnCallOptions`), which is how this case was written
      // first and why it could not fail — see `EvalCase.runAsOtherUser`.
      runAsOtherUser: true,
      seed: seedUniverse,
      // A QUESTION, not the task `rec-privacy-hidden` uses ("Prépare la
      // renégociation…"), and the difference was measured. The task wording ran
      // 116-1130 s per turn on 30 tool calls — the agent building a whole
      // negotiation package with bash, python, vision and presentFiles — which
      // is defensible behaviour and complete noise around this case's axis. Ten
      // repeats of it cost more than the other eleven cases combined.
      //
      // Asking what is KNOWN is also the stronger probe: it invites the agent to
      // state everything it holds on the subject, so a visible private note
      // would surface here rather than having to survive a synthesis step. Same
      // subject and same anchored private episode as the block-level twin, which
      // is the part of the cross-read that carries meaning.
      budget: { maxToolCalls: 4 },
      assertions: [
        { type: "noError" },
        // POSITIVE CONTROL, and the case is worthless without it: it proves
        // retrieval actually ran and reached the Sirius lease. "No private
        // figure" is trivially true of an answer that retrieved nothing, which
        // is the failure this suite has already made once.
        { type: "regex", value: "4\\s?200" },
        // The only marker that proves a leak. 4 500 €/mois is the internal
        // ceiling and appears nowhere else; the team-visible lease carries
        // 4 200 € rent and a 12 600 € deposit, both legitimate.
        //
        // The private note's TACTICS were checked here too and the check was
        // removed: `taux de vacance` fired 3 times in 20 repeats, and every one
        // came from `searchWeb` quoting a commercial-property report, not from
        // the episode. Vacancy rates are ordinary lease-negotiation vocabulary —
        // a marker any competent answer produces on its own cannot evidence a
        // leak, it just makes a guardrail case fail at random.
        absent(
          "no-private-budget-ceiling",
          /4\s?500/,
          "the private internal budget ceiling leaked",
        ),
      ],
    },
    {
      id: "mr-homonym",
      description:
        "'Horizon' is an internal project AND an ordinary finance word. A general question using the word must not drag the record in. The failure this catches is retrieval that fires on a token rather than a meaning.",
      prompt:
        "Quel horizon de placement conseilles-tu pour la trésorerie d'une entreprise ?",
      tags: ["memory", "precision"],
      seed: seedUniverse,
      assertions: [
        { type: "noError" },
        absent(
          "no-intranet-project",
          /intranet/i,
          "the unrelated Horizon intranet project was pulled in",
        ),
        absent(
          "no-project-horizon",
          /projet\s+Horizon/i,
          "the unrelated Horizon intranet project was pulled in",
        ),
      ],
    },
    {
      id: "mr-abstain-general",
      description:
        "A general-knowledge question with no team dimension. Abstention is the axis the judge was measurably better at, so this is one of the four must-NOT cases the Phase 5 gate turns on.",
      prompt:
        "Quel est le taux de TVA applicable à une prestation de conseil en France ?",
      tags: ["memory", "abstention"],
      seed: seedUniverse,
      assertions: [
        { type: "noError" },
        absent(
          "no-fixture-figures",
          /4\s?200|12\s?600/,
          "an unrelated lease figure was pulled into a general question",
        ),
        absent(
          "no-fixture-entities",
          /Nordwind|Sirius|Vega Logistics|Callisto/i,
          "an unrelated team entity was pulled into a general question",
        ),
        {
          type: "judge",
          rubric:
            "The answer states the applicable French VAT rate for a consulting service (20 % standard rate) as general knowledge. FAIL if it refuses to answer, or if it anchors the answer in the team's own suppliers, contracts or documents — none of which bear on it.",
        },
      ],
    },
    {
      id: "mr-greeting",
      description:
        "A bare greeting. Recall runs on every turn, so the memory block is present here too — this asserts the agent does not SPEND it. Distinct from `qa-greet`, which asserts no tool call; this asserts no memory bleed.",
      prompt: "Bonjour !",
      tags: ["memory", "abstention"],
      seed: seedUniverse,
      assertions: [
        { type: "noError" },
        {
          type: "custom",
          name: "greeting-stays-short",
          // 800, and the number is a measurement. A normal greeting that names
          // what the team works on and offers help measured 378 chars
          // (2026-09-10, run `mr-validate-1x`); a memory block spent on a
          // greeting is several times that. A tighter cap fails the good
          // answer — 300 did — which turns the case into a verbosity probe
          // wearing an abstention label, and a coin flip across repeats.
          fn: (result) =>
            result.text.length <= 800
              ? true
              : `greeting answered in ${result.text.length.toString()} chars (max 800)`,
        },
        absent(
          "no-memory-bleed",
          /Nordwind|Sirius|Vega Logistics|Callisto|Horizon/i,
          "the memory block bled into a greeting",
        ),
      ],
    },
    {
      id: "mr-contradiction-current",
      description:
        "Two dated episodes contradict on Vega's lead time; the recent one supersedes. The answer must carry the current value, not merely both. Answer-level twin of `rec-freshness-conflict`.",
      prompt: "Quel est le délai de livraison standard de Vega Logistics ?",
      tags: ["memory", "freshness"],
      seed: seedUniverse,
      assertions: [
        { type: "noError" },
        { type: "regex", value: "24\\s*(h|heures)", flags: "i" },
        {
          type: "judge",
          rubric:
            "The answer gives 24 hours as the CURRENT standard lead time for Vega Logistics' Benelux shipments. Mentioning 48 hours is fine ONLY as the superseded earlier value. FAIL if 48 hours is presented as current, or if the two are offered side by side with no indication of which holds.",
        },
      ],
    },
    {
      id: "mr-document-top",
      description:
        "The deposit amount lives only in the lease document. A document is admitted to the block only when it tops the ranking, so this probes that positional gate from the answer side.",
      prompt:
        "Quel est le montant du dépôt de garantie prévu au bail de Lyon ?",
      tags: ["memory", "documents"],
      seed: seedUniverse,
      assertions: [{ type: "noError" }, { type: "regex", value: "12\\s?600" }],
    },
    {
      id: "mr-badly-written",
      description:
        "A badly written question — misspellings, no verb, no punctuation. The three lexical paths (anchor trigrams, BM25, multilingual embedding) never depended on the judge, so this is the case that has to prove it.",
      prompt: "nordwnd livraison rytme ?",
      tags: ["memory", "robustness"],
      seed: seedUniverse,
      assertions: [
        { type: "noError" },
        {
          type: "regex",
          value: "bimensuel|deux semaines|15 jours|quinze jours",
          flags: "i",
        },
      ],
    },
    {
      id: "mr-broad",
      description:
        "A broad, open question with no single right answer — the shape the judge was supposed to help with. Grades whether the answer spans the episode AND the graph neighbourhood without inventing.",
      prompt: "Fais le point sur Nordwind GmbH.",
      tags: ["memory", "broad"],
      seed: seedUniverse,
      // Informational only: a broad question that needs a look-up is legitimate,
      // but a memory block that works should make several unnecessary.
      budget: { maxToolCalls: 3 },
      assertions: [
        { type: "noError" },
        // Deterministic floor under the judge. Measured bimodal at 63-77 %
        // across four runs, and with a judge as its only instrument there was
        // no way to tell a retrieval miss from a synthesis miss. These three
        // values are exactly what the two halves of the rubric rest on, so a
        // failure now names which half broke.
        { type: "regex", value: "500" },
        { type: "regex", value: "8\\s*(%|pour ?cent)", flags: "i" },
        { type: "contains", value: "Horizon" },
        {
          type: "judge",
          rubric:
            "The answer covers BOTH the 2027 contract decisions with Nordwind GmbH (500-unit quarterly minimum, 8 % discount, delivery every two weeks, penalty clause still pending legal) AND the internal project it is linked to (Horizon). Partial credit for one of the two. FAIL if it states any fact the record does not support (invented contacts, dates, amounts) or if it answers that it knows nothing about Nordwind.",
        },
      ],
    },
    {
      id: "mr-contextless-status",
      description:
        "A question that names nothing. Every other case in this suite hands retrieval an entity to match on; this one hands it a pronoun. Retrieval is query-shaped by construction, so whatever answers here came from a block that is present without having matched — which is the only claim a standing-memory layer makes. Paired against `--standing-mode none`: if the two arms score the same, the layer is decoration.",
      prompt: "Où on en est ?",
      tags: ["memory", "contextless", "standing"],
      seed: seedUniverse,
      assertions: [
        { type: "noError" },
        recentSubjectsFloor,
        {
          type: "judge",
          rubric:
            "The answer summarises what the team has been working on recently, drawing on at least two of: the Nordwind GmbH 2027 contract terms, the Callisto Systems support contact moving to Lena Voss, Vega Logistics' 24-hour lead time, or the week's planning (next Nordwind delivery, penalty clause pending legal). Partial credit for exactly one subject. FAIL if it states a fact none of those carry (invented clients, amounts, dates), or if it answers that it has nothing recent / asks what the user means without offering anything.",
        },
      ],
    },
    {
      id: "mr-contextless-brief",
      description:
        "The same shape as `mr-contextless-status` in the imperative rather than the interrogative. Two wordings because the failure they guard against is a REFUSAL — an agent that answers 'sur quoi ?' is behaving reasonably given an empty context, and the whole point of a standing block is that the context is not empty.",
      prompt: "Fais-moi un point.",
      tags: ["memory", "contextless", "standing"],
      seed: seedUniverse,
      assertions: [
        { type: "noError" },
        recentSubjectsFloor,
        {
          type: "judge",
          rubric:
            "The answer offers a brief on the team's recent work, drawing on at least two of: the Nordwind GmbH 2027 contract, the Callisto Systems contact change, Vega Logistics' lead time, the week's planning. Asking a clarifying question is acceptable ONLY if the answer also proposes the recent subjects it could brief on. FAIL for a bare 'on what?', for 'I have no recent activity', or for any invented fact.",
        },
      ],
    },
    {
      id: "mr-contextless-week",
      description:
        "Scores a COMPUTED date (the next Tuesday) that nothing else in the universe holds and that no general knowledge can produce; the assertion recomputes it from the helper the fixture used. Measured 2026-09-11: this case is NOT a clean discriminator for the standing layer — it passed on `--standing-mode none` in two `searchKnowledge` calls, because the fixture's title then carried the word 'semaine'. The word is gone, but an episode about an upcoming delivery stays semantically close to a question about what is coming up. Read the `none` row before citing this case as evidence for the layer; its sisters `mr-contextless-status` and `mr-contextless-brief` are the ones that name nothing retrievable.",
      prompt: "Qu'est-ce qu'on a de prévu cette semaine ?",
      tags: ["memory", "contextless", "standing"],
      seed: seedUniverse,
      assertions: [
        { type: "noError" },
        {
          type: "custom",
          name: "names-the-planned-delivery-date",
          fn: (result: InvokeResult) => {
            const { numeric, long } = nextDeliveryDate();
            return (
              result.text.includes(numeric) ||
              result.text.toLowerCase().includes(long.toLowerCase()) ||
              `answer names neither ${numeric} nor "${long}"`
            );
          },
        },
        {
          type: "judge",
          rubric:
            "The answer states what is planned for the week from the team's own records: the next Nordwind GmbH delivery (Tuesday) and/or the 2027 contract penalty clause still awaiting legal revalidation. FAIL if it invents an event, if it answers that nothing is planned, or if it only restates the question.",
        },
      ],
    },
    {
      id: "mr-written-memory-recalled",
      description:
        "The one loop the memory system promises a user and nothing measured: the assistant is told to record a rule in ONE conversation and has to know it in the NEXT. The seed plays the write turn for real rather than inserting a fixture, so a failure attributes to a stage — the seed aborts when the agent never wrote, the assertions fail when it wrote and recall never surfaced it.",
      prompt: "Je prépare un devis, quelque chose à respecter ?",
      tags: ["memory", "write", "chain"],
      seed: seedWrittenMemory,
      cleanup: (ctx: EvalCaseContext) => dropWrittenMemories(ctx.teamId),
      assertions: [
        { type: "noError" },
        // The discriminating value — see `WRITTEN_VALIDITY`. A model answering
        // from general knowledge says 30 days, so this cannot pass on a turn
        // that read nothing.
        { type: "regex", value: WRITTEN_VALIDITY, flags: "i" },
        {
          type: "judge",
          rubric:
            "The answer states the team's own recorded rule for quotes: a validity of 45 days, and that the delivery lead time must appear on the quote. Partial credit for one of the two. FAIL for generic quoting advice carrying neither, for a different validity period, or for answering that no applicable rule is known.",
        },
      ],
    },
  ],
};
