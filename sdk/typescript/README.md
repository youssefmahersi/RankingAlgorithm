# @youssefmahersi/ranking — TypeScript SDK

Deterministic, dependency-free ranking for feeds and catalogues.

```
score = log10(1 + Σ wᵢ·pᵢ) − g · log10(t + t₀)
```

Ranking you can audit, run inside a SQL query, and explain to a lawyer. Zero
runtime dependencies, ESM + CJS, strict types, 8.1 kB gzipped before your bundler
minifies anything (`npm run size` re-measures it). Part of
[RankingAlgorithm v2](https://github.com/youssefmahersi/RankingAlgorithm); the
JavaScript, Python and Go SDKs produce identical orderings.

```bash
npm install @youssefmahersi/ranking
```

## Quickstart

```ts
import { rank } from '@youssefmahersi/ranking'

const posts = [
  { id: 'a', createdAt: '2026-01-15T11:00:00Z', like: 40,  comment: 12,  share: 3 },
  { id: 'b', createdAt: '2026-01-14T12:00:00Z', like: 900, comment: 120, share: 60 },
  { id: 'c', createdAt: '2026-01-15T12:00:00Z', like: 0,   comment: 0,   share: 0 },
]

rank(posts, { preset: 'social-feed' }).map((p) => p.id)
// ['a', 'b', 'c'] — 'b' is viral but a day old; 'c' is empty yet still rankable
```

`rank(posts)` with no options uses the `social-feed` preset. Presets are the
product; configuration is the advanced option.

`rank()` preserves your element type — the result is `Post[]`, not
`Record<string, unknown>[]`.

## Presets

|  | `social-feed` | `ecommerce` |
| --- | --- | --- |
| `gravity` (g) | 1.5 | 0.3 |
| `graceHours` (t₀) | 2 h | 72 h |
| Signals | like 1, comment 3, share 5 | view 0.05, cart 1, purchase 10 |

`social-feed` — a 24 h old item needs ~47× the engagement of a fresh one to tie,
~125× at 48 h. `ecommerce` — a 90-day-old product needs only ~2.8× the sales of a
new one, ~4.2× over a full year.

## Reading a score

One point of difference equals a factor of ten in engagement. Negative scores are
normal and carry no meaning — only the order matters.

## API

```ts
rank(items, options?)              // T[], best first
rankWithScores(items, options?)    // Scored<T>[], keeps the numbers
top(items, n, options?)            // T[], best n

score(item, options?)              // number
quality(item, options?)            // log10(1 + Σ) — time-independent
timePenalty(ageHours, options?)    // g · log10(t + t₀)
ageHours(item, options?)           // number
explain(item, options?)            // Explanation

solveGravity({ ratio, afterHours, graceHours })   // the tuning protocol
engagementRatio(afterHours, options?)             // its inverse, for sanity checks
decadeHours(options?)                             // when the penalty is worth 10×
tauSeconds(options?)                              // the τ used by SQL strategy A

toSQL(options?, strategy?)         // full statement
sqlExpression(options?, strategy?) // just the score expression

VERSION, SPEC_VERSION, FORMULA, PRESETS, RankingError
```

### Options

Every field is optional. A preset supplies the defaults; anything you pass
overrides it.

```ts
rank(posts, {
  preset: 'social-feed',
  gravity: 2.0,
  graceHours: 1,
  signals: { upvote: 1, reply: 2.5, bookmark: 4 },
  dateField: 'publishedAt',       // default 'createdAt'
  idField: 'slug',                // default 'id' — used for the tie-break
  qualityField: 'hot',            // read a stored log10(1 + Σ) instead of recomputing
  now: fixedInstant,              // injectable; see pagination below
  onFutureItem: 'clamp',          // default 'error'
  engagement: (item) => custom,   // replaces the weighted sum entirely
  bayesian: { /* see below */ },
})
```

Dates may be a `Date`, an ISO 8601 string, or **epoch milliseconds** (the
`Date.now()` convention). The Python SDK takes epoch *seconds*, following its own
language's convention; both agree on ISO strings.

### `explain()`

```ts
explain(posts[0], { preset: 'social-feed' })
// {
//   id: 'a',
//   engagement: 91,
//   signals: [ { field: 'comment', value: 12, weight: 3, contribution: 36, share: 0.395 }, … ],
//   quality: 1.9638, ageHours: 1, timePenalty: 0.7157, score: 1.2481,
//   config: { gravity: 1.5, graceHours: 2 },
//   formula: 'score = log10(1 + sum(w_i * p_i)) - g * log10(t + t0)',
// }
```

Signals are reported in sorted field order, identically in all four SDKs.

### Tuning

Do not tune by trial and error. Answer one product question — *an item X hours
old, how many times more engagement must it have to beat a brand-new one?* — and
invert it:

```ts
solveGravity({ ratio: 47, afterHours: 24, graceHours: 2 })  // 1.5009…
```

Set `graceHours` first, then solve for gravity. The two interact strongly: raising
`graceHours` flattens the entire time penalty, not just the early window, so
re-solve gravity whenever you change it.

### Future-dated items

An item published after `now` gives `t < 0`, which would silently invert the
ranking, so it throws. Pass `onFutureItem: 'clamp'` to treat scheduled content as
brand new instead.

### Pagination stability

The score depends on `t`, so it changes between the page-1 and page-2 queries and
items jump between pages. Freeze a reference instant at the start of the session
and carry it in the cursor:

```ts
const now = cursor.startedAt ?? new Date()
rank(candidates, { preset: 'social-feed', now })
```

`rank()` also pins `now` once per call, so a long array is never scored across a
clock tick.

### Bayesian smoothing (opt-in)

Without it, a product with a single 5★ review beats one with 200 reviews averaging
4.8. Off by default, never on the default path:

```ts
rank(products, {
  preset: 'ecommerce',
  bayesian: { ratingField: 'stars', countField: 'reviews', prior: 3.8, priorCount: 25, weight: 12 },
})
```

## SQL

```ts
toSQL({ preset: 'social-feed', table: 'posts' }, 'A')   // indexed generated column
toSQL({ preset: 'ecommerce', table: 'products' }, 'B')  // exact power law, bounded window
```

Postgres and MySQL. Which strategy applies, and why the choice is forced rather
than a preference, is covered in the
[root README](https://github.com/youssefmahersi/RankingAlgorithm#database-integration).

## v1 compatibility

The 1.x API still runs, from a separate entry point, with a one-time deprecation
notice. It is removed in 3.0.0.

```ts
import { RankingAlgorithm } from '@youssefmahersi/ranking/legacy'
```

See the [migration guide](https://github.com/youssefmahersi/RankingAlgorithm/blob/main/MIGRATION.md).

## Scope

Not in scope, permanently: personalisation, machine learning, embeddings, storage,
A/B testing infrastructure, diversity and dedupe rules, moderation logic. The one
deliberate exception is the opt-in Bayesian term above.

## License

MIT
