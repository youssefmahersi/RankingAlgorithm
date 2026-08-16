# RankingAlgorithm

[![CI](https://github.com/youssefmahersi/RankingAlgorithm/actions/workflows/ci.yml/badge.svg)](https://github.com/youssefmahersi/RankingAlgorithm/actions/workflows/ci.yml)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![spec v2](https://img.shields.io/badge/spec-v2-brightgreen.svg)](docs/SPEC.md)

**Ranking you can audit, run inside a SQL query, and explain to a lawyer.**

If you are about to paste a Hacker News snippet off a blog post and hope the
constants are right — this is that, with the constants explained, the edge cases
tested, and the same answer in four languages.

```ts
import { rank } from '@youssefmahersi/ranking'

const ordered = rank(posts, { preset: 'social-feed' })
```

That is the whole quickstart. `rank(posts)` with no options works too.

```
id                score    why
──────────────────────────────────────────────────────────
hour-old-good     1.248    91 engagement, 1 h old
week-old-huge     1.217    36 500 engagement, but 168 h old
day-old-viral     1.071    1 560 engagement, 24 h old
fresh-quiet       0.005    3 engagement, 30 min old
brand-new-empty  -0.452    nothing yet — still rankable
```

Note the last row. A brand-new item with **zero** engagement still gets a real
score and a real position. That single property is why v1 was replaced.

---

## Install

| SDK | Install | Notes |
| --- | --- | --- |
| **TypeScript** | `npm i @youssefmahersi/ranking` | ESM + CJS, strict types, 8.1 kB gzipped unminified, zero deps |
| **JavaScript** | `npm i @youssefmahersi/ranking-js` | One ESM file, no build step — browser, Deno, Node |
| **Python** | `pip install rankingalgorithm` | 3.9+, typed, zero deps |
| **Go** | `go get github.com/youssefmahersi/RankingAlgorithm/sdk/go/v2` | 1.21+, generics, zero deps |

All four implement **spec revision 2** and are held to a [shared conformance
fixture](conformance/cases.json): same inputs, same order, same numbers, checked
in CI on every push. Each has its own README — [TypeScript](sdk/typescript/README.md),
[JavaScript](sdk/javascript/README.md), [Python](sdk/python/README.md),
[Go](sdk/go/README.md).

## The formula

$$\text{score} = \log_{10}\left(1 + \sum_i w_i p_i\right) - g \cdot \log_{10}(t + t_0)$$

- $\sum w_i p_i$ — weighted engagement. Each signal carries a weight.
- $t$ — age in hours since publication.
- $t_0$ — **grace window**. While $t \ll t_0$ the age penalty is negligible; this
  is the period during which new content can accumulate its first signals.
- $g$ — **gravity**, the decay speed. $g = 0$ ignores time entirely.

**Reading a score:** one point of difference equals a factor of ten in
engagement. Negative scores are normal and carry no meaning — only the order
matters.

Three things about that shape are deliberate:

**The additive form.** This is algebraically $\log(A/B)$ — the same division as
v1, written in log space. The order is rigorously identical because $\log$ is
strictly increasing ([and a test proves
it](sdk/typescript/test/invariants.test.ts) against a naive $E/(t+t_0)^g$
reference). The benefit is numerical: no 5000× dynamic range, no float precision
problems, and an expression you can paste into SQL.

**The $\log$ on the numerator.** Engagement is power-law distributed. Without it,
a raw product like `likes × audience` is quadratic in popularity and large items
crush everything else.

**The $1+$.** It guarantees a finite score at zero engagement, so a fresh item
with no signals is still rankable.

## Presets

Presets are the product. Configuration is the advanced option.

|  | `social-feed` | `ecommerce` |
| --- | --- | --- |
| $g$ | 1.5 | 0.3 |
| $t_0$ | 2 h | 72 h |
| Signals | like 1, comment 3, share 5 | view 0.05, cart 1, purchase 10 |

- **`social-feed`** — a 24 h old item needs ~47× the engagement of a fresh one to
  tie, ~125× at 48 h. Content is effectively dead in two days.
- **`ecommerce`** — a 90-day-old product needs only ~2.8× the sales of a new one.
  Over a full year the penalty reaches only ~4.2×, so a genuine best-seller stays
  on top for years while remaining separable by age.

## Tuning

Do not tune by trial and error. Ask one product question:

> An item **X** hours old — how many times more engagement must it have to beat a
> brand-new one?

Then invert it:

$$g = \frac{\log(\text{ratio})}{\log\left((X + t_0)/t_0\right)}$$

```ts
import { solveGravity, engagementRatio } from '@youssefmahersi/ranking'

solveGravity({ ratio: 47, afterHours: 24, graceHours: 2 })  // 1.5009…
engagementRatio(48, { preset: 'social-feed' })              // 125.0 — sanity check
```

Set $t_0$ first ("how long does content get to start?"), then solve for $g$. **The
two interact strongly:** raising $t_0$ flattens the entire time penalty, not just
the early window, so re-solve $g$ whenever you change it.

## `explain()`

The "not AI" argument, made tangible — and the fastest way to find out why an item
you expected on top is not.

```ts
explain(post, { preset: 'social-feed' })
```

```
{
  id: 'hour-old-good',
  engagement: 91,
  signals: [
    { field: 'comment', value: 12, weight: 3, contribution: 36, share: 0.395 },
    { field: 'like',    value: 40, weight: 1, contribution: 40, share: 0.440 },
    { field: 'share',   value: 3,  weight: 5, contribution: 15, share: 0.165 },
  ],
  quality:     1.9638,   // log10(1 + 91) — time-independent, storable, indexable
  ageHours:    1,
  timePenalty: 0.7157,   // 1.5 · log10(1 + 2)
  score:       1.2481,
}
```

---

## Where this library sits in an architecture

Large platforms do not solve the time-decay indexing problem. They **avoid** it,
with a multi-stage funnel:

```
   100 000 000 items
          │
          ▼
  ┌───────────────────┐   cheap, indexable retrieval
  │  1. candidates    │   a WHERE clause and an index
  └───────────────────┘   → ~2 000
          │
          ▼
  ┌───────────────────┐   light ranking
  │  2. filtering     │   → ~500
  └───────────────────┘
          │
          ▼
  ┌───────────────────┐   ◄── THIS LIBRARY
  │  3. rescoring     │   time decay, in memory, on a few hundred items
  └───────────────────┘   indexability is irrelevant here
          │
          ▼
  ┌───────────────────┐   diversity, dedupe, business rules
  │  4. presentation  │
  └───────────────────┘
```

**This library is stage 3, not the database sort.** Time decay belongs on a few
hundred in-memory items — never in an index. `toSQL()` serves stage 1, candidate
generation, not final ordering.

The commercial argument: large platforms have a four-stage funnel and an ML team.
You get the same ranking stage without the other three. For an app with 50 000
posts, stage 1 is a `WHERE` clause and stage 3 is this library.

## Database integration

This was an input constraint on the API, not an afterthought. If you write the
code first, the API turns out not to translate to SQL.

**The core problem.** The score depends on $t = \text{now} - \text{created\_at}$,
so it changes every second, for every row, simultaneously. A stored `score` column
is stale immediately. A cron rewriting the table thrashes the index and is wrong
between runs. Computing with `now()` in the query forces a full table scan plus a
sort, because no index can help when the indexed values are no longer current.

**The question that decides everything: does `now` cancel when comparing two rows?**

| | Power law — $-g\log(t + t_0)$ | Exponential — $+\,\text{created\_epoch}/\tau$ |
| --- | --- | --- |
| Time enters | inside a log | linearly |
| Does `now` cancel? | **No** | **Yes** |
| Can two items swap over time? | Yes — intended | Never |
| Indexable? | **No** | **Yes** |

This is exactly why Reddit's formula is linear in time. It was not an accident.

### Strategy A — indexed generated column (high volume)

```ts
toSQL({ preset: 'social-feed', table: 'posts' }, 'A')
```

```sql
ALTER TABLE "posts" ADD COLUMN "hot" double precision
  GENERATED ALWAYS AS (
    log(1 + 3.0 * "comment" + "like" + 5.0 * "share") + ("created_epoch" - 1577836800.0) / 26219.439602
  ) STORED;

CREATE INDEX "posts_hot_idx" ON "posts" ("hot" DESC);

SELECT * FROM "posts" ORDER BY "hot" DESC LIMIT 20;
```

Index scan, constant cost, no maintenance. The column recomputes when engagement
changes — on a vote, not every second.

**Two traps, both emitted as comments in the generated SQL:**

- Postgres requires generated columns to be **immutable**.
  `extract(epoch from created_at)` is *not* immutable on a `timestamptz`. Store a
  `created_epoch bigint` at insert time and generate from that.
- **Offset the epoch** (count from 2020, not 1970) to keep the numbers small and
  preserve float precision. The emitter does this for you.

$\tau$ reads as: *how many seconds of freshness are worth a factor of ten in
engagement.* It is the single knob, and it is derived from your `gravity` and
`graceHours` rather than guessed — `tauSeconds()` exposes it.

### Strategy B — bounded candidate set (power law)

```ts
toSQL({ preset: 'ecommerce', table: 'products' }, 'B')
```

```sql
SELECT *,
       log(1 + "cart" + 10.0 * "purchase" + 0.05 * "view")
       - 0.3 * log((extract(epoch from now() - "created_at") / 3600.0) + 72.0) AS score
FROM "products"
WHERE "created_at" > now() - interval '7 days'
ORDER BY score DESC
LIMIT 20;
```

The `WHERE` uses an ordinary index and cuts the candidate set to a few thousand
rows; sorting that handful is free. Valid whenever the relevance window is
bounded — true of a social feed, never of a product catalogue.

**Recommendation per preset:** `social-feed` → strategy A. `ecommerce` → strategy
B with a nightly batch recompute (catalogues are small and move slowly).

Every identifier is quoted. `like` — the default `social-feed` signal name — is a
reserved word in Postgres, and quoting also preserves the case of camelCase
columns that ORMs create.

> CI runs the emitted strategy-B SQL against a real Postgres and asserts it
> produces the same ordering as the library, on the same fixture. See
> [`scripts/sql-parity.mjs`](scripts/sql-parity.mjs).

### Pagination stability

Because the score depends on $t$, it changes between the page-1 query and the
page-2 query — items jump between pages, or vanish entirely.

- Under **strategy A** the problem disappears: the order is frozen.
- Under the **power law**, freeze a reference instant at the start of the browsing
  session and carry it in the cursor:

```ts
const now = cursor.startedAt ?? new Date()
const page = rank(candidates, { preset: 'social-feed', now })
```

This is the bug you would otherwise spend three days diagnosing. `now` is
injectable in every SDK for exactly this reason.

---

## What changed in v2, and why

v1's formula was:

```
score = Σ properties / (1 - e^(-t/stretch) + startValue)
```

It had four defects. Documenting them openly is a feature of this project, not an
embarrassment.

**Unintended saturation.** As $t \to \infty$ the denominator tends to
$1 + \text{startValue} \approx 1$, so the score converges to the raw engagement
sum. Time stops discriminating **entirely**: two items with equal engagement, one
a day old and one a year old, receive identical scores. The README claimed the
algorithm made room for newer content. It did not.

**Collapsed dynamic range.** With `startValue = 0.0002` the multiplier is 5000× at
$t=0$ but falls below 10× by $t = 0.1 \times \text{stretch}$. Roughly 99.8% of the
boost is consumed in the first 10% of the tuning window; the rest of the curve is
flat. `stretch` therefore controlled only the region where nothing happens.

**Coupled parameters.** `startValue` set the peak ($1/v$) *and* participated in the
knee of the curve (via $v \cdot s$). The two knobs were not orthogonal, so tuning
one silently moved the other. Tuning was necessarily empirical.

**Cold start death spiral.** If the engagement sum was zero, the score was zero
regardless of age. A new item with no engagement never surfaced, therefore never
received engagement. The freshness boost multiplied zero.

And for honesty: expanding the exponential to first order gives $P \cdot s / (t + v \cdot s)$
— the Hacker News formula with gravity 1. v1 rediscovered a known good form by
intuition, then broke it in the tail.

Every one of these is now a test that fails if it comes back. See
[`test/invariants.test.ts`](sdk/typescript/test/invariants.test.ts).

**Migrating from 1.x?** → [MIGRATION.md](MIGRATION.md). The v1 API still runs, from
a `/legacy` entry point, with a one-time deprecation notice. It is removed in
3.0.0.

## Scope — what this library will never do

Saying no in advance costs far less than saying no in an issue six months later.

**Not in scope:** personalisation, machine learning, embeddings, storage or
persistence, A/B testing infrastructure, diversity and dedupe rules,
negative-signal moderation logic.

**One deliberate opt-in exception:** Bayesian smoothing for star ratings. Without
it, a product with a single 5★ review beats one with 200 reviews averaging 4.8. It
is a separate term, opt-in, never on the default path.

```ts
rank(products, {
  preset: 'ecommerce',
  bayesian: { ratingField: 'stars', countField: 'reviews', prior: 3.8, priorCount: 25, weight: 12 },
})
```

## Why not embeddings and an LLM re-ranker?

That is the 2026 default reflex. It costs money per request, adds latency,
requires vector infrastructure, needs training data most applications do not have,
and cannot be explained. A deterministic formula has none of those costs. In the
EU, the DSA requires platforms to explain the main parameters of their recommender
systems — a two-parameter formula is trivially compliant; a learned model is not.

---

## Repository layout

```
VERSION                 single source of truth for the release version
conformance/cases.json  shared fixture: all four SDKs must reproduce it exactly
docs/SPEC.md            the v2 design brief this implementation follows
scripts/
  sync-version.mjs      propagate VERSION into every SDK; --check in CI
  generate-conformance.mjs  regenerate the fixture from the reference SDK
  sql-parity.mjs        run the emitted SQL against Postgres, compare orderings
sdk/typescript          @youssefmahersi/ranking
sdk/javascript          @youssefmahersi/ranking-js
sdk/python              rankingalgorithm
sdk/go                  .../sdk/go/v2
```

### Versioning

Four package managers each want the version in their own file and their own
syntax. `/VERSION` is the source of truth; everything else is generated:

```bash
node scripts/sync-version.mjs 2.1.0
```

`SPEC_VERSION` is separate and is *checked*, never rewritten. It is the contract
that says these four SDKs rank identically, and every SDK exports it:

```ts
import { VERSION, SPEC_VERSION, FORMULA } from '@youssefmahersi/ranking'
```

CI fails the build if any SDK disagrees on either, or if the conformance fixture
is stale. A major release must bump the spec version, and a spec version bump is a
major release — the sync script enforces both directions.

### Working on it

```bash
npm ci                    # installs both JS workspaces
npm test                  # typescript + javascript
npm run conformance       # regenerate the fixture after a behaviour change
npm run version:check     # what CI checks
```

```bash
cd sdk/python && pip install -e ".[dev]" && pytest && ruff check . && mypy
```

```bash
cd sdk/go && go test ./...
```

## License

MIT © [Youssef Mahersi](https://github.com/youssefmahersi)
