# rankingalgorithm — Python SDK

Deterministic, dependency-free ranking for feeds and catalogues.

```
score = log10(1 + Σ wᵢ·pᵢ) − g · log10(t + t₀)
```

Ranking you can audit, run inside a SQL query, and explain to a lawyer. No
embeddings, no model, no inference cost, no vector database — and no per-request
latency. Part of [RankingAlgorithm v2](https://github.com/youssefmahersi/RankingAlgorithm);
the TypeScript, JavaScript and Go SDKs produce identical orderings.

```bash
pip install rankingalgorithm
```

## Quickstart

```python
from datetime import datetime, timedelta, timezone
from rankingalgorithm import rank

now = datetime.now(timezone.utc)
posts = [
    {"id": "a", "createdAt": now - timedelta(hours=1),  "like": 40,  "comment": 12, "share": 3},
    {"id": "b", "createdAt": now - timedelta(hours=24), "like": 900, "comment": 120, "share": 60},
    {"id": "c", "createdAt": now,                       "like": 0,   "comment": 0,  "share": 0},
]

for post in rank(posts, "social-feed"):
    print(post["id"])
# a  — an hour old, decent engagement
# b  — a day old, viral, but 24 h costs it ~47x
# c  — brand new and empty, still rankable rather than stuck at zero
```

`rank(items)` with no arguments uses the `social-feed` preset. Presets are the
product; configuration is the advanced option.

## Presets

|                | `social-feed`               | `ecommerce`                        |
| -------------- | --------------------------- | ---------------------------------- |
| `gravity` (g)  | 1.5                         | 0.3                                |
| `grace_hours`  | 2 h                         | 72 h                               |
| signals        | like 1, comment 3, share 5  | view 0.05, cart 1, purchase 10     |

`social-feed` — a 24 h old item needs ~47× the engagement of a fresh one to tie,
~125× at 48 h. Content is effectively dead in two days.

`ecommerce` — a 90-day-old product needs only ~2.8× the sales of a new one, and
over a full year the penalty reaches only ~4.2×, so a genuine best-seller stays on
top for years while remaining separable by age.

Both presets read the publication date from `createdAt`, matching the shared
cross-SDK fixture. Pass `date_field="created_at"` for the Python-native spelling.

## Reading a score

One point of difference equals a factor of ten in engagement. Negative scores are
normal and carry no meaning — only the order matters.

## API

```python
rank(items, config=None, **overrides)              # -> list, best first
rank_with_scores(items, config=None, **overrides)  # -> list[Scored], keeps the numbers
top(items, n, config=None, **overrides)            # -> list, best n

score(item, config=None, **overrides)              # -> float
quality(item, config=None, **overrides)            # -> log10(1 + Σ), time-independent
time_penalty(age_hours, config=None, **overrides)  # -> g · log10(t + t₀)
age_hours(item, config=None, **overrides)          # -> float
explain(item, config=None, **overrides)            # -> Explanation

solve_gravity(ratio, after_hours, grace_hours)     # the tuning protocol
engagement_ratio(after_hours, config=None, ...)    # its inverse, for sanity checks
decade_hours(config=None, **overrides)             # when the penalty is worth 10x
to_sql(config=None, strategy="B", **kwargs)        # -> str
```

`config` is a preset name, a `Config`, or `None`. Keyword arguments override
individual fields, and an unknown keyword raises rather than being silently
ignored:

```python
rank(posts, "social-feed", gravity=2.0, now=fixed_instant)
rank(posts, gravity=0.8, grace_hours=6, signals={"upvote": 1, "reply": 2.5})
```

Items may be dicts or plain objects — fields are read with `item[field]` or
`getattr`, whichever applies.

### `explain()`

```python
detail = explain(posts[0], "social-feed")
detail.quality        # 1.9637…  log10(1 + 91)
detail.time_penalty   # 0.7156…  1.5 · log10(1 + 2)
detail.score          # 1.2481…
[(s.field, s.contribution) for s in detail.signals]
# [('like', 40.0), ('comment', 36.0), ('share', 15.0)]
detail.to_dict()      # for logging
```

### Tuning

Do not tune by trial and error. Answer one product question — *an item X hours
old, how many times more engagement must it have to beat a brand-new one?* — and
invert it:

```python
solve_gravity(ratio=47, after_hours=24, grace_hours=2)   # 1.5009…
```

Set `grace_hours` first ("how long does content get to start?"), then solve for
gravity. The two interact strongly: raising `grace_hours` flattens the whole time
penalty, not just the early window, so re-solve gravity whenever you change it.

### Dates

A `datetime` (naive values are read as UTC), an ISO 8601 string, or **epoch
seconds** as a number — the `time.time()` convention. The JavaScript and
TypeScript SDKs take epoch *milliseconds* instead, each following its own
language's convention; every SDK agrees on ISO strings, which is what the shared
fixture uses.

`now` is injectable everywhere. You need that for tests, for SQL parity, and for
pagination stability.

### Future-dated items

An item published after `now` gives `t < 0`, which would silently invert the
ranking, so it raises. Pass `on_future_item="clamp"` to treat scheduled content as
brand new instead.

### Bayesian smoothing (opt-in)

Without it, a product with a single 5★ review beats one with 200 reviews averaging
4.8. It is a separate term, off by default, never on the default path:

```python
from rankingalgorithm import Bayesian, rank

rank(products, "ecommerce", bayesian=Bayesian(
    rating_field="stars", count_field="reviews",
    prior=3.8, prior_count=25, weight=12,
))
```

## SQL

```python
print(to_sql("social-feed", "A", table="posts"))   # indexed generated column
print(to_sql("ecommerce", "B", table="products"))  # exact power law, bounded window
```

Which strategy applies, and why the choice is forced rather than a preference, is
covered in the [root README](https://github.com/youssefmahersi/RankingAlgorithm#database-integration).

## Scope

Not in scope, permanently: personalisation, machine learning, embeddings, storage,
A/B testing infrastructure, diversity and dedupe rules, moderation logic. The one
deliberate exception is the opt-in Bayesian term above.

## License

MIT
