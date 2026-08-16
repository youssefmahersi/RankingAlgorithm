# Migrating from 1.x to 2.x

**Short version:** replace the constructor with a call to `rank()`, name your
signals, and delete `valuable` / `typeOfAdd` / `ref`. It is usually a five-line
change. The rest of this document explains what changed underneath, and how to
confirm the new ordering is the one you want before you ship it.

Nothing here is urgent. The v1 API still runs from a `/legacy` entry point and is
removed in **3.0.0**.

---

## 1. The five-line change

**v1**

```js
const { RankingAlgorithm } = require('rankingalgorithm')

const rankingAlgo = new RankingAlgorithm(8, 0.0002, [
  { field: 'nLikes',    valuable: true,  typeOfAdd: 'Multiplication', ref: '' },
  { field: 'audience',  valuable: false, typeOfAdd: '',               ref: 'nLikes' },
  { field: 'nComments', valuable: false, typeOfAdd: '',               ref: '' },
])

const score = rankingAlgo.calc(post.nLikes, post.audience, post.nComments, t)
// then sort your array by score yourself
```

**v2**

```js
import { rank } from '@youssefmahersi/ranking'

const ordered = rank(posts, {
  signals: { nLikes: 1, nComments: 3 },
  graceHours: 2,
  gravity: 1.5,
  dateField: 'createdAt',
})
```

Or, if your signals are likes/comments/shares on a feed, just:

```js
const ordered = rank(posts, { preset: 'social-feed' })
```

## 2. What each v1 concept became

| v1 | v2 | Why |
| --- | --- | --- |
| `new RankingAlgorithm(stretch, startValue, config)` | `rank(items, options)` | v2 sorts for you; v1 only scored one item at a time |
| positional `calc(a, b, c, t)` | fields read by name off the item | v1 declared `field: "nLikes"` but never looked anything up by it — the names were documentation, not data |
| `stretch` | `graceHours` (t₀) | see §3 |
| `startValue` | `gravity` (g) | see §3 |
| `{ valuable, typeOfAdd, ref }` | `{ signal: weight }` | one concept spread across three fields, with `""` as a meaningful value |
| `typeOfAdd: 'Multiplication'` + `ref` | `engagement: (item) => …` | a callback is simpler and more powerful than a miniature expression language |
| `t` passed in by hand | `createdAt` on the item, `now` injectable | needed for SQL parity and pagination stability |
| sort the scores yourself | `rank()` / `rankWithScores()` | includes a deterministic tie-break |

### The `ref` triple

v1's only genuine feature here was multiplying two signals — `nLikes × audience`.
There is no `multiplyBy` in v2 because a function covers that case and every
other one:

```js
rank(posts, {
  signals: { nComments: 1 },
  engagement: (post) => post.nLikes * post.audience + post.nComments,
})
```

Note that `engagement` **replaces** the weighted sum entirely, and cannot be
translated to SQL — `toSQL()` will tell you so rather than emitting something
wrong. If you need SQL, express it as weights.

Also consider whether you want that product at all. `likes × audience` is
quadratic in popularity; the `log10` on the numerator exists precisely because
engagement is power-law distributed and large items otherwise crush everything
else.

## 3. `stretch` and `startValue` do not convert

There is no formula that maps your old constants onto new ones, because the old
pair did not mean what it looked like:

- `startValue` set the peak of the curve (`1/v`) **and** participated in its knee
  (via `v·s`). The two knobs were not orthogonal, so tuning one silently moved the
  other.
- With `startValue = 0.0002`, ~99.8% of the freshness boost was consumed in the
  first 10% of the tuning window. `stretch` therefore controlled only the region
  where nothing happened.

So do not port the numbers. Derive new ones from a product question instead:

> An item **X** hours old — how many times more engagement must it have to beat a
> brand-new one?

```js
import { solveGravity, engagementRatio } from '@youssefmahersi/ranking'

// "a day-old post should need about 47x the engagement of a fresh one"
const gravity = solveGravity({ ratio: 47, afterHours: 24, graceHours: 2 })  // 1.5009…

// check it the other way round
engagementRatio(48, { gravity, graceHours: 2 })   // 125.0
```

Set `graceHours` first — *"how long does content get to start?"* — then solve for
gravity. **They interact strongly:** raising `graceHours` flattens the entire time
penalty, not just the early window, so re-solve gravity whenever you change it.

If you have no strong opinion, start from a preset. That is what they are for.

## 4. Behaviour that will genuinely change

Expect your feed to look different. Four differences are intended:

**Old content now keeps decaying.** v1 saturated: past a few multiples of
`stretch`, a day-old item and a year-old item with equal engagement scored the
same. If your feed has a tail of ancient high-engagement posts that never quite
went away, they will now sink.

**Empty new items surface.** v1 multiplied the freshness boost by zero, so an item
with no engagement scored zero regardless of age and could never surface — and so
never received engagement. In v2 a brand-new empty item gets a real score and a
real position.

**Scores are on a completely different scale, and are often negative.** v1 scores
ran into the thousands. v2 scores are logarithmic: one point of difference equals
a factor of ten in engagement, and negative values are normal and carry no
meaning. **If you stored v1 scores in a column, they are not comparable** — drop
the column or recompute it. Only the order matters.

**Ties are now deterministic.** Equal scores break on a stable id, then on input
position, so repeated calls on the same data always produce the same order.

### Confirming the new ordering before you ship

The v1 shim exists mainly for this: score the same fixtures both ways and diff the
orderings on real data.

```js
import { RankingAlgorithm } from '@youssefmahersi/ranking/legacy'
import { rank } from '@youssefmahersi/ranking'

const old = [...posts].sort((a, b) => legacyScore(b) - legacyScore(a)).map((p) => p.id)
const now = rank(posts, { preset: 'social-feed' }).map((p) => p.id)

console.table(old.map((id, i) => ({ rank: i + 1, v1: id, v2: now[i] })))
```

## 5. Things v2 will now reject

v1 was silent about bad input. v2 raises, because each of these produced a wrong
ranking rather than an obvious failure:

| Input | v2 behaviour |
| --- | --- |
| An item published after `now` (`t < 0`) | Raises. A negative age silently inverts the ranking. Pass `onFutureItem: 'clamp'` to admit scheduled content as brand new. |
| `graceHours: 0` | Raises. It is what keeps `log10(t + t₀)` finite at `t = 0`. |
| A negative `gravity` | Raises. It would rank old items first. |
| A non-numeric signal value | Raises, naming the field. |
| An unknown preset name | Raises, listing the real ones. |
| A missing publication date | Raises, naming the field it looked for. |
| A missing signal | **Counts as zero.** This one is not an error. |

## 6. Package names

| | 1.x | 2.x |
| --- | --- | --- |
| npm | `rankingalgorithm` | `@youssefmahersi/ranking` |
| npm, zero-build ESM | — | `@youssefmahersi/ranking-js` |
| PyPI | — | `rankingalgorithm` |
| Go | — | `github.com/youssefmahersi/RankingAlgorithm/sdk/go/v2` |

The 1.x README instructed `npm install --save rannkingalgorithm` — with a double
*n* — while the import was `rankingalgorithm`. The first thing a visitor tried was
broken. Since 2.0.0 breaks the API anyway, this was the moment to settle on a real
name.

## 7. Using the v1 API in the meantime

Preserved bug-for-bug, including the positional-argument rule that a `ref`
property must appear immediately after its target. It emits a deprecation notice
once per process.

```js
// TypeScript / JavaScript
import { RankingAlgorithm } from '@youssefmahersi/ranking/legacy'
```

```python
# Python — there was never a Python v1; this exists so you can diff orderings
from rankingalgorithm.legacy import RankingAlgorithm
```

There is no Go shim. Go had no v1.

**Removed in 3.0.0.**

## Questions

Open an issue: <https://github.com/youssefmahersi/RankingAlgorithm/issues>
