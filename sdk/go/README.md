# ranking — Go SDK

Deterministic, dependency-free ranking for feeds and catalogues.

```
score = log10(1 + Σ wᵢ·pᵢ) − g · log10(t + t₀)
```

Ranking you can audit, run inside a SQL query, and explain to a lawyer. Zero
dependencies, generics, Go 1.21+. Part of
[RankingAlgorithm v2](https://github.com/youssefmahersi/RankingAlgorithm); the
TypeScript, JavaScript and Python SDKs produce identical orderings.

```bash
go get github.com/youssefmahersi/RankingAlgorithm/sdk/go/v2
```

The `/v2` suffix is required by Go's module rules for major versions ≥ 2, and the
module lives in a subdirectory, so its tags carry the directory prefix
(`sdk/go/v2.0.0`). The release workflow pushes that tag automatically.

## Quickstart

```go
package main

import (
	"fmt"
	"time"

	ranking "github.com/youssefmahersi/RankingAlgorithm/sdk/go/v2"
)

func main() {
	now := time.Now()
	items := []ranking.Item{
		{ID: "a", CreatedAt: now.Add(-1 * time.Hour), Signals: map[string]float64{"like": 40, "comment": 12, "share": 3}},
		{ID: "b", CreatedAt: now.Add(-24 * time.Hour), Signals: map[string]float64{"like": 900, "comment": 120, "share": 60}},
		{ID: "c", CreatedAt: now, Signals: map[string]float64{}},
	}

	ordered, err := ranking.RankItems(items, ranking.SocialFeed())
	if err != nil {
		panic(err)
	}
	for _, item := range ordered {
		fmt.Println(item.ID)
	}
	// a — an hour old, decent engagement
	// b — a day old, viral, but 24 h costs it ~47x
	// c — brand new and empty, still rankable rather than stuck at zero
}
```

### Ranking your own type

`Rank` is generic over any slice; pass an adapter that projects your type onto
`Item`. Your original values come back, in order — nothing is copied into a map
you then have to unpack.

```go
type Post struct {
	Slug      string
	Published time.Time
	Likes     int
	Comments  int
}

ordered, err := ranking.Rank(posts, func(p Post) ranking.Item {
	return ranking.Item{
		ID:        p.Slug,
		CreatedAt: p.Published,
		Signals: map[string]float64{
			"like":    float64(p.Likes),
			"comment": float64(p.Comments),
		},
	}
}, ranking.SocialFeed())
```

## Presets

|  | `SocialFeed()` | `Ecommerce()` |
| --- | --- | --- |
| `Gravity` (g) | 1.5 | 0.3 |
| `GraceHours` (t₀) | 2 h | 72 h |
| Signals | like 1, comment 3, share 5 | view 0.05, cart 1, purchase 10 |

`SocialFeed` — a 24 h old item needs ~47× the engagement of a fresh one to tie,
~125× at 48 h. `Ecommerce` — a 90-day-old product needs only ~2.8× the sales of a
new one, ~4.2× over a full year.

Each call returns a fresh `Config` with its own `Signals` map, so mutating the
result cannot affect anyone else:

```go
cfg := ranking.SocialFeed()
cfg.Gravity = 2.0
cfg.Signals["quote"] = 4
```

`ranking.Preset("social-feed")` looks one up by name.

## Reading a score

One point of difference equals a factor of ten in engagement. Negative scores are
normal and carry no meaning — only the order matters.

## API

```go
func Rank[T any](items []T, adapt Adapter[T], cfg Config) ([]T, error)
func RankWithScores[T any](items []T, adapt Adapter[T], cfg Config) ([]Scored[T], error)
func RankItems(items []Item, cfg Config) ([]Item, error)
func Top[T any](items []T, n int, adapt Adapter[T], cfg Config) ([]T, error)

func Score(item Item, cfg Config) (float64, error)
func Quality(item Item, cfg Config) (float64, error)       // log10(1 + Σ) — time-independent
func TimePenalty(ageHours float64, cfg Config) (float64, error)
func AgeHours(item Item, cfg Config) (float64, error)
func Engagement(item Item, cfg Config) (float64, error)
func Explain(item Item, cfg Config) (Explanation, error)

func SolveGravity(ratio, afterHours, graceHours float64) (float64, error)
func EngagementRatio(afterHours float64, cfg Config) (float64, error)
func DecadeHours(cfg Config) (float64, error)
func TauSeconds(cfg Config) (float64, error)

func ToSQL(cfg Config, strategy Strategy, opts SQLOptions) (string, error)
func SQLExpression(cfg Config, strategy Strategy, opts SQLOptions) (string, error)

const Version, SpecVersion, Formula
```

### Errors

Every error wraps a sentinel, so you can branch with `errors.Is` instead of
matching on message text:

```go
ErrInvalidConfig  // negative gravity, zero grace window, non-finite weight
ErrFutureItem     // an item published after Now
ErrMissingDate    // a zero CreatedAt
ErrInvalidItem    // a NaN signal, an engagement sum below -1
ErrUnsupported    // unknown preset or dialect, un-translatable SQL, bad identifier
```

### `Config`

```go
type Config struct {
	Gravity      float64            // decay speed; 0 ignores time entirely
	GraceHours   float64            // t₀; must be > 0
	Signals      map[string]float64 // additive weights, by signal name
	Engagement   func(Item) float64 // replaces the weighted sum entirely
	Now          time.Time          // zero means time.Now()
	OnFutureItem FuturePolicy       // ErrorOnFuture (default) or ClampFuture
	Bayesian     *Bayesian          // opt-in star-rating smoothing
}
```

`Item.StoredQuality *float64` lets you feed back a precomputed `log10(1 + Σ)` from
an indexed column rather than re-reading the raw counts.

### `Explain`

```go
detail, _ := ranking.Explain(item, ranking.SocialFeed())
detail.Quality      // 1.9638 — log10(1 + 91)
detail.TimePenalty  // 0.7157 — 1.5 · log10(1 + 2)
detail.Score        // 1.2481
for _, s := range detail.Signals {
	fmt.Println(s.Field, s.Contribution, s.Share)
}
```

Signals are reported in sorted field order, identically in all four SDKs — Go maps
have no iteration order, so sorting is what makes the output reproducible.

### Tuning

Do not tune by trial and error. Answer one product question — *an item X hours
old, how many times more engagement must it have to beat a brand-new one?* — and
invert it:

```go
gravity, _ := ranking.SolveGravity(47, 24, 2)  // 1.5009…
```

Set `GraceHours` first, then solve for gravity. The two interact strongly: raising
`GraceHours` flattens the entire time penalty, not just the early window, so
re-solve gravity whenever you change it.

### Future-dated items

An item published after `Now` gives `t < 0`, which would silently invert the
ranking, so it returns `ErrFutureItem`. Set `OnFutureItem: ranking.ClampFuture` to
admit scheduled content as brand new instead.

### Pagination stability

The score depends on `t`, so it changes between the page-1 and page-2 queries and
items jump between pages. Freeze a reference instant at the start of the session
and carry it in the cursor:

```go
cfg := ranking.SocialFeed()
cfg.Now = cursor.StartedAt
page, err := ranking.RankItems(candidates, cfg)
```

`Rank` also pins `Now` once per call, so a long slice is never scored across a
clock tick.

## SQL

```go
ddl, _ := ranking.ToSQL(ranking.SocialFeed(), ranking.StrategyA, ranking.SQLOptions{Table: "posts"})
query, _ := ranking.ToSQL(ranking.Ecommerce(), ranking.StrategyB, ranking.SQLOptions{Table: "products"})
```

Postgres and MySQL. The zero `SQLOptions` is usable. Which strategy applies, and
why the choice is forced rather than a preference, is covered in the
[root README](https://github.com/youssefmahersi/RankingAlgorithm#database-integration).

## Scope

Not in scope, permanently: personalisation, machine learning, embeddings, storage,
A/B testing infrastructure, diversity and dedupe rules, moderation logic. The one
deliberate exception is the opt-in `Bayesian` term for star ratings.

## License

MIT
