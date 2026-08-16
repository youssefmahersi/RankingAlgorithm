# RankingAlgorithm v2 — design brief

This document is the specification for a v2 rewrite. It is not the final README —
it is the reasoning that the README, the API and the tests must reflect.
Read it fully before writing any code.

---

## 1. What this library is

A deterministic, dependency-free ranking function for feeds and catalogues.
It answers one question: **given a set of items with engagement signals and a
publication date, what order should they appear in?**

Positioning, in one line:

> Ranking you can audit, run inside a SQL query, and explain to a lawyer.

The competition is not machine learning. The competition is a developer
copy-pasting a Hacker News snippet from a blog post without understanding the
constants. That developer is the target user.

Why this matters in 2026: the default reflex for ranking is embeddings plus LLM
re-ranking. That costs money per request, adds latency, requires vector
infrastructure, needs training data most applications do not have, and cannot be
explained. A deterministic formula has none of those costs. In the EU, the DSA
requires platforms to explain the main parameters of their recommender systems —
a two-parameter formula is trivially compliant, a learned model is not.

## 2. What v1 got wrong

The v1 formula was:

```
score = Σ properties / (1 - e^(-t/stretch) + startValue)
```

Four defects, all of which v2 must fix. The README should document them openly
in a "what changed and why" section — this is a feature of the project, not an
embarrassment.

**Unintended saturation.** As `t → ∞` the denominator tends to `1 + startValue ≈ 1`,
so the score converges to the raw engagement sum. Time stops discriminating
entirely. Two items with equal engagement, one a day old and one a year old,
receive identical scores. The README claimed the algorithm made room for newer
content; it did not.

**Collapsed dynamic range.** With `startValue = 0.0002` the multiplier is 5000× at
`t = 0` but falls below 10× by `t = 0.1 × stretch`. Roughly 99.8% of the boost is
consumed in the first 10% of the tuning window; the rest of the curve is flat.
The `stretch` parameter therefore controlled only the region where nothing
happens.

**Coupled parameters.** `startValue` sets the peak (`1/v`) and also participates in
the knee of the curve (via `v·s`). The two knobs are not orthogonal, so tuning
one silently moves the other. Tuning was necessarily empirical.

**Cold start death spiral.** If the engagement sum is zero the score is zero
regardless of age. A new item with no engagement never surfaces, therefore never
receives engagement. The freshness boost multiplied zero.

Also worth noting for honesty: expanding the exponential to first order gives
`P·s / (t + v·s)` — the Hacker News formula with gravity 1. v1 rediscovered a
known good form by intuition, then broke it in the tail.

## 3. The v2 formula

```
score = log10(1 + Σ wᵢ·pᵢ) − g · log10(t + t₀)
```

Where:

- `Σ wᵢ·pᵢ` — weighted engagement. Each signal carries a weight.
- `t` — age in hours since publication, clamped at zero.
- `t₀` — grace window in hours. While `t ≪ t₀` the age penalty is negligible;
  this is the period during which new content can accumulate its first signals.
  This is what fixes cold start, not the `1 +` alone.
- `g` — gravity. The decay speed. `g = 0` ignores time entirely; higher values
  decay faster.

Three design notes that the implementation must preserve:

**The additive form is deliberate.** This is algebraically `log(A/B)` — the same
division as before, written in log space. Ranking order is rigorously identical
because `log` is strictly increasing. The benefit is numerical: no 5000× dynamic
range, no float precision problems, and a readable SQL expression.

**The `log` on the numerator is not decoration.** Engagement is power-law
distributed. Without it, a raw product like `likes × audience` is quadratic in
popularity and large items crush everything else.

**The `1 +` guarantees a finite score at zero engagement**, so a fresh item with no
signals is still rankable.

**Reading a score:** one point of difference equals a factor of ten in
engagement. Negative scores are normal and carry no meaning — only the order
matters.

### Tuning protocol

Do not tune by trial and error. Ask one product question:

> An item X hours old — how many times more engagement must it have to beat a
> brand-new one?

Then invert:

```
g = log(ratio) / log((X + t₀) / t₀)
```

Set `t₀` first ("how long does content get to start?"), then `g`. The two
interact strongly: raising `t₀` flattens the entire time penalty, not just the
early window. This protocol deserves its own README section — it is the thing
that makes the library tunable by someone who has not read the maths.

## 4. Presets

Presets are the product. Configuration is the advanced option. `rank(items)` with
no arguments must produce a sensible ordering.

| | `social-feed` | `ecommerce` |
|---|---|---|
| `g` | 1.5 | 0.3 |
| `t₀` | 2 h | 72 h |
| Signals | like 1, comment 3, share 5 | view 0.05, cart 1, purchase 10 |

Behaviour these produce:

- `social-feed` — a 24 h old item needs ~47× the engagement of a fresh one to
  tie; ~130× at 48 h. Content is effectively dead in two days.
- `ecommerce` — a 90-day-old product needs only ~2.8× the sales of a new one.
  Over a full year the penalty reaches only ~4×, so a genuine best-seller stays
  on top for years while remaining separable by age. This is the plateau v1 was
  reaching for, obtained cleanly.

## 5. API design

The v1 API is the single biggest thing to discard. It required positional
arguments matching config array order, with a rule that a `ref` property must
appear immediately after its target. It declared `field: "nLikes"` but never used
the name for lookup — the names were documentation, not data.

Target shape:

```ts
import { rank, score, explain } from '@youssefmahersi/ranking'

const ordered = rank(posts, { preset: 'social-feed' })
```

Requirements:

- **Object arguments, never positional.** Signal values are passed by name.
- **Collapse the `valuable` / `typeOfAdd` / `ref` triple.** One concept was spread
  across three fields, with `""` as a meaningful value. Additive terms are
  `{ field, weight }`. If a product of two signals is genuinely needed, express
  it as `{ field, multiplyBy }` — but consider whether accepting a user-supplied
  `(item) => number` is not simpler and more powerful than a miniature
  expression language.
- **`now` must be injectable.** `rank(items, { now })`. This is required both for
  SQL determinism (see §6) and for pagination stability (see §7).
- **The two halves must be separately accessible.** `log10(1 + Σ wᵢpᵢ)` does not
  depend on time and can be stored and indexed; the time penalty is applied at
  query time. Expose both, not only the final score.
- **`explain(item)`** returns the decomposition: contribution of each signal, the
  time penalty, the final score. This makes the "not AI" argument tangible, is
  useful for debugging, and demos in five seconds.
- **`toSQL(preset)`** emits the equivalent SQL expression. See §6 — this is the
  single most differentiating feature.
- **Deterministic tie-break** on a stable id, so equal scores never reorder
  between calls.
- Zero runtime dependencies. ESM and CJS. Strict TypeScript types.
  State the bundle size in the README.

## 6. Database integration

This is not a final step — it is an input constraint. If the code is written
first, the API will turn out not to translate to SQL.

**The core problem.** The score depends on `t = now − created_at`, so it changes
every second for every row simultaneously. A stored `score` column would be stale
immediately. A cron rewriting the whole table thrashes the index and is wrong
between runs. Computing with `now()` in the query forces a full table scan plus a
sort, because no index can help when the indexed values are no longer current.

**The question that decides everything:** does `now` cancel when comparing two
rows?

- **Power law** (`− g · log(t + t₀)`): time enters inside a log, so `now` does not
  cancel. Order genuinely depends on the current time — two items can swap over.
  That is the intended behaviour, but it forbids a static index.
- **Exponential family** (`+ created_epoch / τ`): time enters linearly, so `now`
  cancels entirely. Only the difference of publication dates matters, and that
  never changes. **Order is fixed permanently, therefore indexable.**

This is exactly why Reddit's formula is linear in time. It was not an accident.

### Strategy A — indexed generated column (high volume)

```sql
ALTER TABLE posts ADD COLUMN hot double precision
  GENERATED ALWAYS AS (
    log(1 + likes + 3*comments + 5*shares) + created_epoch / 45000.0
  ) STORED;

CREATE INDEX posts_hot_idx ON posts (hot DESC);
```

Then `SELECT * FROM posts ORDER BY hot DESC LIMIT 20`. Index scan, constant cost,
no maintenance. The column only recomputes when engagement changes — on a vote,
not on every second.

Two traps to document:

- Postgres requires generated columns to be immutable.
  `extract(epoch from created_at)` is not immutable on a `timestamptz`. Store a
  `created_epoch bigint` at insert time and generate from that.
- Offset the epoch (count from 2020 rather than 1970) to keep numbers smaller and
  preserve float precision.

`τ = 45000` seconds (~12.5 h) reads as: how many seconds of freshness are worth a
factor of ten in engagement. It is the single knob.

### Strategy B — bounded candidate set (power law)

```sql
SELECT *, log(1 + likes + 3*comments)
          - 1.5 * log(extract(epoch from now() - created_at)/3600 + 2) AS score
FROM posts
WHERE created_at > now() - interval '7 days'
ORDER BY score DESC
LIMIT 20;
```

The `WHERE` uses an ordinary index and reduces the candidate set to a few
thousand rows; sorting that handful is free. Valid whenever the relevance window
is bounded — true of a social feed, never of a product catalogue.

**Recommendation per preset:** `social-feed` → strategy A. `ecommerce` → strategy B
with a nightly batch recompute (catalogues are small and move slowly).

## 7. Where this library sits in an architecture

Large platforms do not solve the indexing problem. They avoid it, with a
multi-stage funnel: cheap indexable retrieval (100M → ~2000 candidates), light
ranking (→ ~500), heavy ranking, then filtering and diversity rules. **Time decay
lives in the heavy ranking stage, on a few hundred in-memory items — never in an
index.**

Twitter adds fanout-on-write: a post is pushed into followers' Redis lists at
publication, so reading a feed is reading a prepared list.

**This library is the rescoring stage, not the database sort.** Say so explicitly
in the README, with the funnel diagram. It resolves every tension above: on 500
in-memory items, indexability is irrelevant and the power law is perfectly
usable. `toSQL()` then serves candidate generation, not final ordering.

The commercial argument: large platforms have a four-stage funnel and an ML team.
You get the same ranking stage without the other three. For an app with 50,000
posts, stage one is a `WHERE` clause and stage three is this library.

### Pagination stability

Because the score depends on `t`, it changes between the page-1 query and the
page-2 query — items jump between pages or vanish. Under strategy A the problem
disappears (order is frozen). Under the power law, freeze a reference instant at
the start of the browsing session and carry it in the cursor.

This is a bug a user would spend three days diagnosing. Documenting it in one
section is worth more than any feature.

## 8. Scope — what this library will never do

Write this section into the README from day one. Saying no in advance costs far
less than saying no in an issue six months later.

Not in scope: personalisation, machine learning, embeddings, storage or
persistence, A/B testing infrastructure, diversity and dedupe rules,
negative-signal moderation logic.

One deliberate opt-in exception: Bayesian smoothing for star ratings in the
ecommerce preset. Without it a product with a single 5★ review beats one with 200
reviews averaging 4.8. It is a separate term, opt-in, never on the default path.

## 9. Tests — invariants, not values

Assert properties that survive constant changes:

- Score is strictly decreasing in `t` for fixed engagement
- Two items of equal age order by engagement
- Ranking order is identical before and after the log rewrite (compare against a
  naive `E / (t+t₀)^g` reference implementation)
- Zero engagement yields a finite score, and a fresh empty item outranks an old
  empty item
- `t < 0` raises rather than silently inverting the ranking
- `t = 0` does not divide by zero
- Tie-break is deterministic across repeated calls
- `toSQL()` output produces the same ordering as the JS implementation on a
  fixture dataset

## 10. Repository work

- Fix the package name. The README currently instructs
  `npm install --save rannkingalgorithm` (double *n*) while the import is
  `rankingalgorithm`. The first thing a visitor tries is broken. Since v2 breaks
  the API anyway, this is the moment to settle on a real name.
- The MIT badge links to another repository's LICENSE file
  (`tterb/atomic-design-ui`). Point it at this repo.
- Replace TSLint (deprecated since 2019) with ESLint + `typescript-eslint`.
- Add a GitHub Actions workflow and a build badge. Jest is already configured but
  never mentioned in the README and never run in CI.
- Commit the diagram images under `docs/` — they currently live on postimg.cc and
  will rot. GitHub renders LaTeX now, so the formula can be real text.
- Replace the Google Drive demo link with an inline GIF or a hosted playground.
- Publish as `2.0.0` with a CHANGELOG and a `1.x → 2.x` migration guide.
- Proofread the English. Current typos include "propreties", "medieum",
  "constatnt", "ordre", and "NW" where "NB" was meant.

## 11. Order of work

1. **Write the v2 README before any code.** Pitch, five-line quickstart, `rank()`
   signature, the two presets. If the quickstart is not readable at a glance, the
   API is wrong — and that will have been discovered without writing a line.
2. **Write the database section into that same README.** This is where the
   signature gets validated or rejected.
3. **Then the implementation**, once 1 and 2 are frozen.
4. Tests as invariants.
5. Repository hygiene and the 2.0.0 release.

Above the fold in the README: one sentence saying who it is for, a five-line code
block, a visible result. No theory before that. The asymptotic analysis and the
funnel discussion belong lower down or in `docs/`.
