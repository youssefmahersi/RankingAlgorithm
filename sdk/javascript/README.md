# @youssefmahersi/ranking-js — JavaScript SDK

Deterministic ranking for feeds and catalogues, as **one dependency-free ESM
file**. No build step, no bundler, no transpiler.

```
score = log10(1 + Σ wᵢ·pᵢ) − g · log10(t + t₀)
```

Part of [RankingAlgorithm v2](https://github.com/youssefmahersi/RankingAlgorithm);
the TypeScript, Python and Go SDKs produce identical orderings.

## Which package do I want?

| | This one — `@youssefmahersi/ranking-js` | `@youssefmahersi/ranking` |
| --- | --- | --- |
| Format | ESM only, one file | ESM **and** CJS |
| Build step | none — copy it, serve it, import it by URL | compiled from TypeScript |
| Types | hand-written `.d.ts` | generated, strict, source of truth |
| Use it for | browsers, Deno, no-build Node, `<script type="module">` | Node apps, bundlers, `require()`, TypeScript |

Both are held to the same [conformance
fixture](https://github.com/youssefmahersi/RankingAlgorithm/blob/main/conformance/cases.json).
If you use a bundler or need `require()`, prefer `@youssefmahersi/ranking`.

## Install

```bash
npm install @youssefmahersi/ranking-js
```

Or skip npm entirely:

```html
<script type="module">
  import { rank } from './ranking.js'
</script>
```

```js
// Deno
import { rank } from 'npm:@youssefmahersi/ranking-js'
```

## Quickstart

```js
import { rank } from '@youssefmahersi/ranking-js'

const posts = [
  { id: 'a', createdAt: '2026-01-15T11:00:00Z', like: 40,  comment: 12,  share: 3 },
  { id: 'b', createdAt: '2026-01-14T12:00:00Z', like: 900, comment: 120, share: 60 },
  { id: 'c', createdAt: '2026-01-15T12:00:00Z', like: 0,   comment: 0,   share: 0 },
]

rank(posts, { preset: 'social-feed' }).map((p) => p.id)
// ['a', 'b', 'c'] — 'b' is viral but a day old; 'c' is empty yet still rankable
```

`rank(posts)` with no options uses the `social-feed` preset.

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

Identical to the TypeScript SDK:

```js
rank(items, options?)              // best first
rankWithScores(items, options?)    // keeps the numbers
top(items, n, options?)

score(item, options?)
quality(item, options?)            // log10(1 + Σ) — time-independent
timePenalty(ageHours, options?)
ageHours(item, options?)
explain(item, options?)            // the full decomposition

solveGravity({ ratio, afterHours, graceHours })
engagementRatio(afterHours, options?)
decadeHours(options?)
tauSeconds(options?)

toSQL(options?, strategy?)
sqlExpression(options?, strategy?)

VERSION, SPEC_VERSION, FORMULA, PRESETS, RankingError
```

Full option reference and the tuning protocol are in the
[TypeScript README](https://github.com/youssefmahersi/RankingAlgorithm/blob/main/sdk/typescript/README.md)
— the options are the same object.

Dates may be a `Date`, an ISO 8601 string, or epoch milliseconds.

### `explain()`

```js
explain(posts[0], { preset: 'social-feed' })
// {
//   id: 'a',
//   engagement: 91,
//   signals: [ { field: 'comment', value: 12, weight: 3, contribution: 36, share: 0.395 }, … ],
//   quality: 1.9638, ageHours: 1, timePenalty: 0.7157, score: 1.2481,
// }
```

## v1 compatibility

The 1.x API still runs, from a separate entry point, with a one-time deprecation
notice. It is removed in 3.0.0.

```js
import { RankingAlgorithm } from '@youssefmahersi/ranking-js/legacy'
```

See the [migration guide](https://github.com/youssefmahersi/RankingAlgorithm/blob/main/MIGRATION.md).

## Scope

Not in scope, permanently: personalisation, machine learning, embeddings, storage,
A/B testing infrastructure, diversity and dedupe rules, moderation logic. The one
deliberate exception is opt-in Bayesian smoothing for star ratings.

## License

MIT
