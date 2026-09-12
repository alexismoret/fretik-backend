# Web research stack — decision record

Why `searchWeb` / `webFetch` / `webMap` are backed by what they are backed by,
what was measured, and what it costs. Written 2026-09-12, when Tavily was
replaced.

Code: `packages/ai/src/lib/web/`. Operator variables: `packages/ai/.env.example`,
`docs/OPERATIONS.md`.

---

## 1. What changed

| Tool        | Before            | After                                        |
| ----------- | ----------------- | -------------------------------------------- |
| `searchWeb` | Tavily `/search`  | **Perplexity** `/search`                     |
| `webFetch`  | Tavily `/extract` | **Parallel** `/v1/extract`                   |
| `webMap`    | Tavily `/map`     | **`robots.txt` + `sitemap.xml`** — no vendor |

Perplexity is the preferred search backend, Parallel is both the alternative
(`AI_WEB_SEARCH_PROVIDER=parallel`) and the automatic fallback. Availability is
checked per tool, so a deployment missing one key keeps the tools the other one
backs.

## 2. The measurements

Two independent benchmarks, both **provider-swap** designs: the model, the
harness, the task set and the budgets are held fixed, and only the search vendor
changes. That is the only design that isolates retrieval quality from model
quality, and it is why these numbers were trusted over vendor claims.

### Artificial Analysis Search Index

Equal-weighted mean of DeepSearchQA, BrowseComp and AA-Omniscience, agent on the
open-source Stirrup harness, candidate model fixed at GPT-5.6 Luna.

| Product               |  Index |       Price /1k | Notes                                        |
| --------------------- | -----: | --------------: | -------------------------------------------- |
| **Perplexity medium** | **80** |     **$5 flat** | 1st of the board; ~1.1 s/query, 27-29 s/task |
| Perplexity high       |  top-3 |         $5 flat | quality plateaus between medium and high     |
| Perplexity low        |  top-3 |         $5 flat | 36 s/task — cheaper payloads, more searches  |
| Parallel advanced     |     75 |              $5 | previous co-leader                           |
| Brave LLM context     |     75 |             ~$5 | previous co-leader                           |
| Exa auto              |     74 | $7 + surcharges |                                              |
| Firecrawl SERP        |     73 |             ~$2 |                                              |
| Parallel fast         |     73 |              $1 | cheapest search cost per task ($8.41/1k)     |

Board latency range: 19-62 s per task. Perplexity posts the lowest model
inference cost per task on the board, $0.028-$0.034, because its payloads are
lean — a saving on **our** model bill, not the provider's.

### OpenBenchmarks — web search for coding agents

Open code and open data, 100 held-out enterprise-documentation tickets, model
fixed at `gpt-5.6-sol`, mean ± SD over 3 runs, budgets fixed at 32 turns /
5 searches / 5 fetches. Snapshot of 2026-09-09.

| Search only          | Completion | Avg search | Median tokens |
| -------------------- | ---------: | ---------: | ------------: |
| **Perplexity (low)** |  **77.3%** |     957 ms |     **8,765** |
| Firecrawl            |      70.3% |     2.87 s |         7,456 |
| Parallel fast        |      66.7% |     953 ms |        12,460 |
| Exa fast             |      66.3% |     626 ms |        22,344 |
| Parallel turbo       |      64.7% |     333 ms |        14,130 |
| **Tavily fast**      |  **47.3%** |     282 ms |        23,922 |
| Brave (LLM Context)  |      43.0% |     547 ms |        21,000 |

| Search + fetch        | Completion | Avg search | Median tokens |
| --------------------- | ---------: | ---------: | ------------: |
| Exa deep              |      83.0% |     3.97 s |        23,660 |
| Exa auto              |      81.7% |     1.19 s |        27,433 |
| TinyFish              |      79.0% |     1.32 s |        12,844 |
| **Perplexity (high)** |  **77.7%** | **991 ms** |        20,062 |
| Parallel advanced     |      77.0% |     3.11 s |        27,092 |
| Firecrawl             |      76.0% |     2.81 s |        17,379 |
| **Tavily advanced**   |  **60.0%** |     3.41 s |        26,269 |
| **Tavily basic**      |  **59.0%** |     1.50 s |        27,405 |

### What the two boards agree on

- **Tavily is last or near it on both.** 59-60% against 77-83 for the leaders on
  the same tasks, and 47.3% search-only. This was the decision.
- **Perplexity is top-tier on both**, and is the fastest and most
  token-efficient of the leading group.
- **Brave does not generalise**: 75 on AA, 43.0% on OpenBenchmarks. It was
  considered and dropped on that contradiction.

Where they disagree — OpenBenchmarks puts Exa first on search + fetch (83.0%)
while AA scores Exa auto 74 — the explanation is the task mix: OpenBenchmarks
scores _coding-agent work against vendor documentation_, terrain Exa's semantic
index is built for. AA's mix (general knowledge plus browsing) is closer to what
a generalist B2B assistant does, so it carried more weight here. Exa remains the
documented alternative if that judgement turns out wrong.

## 3. Why each backend

### `searchWeb` → Perplexity

First on the board whose task mix matches ours, first on search-only on the
other. Three properties then shaped the tool's schema:

- **A request takes up to five queries and bills as ONE unit.** So the tool
  takes `queries: string[]` and asks the model for 2-3 phrasings. Previously the
  agent fired one `searchWeb` per phrasing and paid a full round-trip each time.
- **$5/1k is flat across `low`/`medium`/`high` context.** The depth dial is
  therefore purely quality/latency/context and never a price arbitration, which
  is why the tool can expose it without teaching the model a cost model. Nothing
  else caps the payload: `max_tokens_per_page` is left unset, because the
  context-size presets are what the benchmarks measured, and a fixed per-result
  cap applied equally to `low` and `high` would stop `high` returning any more
  than `low` — flattening our own `depth` option into decoration.
- **The filters are a superset of the old tool's.** Both date bounds, a relative
  recency preset, domain allow/deny, language, country, and the `academic` /
  `sec` verticals. Under Parallel we would have _lost_ `end_date`.

Gaps, and where each is answered: no URL fetch (Parallel, below), no site map
(`sitemap.ts`), no favicon (derived from the host), no images (harvested from
the Markdown of the pages `webFetch` reads).

### `webFetch` → Parallel

Two hard requirements decided this, and neither is about ranking quality:

1. **It must read JS-rendered pages.** Tavily's `advanced` depth did, so anything
   that did not would be a regression on the most visible tool. Parallel runs a
   server-side headless browser on every extract — no depth flag the model can
   forget to pass.
2. **It must not fetch from our IP.** A hosted service reading the open web from
   one datacenter address collects blocks. This is also why the fetch is not
   done in-process, which was the first plan: OpenClaw does exactly that, but
   OpenClaw runs on the user's machine, on a residential IP.

Cost: **$1/1k URLs, pay-as-you-go, no subscription**, 20 URLs per call. Against
Tavily's `advanced` tier ($3.20/1k) it is 3.2× cheaper.

Firecrawl was the other candidate — both reference agents use it as their
JS-extraction fallback — and was dropped on one fact: it is **subscription-only,
with no true pay-as-you-go**. Jina Reader is 5-10× cheaper again (~$0.15/1k) and
returns images natively, but was acquired by Elastic, its pricing page 404s, and
it takes one URL per call; it is the documented cheap alternative, not the base.

### Images

Neither Perplexity's `/search` nor Parallel's `/extract` returns images —
verified in both official SDKs — so there is no image _source_ in this stack.
The strip is harvested instead, from the Markdown of pages that were read.

`include_images` on `searchWeb` keeps the affordance the Tavily tool had: ask
for images, get images, without first choosing a page to open. It extracts the
top 3 hits (`AI_WEB_SEARCH_IMAGE_SOURCES`) and harvests their illustrations, so
every picture belongs to a result the answer can cite — which Tavily's
query-matched images did not. `webFetch({ with_images: true })` is the same
harvest on pages the agent was reading anyway.

|                          | Tavily              | Now                                         |
| ------------------------ | ------------------- | ------------------------------------------- |
| Where they come from     | its own image index | the pages the search returned               |
| Relevance                | to the **query**    | to a **cited source**                       |
| Available at search time | yes                 | yes, opt-in                                 |
| Caption                  | model-written       | the image's alt text, page title when empty |
| Cost                     | none                | $0.001 per page read, only when asked       |

Two things are genuinely worse and are not worth pretending otherwise:
**captions**, because alt text is frequently empty or junk and the page title is
only a fallback; and **coverage**, because a subject the top results do not
illustrate yields nothing, where a dedicated image index would still have found
something.

Telling an illustration from site furniture is the hard part, and a filename
blocklist only works on sites that name their files honestly — a CDN serving the
logo from `/a1b2c3d4.png` defeats it entirely. The signal that generalises is
**repetition across the batch**: a logo, an avatar or a share button appears on
every page of a site, a photograph on one, so an image carried by a strict
majority of the pages read together is dropped whatever its URL looks like. That
signal needs more than one page to exist, which is why the harvest reads several
and why `webFetch` tells the agent to batch related URLs.

Still out of reach: a page whose only illustration lives in an `og:image` meta
tag, outside the body, contributes nothing.

### `webMap` → no vendor

`robots.txt` and `sitemap.xml` are published _for robots_: static text served by
the origin rather than by a bot-detection layer. So the datacenter-IP problem
that rules out fetching pages ourselves does not apply to fetching a site's own
index of itself, and discovery costs nothing where Tavily billed ~1 credit per
10 pages and doubled it for semantic filtering. Both the crawl and the filtering
are now free, which is why `search` and `select_paths` can be applied
generously.

The honest limit: a site with no sitemap returns nothing. The tool says so with
`WEB_MAP_NO_SITEMAP` and points the model at a domain-restricted `searchWeb`,
which also reaches pages a sitemap never lists.

#### Reading the XML: `Bun.XML` first, a scan when it refuses

`Bun.XML` (Bun ≥ 1.4) is the primary reader. It gets four things right that a
`<loc>` pattern has to earn one at a time — CDATA-wrapped values, commented-out
entries (a page the site WITHDREW), entity decoding, namespace prefixes — and it
separates a page's `<loc>` from the `<image:loc>` nested inside it
**structurally**, where a pattern can only guess from the namespace declaration.
That guess is not academic: getting it wrong hands an image sitemap's JPEGs to
`webFetch`.

It is not the only path, for two measured reasons:

- **It throws on malformed XML**, which real sitemaps frequently are — an
  unescaped `&` in a query string is endemic. Verified on Bun 1.4.2:
  `…/a?b=1&c=2` raises `Expected ';' after the entity name`, and an unclosed tag
  raises too. Strictness there costs every URL in the file; a scan still returns
  all of them.
- **The runtime is pinned loosely** — `oven/bun:1` in the Dockerfiles,
  `bun-version: latest` in CI. Both are on 1.4 today, but a floating pin is
  exactly the thing not to assume.

So the parser is feature-detected and passed as an argument, and
`readSitemapDocument(xml, parser)` falls through to the scan on a throw or an
older runtime. Both paths run the same case table in
`tests/unit/lib/web-sitemap.test.ts`, with the parser path added only when the
runtime has one — a suite that silently exercised whichever path the local
`bun` happened to offer would be worse than none.

## 4. What the reference agents do

Checked before committing, because a benchmark says which provider is good and
not how to wire one.

**OpenClaw** runs three tiers: a local `web_fetch` (HTTP GET + Readability, no
JS, blocks private hosts and **re-checks redirects**), a **Firecrawl fallback**
when Readability fails, and a separate browser tool for JS and logins. It caches
`web_search` by query and `web_fetch` by URL for 15 minutes, configurable, zero
disables.

**Hermes / Nous Portal** routes its Tool Gateway search to Firecrawl and its
cloud browser to Browser Use. The community plugin _Web Search Plus_ puts 17
providers behind one interface with a routing priority, automatic fallback, a
unified `freshness` filter translated to each provider's native parameter, and a
maintained privacy matrix flagging vendors whose terms permit training on
customer data.

Four things were taken from this:

1. **A result cache with a TTL** (`lib/web/cache.ts`). An agent repeats
   near-identical queries across the steps of one turn, and a sub-agent repeats
   its parent's. Stricter than `selectOrCache`: an empty result is never stored,
   because pinning zero hits for fifteen minutes turns one bad provider moment
   into an agent that can find nothing on a subject.
2. **A search fallback** (`lib/web/routing.ts`). One hop, one alternative —
   free to own, since the second adapter exists and its key is already present
   for `webFetch`.
3. **`status` on a failed fetch.** A 403 (the site refuses automation) calls for
   a different move than a 404 (gone), and the model can only make it if the
   code reaches it. OpenClaw also reports a `finalUrl`; Parallel does not expose
   the requested-vs-landed distinction, so that one was left out rather than
   shipped as a field that never populates.
4. **Redirect re-validation per hop** (`lib/web/http.ts`), which is what makes
   `webMap` safe to run in-process.

Neither project has adopted Perplexity Search: _Web Search Plus_ lists
Perplexity as "rejected legacy answer endpoint; no source-only mode is
registered", which refers to the older Sonar _answer_ API, not the Search API
that returns raw `title`/`url`/`snippet`/`date`. It is a stale catalogue entry
rather than a verdict — but it does mean this stack is ahead of the open-source
ecosystem, with fewer worked examples to copy.

## 5. Cost model

Public pay-as-you-go rates, 2026-09. Every rate is env-overridable
(`PERPLEXITY_PRICE_PER_SEARCH`, `PARALLEL_PRICE_PER_*`) because a negotiated
rate changes the number, not the code.

| Operation                                  | Before             | After          |
| ------------------------------------------ | ------------------ | -------------- |
| One search                                 | $0.008             | **$0.005**     |
| One search, 3 phrasings                    | $0.024 (3 calls)   | **$0.005** (1) |
| One page read, JS-rendered                 | $0.0032            | **$0.001**     |
| One page read, static                      | $0.0016            | **$0.001**     |
| Site map                                   | $0.0008 / 10 pages | **$0**         |
| A repeat of any of the above within 15 min | full price         | **$0**         |

A research turn — one search with 3 phrasings, three JS pages read — goes from
**$0.0336 to $0.008, −76%**. The model bill drops too: ~20k median tokens per
task against ~26k, roughly −24%, because the payloads are leaner.

## 6. Open items

- **Parallel's headless-browser rendering is a vendor claim**, not something
  measured here. First check with a real key: a known client-rendered page.
- **Data retention.** Perplexity's API is documented as Zero Data Retention by
  default (prompts and responses not stored, only operational metadata). Confirm
  contractually for the Search API, and check Parallel's equivalent, before
  routing queries that carry client names.
- **Validate the choice on our own gold set.** `AI_WEB_SEARCH_PROVIDER` exists
  so the Langfuse eval loop (`bun run evals:langfuse`) can score Perplexity
  against Parallel on Fretik's curated cases. Public benchmarks chose the
  shortlist; our own data should confirm the pick.
