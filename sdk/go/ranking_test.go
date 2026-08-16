// Invariants, not values. Every assertion here survives a change to the
// constants: retune a preset and these still pass, break the formula and they all
// fail.
package ranking_test

import (
	"errors"
	"math"
	"sort"
	"testing"
	"time"

	ranking "github.com/youssefmahersi/RankingAlgorithm/sdk/go/v2"
)

var now = time.Date(2026, 1, 15, 12, 0, 0, 0, time.UTC)

func hoursAgo(h float64) time.Time {
	return now.Add(-time.Duration(h * float64(time.Hour)))
}

func post(id string, ageHours float64, signals map[string]float64) ranking.Item {
	if signals == nil {
		signals = map[string]float64{}
	}
	return ranking.Item{ID: id, CreatedAt: hoursAgo(ageHours), Signals: signals}
}

func feed() ranking.Config {
	cfg := ranking.SocialFeed()
	cfg.Now = now
	return cfg
}

func mustScore(t *testing.T, item ranking.Item, cfg ranking.Config) float64 {
	t.Helper()
	value, err := ranking.Score(item, cfg)
	if err != nil {
		t.Fatalf("Score(%q): %v", item.ID, err)
	}
	return value
}

func mustRankIDs(t *testing.T, items []ranking.Item, cfg ranking.Config) []string {
	t.Helper()
	ordered, err := ranking.RankItems(items, cfg)
	if err != nil {
		t.Fatalf("RankItems: %v", err)
	}
	ids := make([]string, len(ordered))
	for i, item := range ordered {
		ids[i] = item.ID
	}
	return ids
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestScoreStrictlyDecreasingInTime(t *testing.T) {
	cfg := feed()
	ages := []float64{0, 0.5, 1, 2, 6, 24, 72, 240, 8760, 87600}
	previous := math.Inf(1)
	for _, age := range ages {
		value := mustScore(t, post("x", age, map[string]float64{"like": 42}), cfg)
		if value >= previous {
			t.Fatalf("score at %v h is %v, not below the previous %v", age, value, previous)
		}
		previous = value
	}
}

func TestNeverSaturates(t *testing.T) {
	// The v1 bug: its denominator tended to 1 + startValue, so time stopped
	// discriminating and a day-old item tied with a year-old one.
	cfg := feed()
	day := mustScore(t, post("a", 24, map[string]float64{"like": 100}), cfg)
	year := mustScore(t, post("b", 8760, map[string]float64{"like": 100}), cfg)
	if day-year <= 1 {
		t.Fatalf("a day-old and a year-old item are only %v apart; expected more than one decade", day-year)
	}
}

func TestGravityZeroIgnoresTime(t *testing.T) {
	cfg := feed()
	cfg.Gravity = 0
	a := mustScore(t, post("a", 1, map[string]float64{"like": 10}), cfg)
	b := mustScore(t, post("b", 100000, map[string]float64{"like": 10}), cfg)
	if a != b {
		t.Fatalf("with gravity 0 the ages must not matter: %v != %v", a, b)
	}
}

func TestEqualAgeOrdersByEngagement(t *testing.T) {
	items := []ranking.Item{
		post("low", 5, map[string]float64{"like": 2}),
		post("high", 5, map[string]float64{"like": 500}),
		post("mid", 5, map[string]float64{"like": 50}),
		post("comments", 5, map[string]float64{"comment": 30}),
	}
	want := []string{"high", "comments", "mid", "low"}
	if got := mustRankIDs(t, items, feed()); !equalStrings(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestMatchesNaiveReference(t *testing.T) {
	// The additive log form is algebraically log(A/B). Rewriting a division as a
	// subtraction of logs cannot change the order, because log is strictly
	// increasing — this is what makes that claim checkable rather than asserted.
	cfg := feed()
	seed := int64(20260115)
	random := func() float64 {
		seed = (seed*1103515245 + 12345) % 2147483648
		return float64(seed) / 2147483648
	}

	type sample struct {
		item ranking.Item
		age  float64
	}
	samples := make([]sample, 0, 100)
	items := make([]ranking.Item, 0, 100)
	for i := 0; i < 100; i++ {
		age := random() * 500
		item := ranking.Item{
			ID:        string(rune('a'+i/26)) + string(rune('a'+i%26)),
			CreatedAt: hoursAgo(age),
			Signals: map[string]float64{
				"like":    math.Floor(random() * 5000),
				"comment": math.Floor(random() * 300),
			},
		}
		items = append(items, item)
		samples = append(samples, sample{item: item, age: age})
	}

	naive := func(s sample) float64 {
		engagement := 1 + s.item.Signals["like"] + 3*s.item.Signals["comment"]
		return engagement / math.Pow(s.age+cfg.GraceHours, cfg.Gravity)
	}
	sort.SliceStable(samples, func(a, b int) bool {
		if naive(samples[a]) != naive(samples[b]) {
			return naive(samples[a]) > naive(samples[b])
		}
		return samples[a].item.ID < samples[b].item.ID
	})
	want := make([]string, len(samples))
	for i, s := range samples {
		want[i] = s.item.ID
	}

	if got := mustRankIDs(t, items, cfg); !equalStrings(got, want) {
		t.Fatalf("log form and naive reference disagree:\n got %v\nwant %v", got, want)
	}
}

func TestColdStart(t *testing.T) {
	cfg := feed()

	t.Run("zero engagement is finite", func(t *testing.T) {
		if value := mustScore(t, post("empty", 0, nil), cfg); math.IsInf(value, 0) || math.IsNaN(value) {
			t.Fatalf("score of an empty item is %v", value)
		}
		q, err := ranking.Quality(post("empty", 0, nil), cfg)
		if err != nil || q != 0 {
			t.Fatalf("quality of an empty item is %v (err %v), want 0", q, err)
		}
	})

	t.Run("fresh empty outranks old empty", func(t *testing.T) {
		// v1 multiplied the freshness boost by zero, so a new item with no
		// engagement never surfaced and therefore never received engagement.
		want := []string{"fresh", "old"}
		got := mustRankIDs(t, []ranking.Item{post("old", 240, nil), post("fresh", 0, nil)}, cfg)
		if !equalStrings(got, want) {
			t.Fatalf("got %v, want %v", got, want)
		}
	})

	t.Run("grace window is nearly flat", func(t *testing.T) {
		ratio, err := ranking.EngagementRatio(cfg.GraceHours/10, cfg)
		if err != nil {
			t.Fatal(err)
		}
		if ratio >= 1.2 {
			t.Fatalf("a tenth of the way through the grace window already costs %vx", ratio)
		}
	})

	t.Run("dynamic range is not front-loaded", func(t *testing.T) {
		// v1 fell from 5000x to under 10x inside the first 10% of its window.
		window, err := ranking.DecadeHours(cfg)
		if err != nil {
			t.Fatal(err)
		}
		early, _ := ranking.TimePenalty(window/10, cfg)
		start, _ := ranking.TimePenalty(0, cfg)
		if consumed := early - start; consumed <= 0.05 || consumed >= 0.35 {
			t.Fatalf("the first tenth of the window consumed %v of a decade", consumed)
		}
	})
}

func TestFutureItemsAreRejected(t *testing.T) {
	cfg := feed()
	_, err := ranking.Score(post("future", -1, map[string]float64{"like": 5}), cfg)
	if !errors.Is(err, ranking.ErrFutureItem) {
		t.Fatalf("got %v, want ErrFutureItem", err)
	}
}

func TestClampFutureTreatsThemAsBrandNew(t *testing.T) {
	cfg := feed()
	cfg.OnFutureItem = ranking.ClampFuture
	future := mustScore(t, post("future", -48, map[string]float64{"like": 5}), cfg)
	fresh := mustScore(t, post("now", 0, map[string]float64{"like": 5}), cfg)
	if future != fresh {
		t.Fatalf("clamped future item scored %v, brand-new item %v", future, fresh)
	}
}

func TestZeroAgeDoesNotDivideByZero(t *testing.T) {
	cfg := feed()
	if value := mustScore(t, post("new", 0, map[string]float64{"like": 1}), cfg); math.IsInf(value, 0) {
		t.Fatalf("score at t = 0 is %v", value)
	}

	cfg.GraceHours = 0
	if _, err := ranking.Score(post("new", 0, nil), cfg); !errors.Is(err, ranking.ErrInvalidConfig) {
		t.Fatalf("a grace window of zero must be rejected, got %v", err)
	}
}

func TestDeterministicTieBreak(t *testing.T) {
	cfg := feed()
	tied := []ranking.Item{
		post("zulu", 6, map[string]float64{"like": 10}),
		post("alpha", 6, map[string]float64{"like": 10}),
		post("mike", 6, map[string]float64{"like": 10}),
	}
	want := []string{"alpha", "mike", "zulu"}

	for i := 0; i < 20; i++ {
		if got := mustRankIDs(t, tied, cfg); !equalStrings(got, want) {
			t.Fatalf("run %d: got %v, want %v", i, got, want)
		}
	}

	reversed := []ranking.Item{tied[2], tied[1], tied[0]}
	if got := mustRankIDs(t, reversed, cfg); !equalStrings(got, want) {
		t.Fatalf("from a reversed input: got %v, want %v", got, want)
	}
}

func TestTieBreakFallsBackToInputPosition(t *testing.T) {
	cfg := feed()
	anonymous := []ranking.Item{
		{CreatedAt: hoursAgo(6), Signals: map[string]float64{"like": 10}},
		{CreatedAt: hoursAgo(6), Signals: map[string]float64{"like": 10}},
	}
	scored, err := ranking.RankWithScores(anonymous, ranking.Identity, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if scored[0].Score != scored[1].Score {
		t.Fatalf("identical items scored differently: %v vs %v", scored[0].Score, scored[1].Score)
	}
}

func TestRankDoesNotMutateInput(t *testing.T) {
	cfg := feed()
	items := []ranking.Item{
		post("a", 1, map[string]float64{"like": 1}),
		post("b", 1, map[string]float64{"like": 99}),
	}
	if _, err := ranking.RankItems(items, cfg); err != nil {
		t.Fatal(err)
	}
	if items[0].ID != "a" || items[1].ID != "b" {
		t.Fatalf("input was reordered: %v, %v", items[0].ID, items[1].ID)
	}
}

func TestRankPinsNowOnceForTheBatch(t *testing.T) {
	// With no injected clock the batch must still be internally consistent.
	same := time.Now().Add(-time.Hour)
	items := []ranking.Item{
		{ID: "a", CreatedAt: same, Signals: map[string]float64{"like": 7}},
		{ID: "b", CreatedAt: same, Signals: map[string]float64{"like": 7}},
	}
	scored, err := ranking.RankWithScores(items, ranking.Identity, ranking.SocialFeed())
	if err != nil {
		t.Fatal(err)
	}
	if scored[0].Score != scored[1].Score {
		t.Fatalf("identical items scored across a clock tick: %v vs %v", scored[0].Score, scored[1].Score)
	}
}

func TestTop(t *testing.T) {
	cfg := feed()
	items := []ranking.Item{
		post("a", 1, map[string]float64{"like": 1}),
		post("b", 1, map[string]float64{"like": 99}),
		post("c", 1, map[string]float64{"like": 50}),
	}
	best, err := ranking.Top(items, 2, ranking.Identity, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if len(best) != 2 || best[0].ID != "b" || best[1].ID != "c" {
		t.Fatalf("Top(2) returned %v", best)
	}
	if none, _ := ranking.Top(items, 0, ranking.Identity, cfg); len(none) != 0 {
		t.Fatalf("Top(0) returned %d items", len(none))
	}
	if all, _ := ranking.Top(items, 99, ranking.Identity, cfg); len(all) != 3 {
		t.Fatalf("Top(99) over 3 items returned %d", len(all))
	}
}

func TestRankWithAnAdapter(t *testing.T) {
	type Post struct {
		Slug      string
		Published time.Time
		Upvotes   float64
	}
	posts := []Post{
		{Slug: "quiet", Published: hoursAgo(1), Upvotes: 2},
		{Slug: "loud", Published: hoursAgo(1), Upvotes: 200},
	}
	cfg := feed()
	cfg.Signals = map[string]float64{"upvote": 1}

	ordered, err := ranking.Rank(posts, func(p Post) ranking.Item {
		return ranking.Item{ID: p.Slug, CreatedAt: p.Published, Signals: map[string]float64{"upvote": p.Upvotes}}
	}, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if ordered[0].Slug != "loud" {
		t.Fatalf("got %v first", ordered[0].Slug)
	}
}

func TestSeparableHalves(t *testing.T) {
	cfg := feed()
	item := post("x", 17, map[string]float64{"like": 33, "comment": 4})

	q, err := ranking.Quality(item, cfg)
	if err != nil {
		t.Fatal(err)
	}
	penalty, err := ranking.TimePenalty(17, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if got := mustScore(t, item, cfg); math.Abs(got-(q-penalty)) > 1e-12 {
		t.Fatalf("score %v != quality %v - penalty %v", got, q, penalty)
	}

	t.Run("quality is time-independent", func(t *testing.T) {
		fresh, _ := ranking.Quality(post("a", 0, map[string]float64{"like": 33}), cfg)
		ancient, _ := ranking.Quality(post("b", 9999, map[string]float64{"like": 33}), cfg)
		if fresh != ancient {
			t.Fatalf("%v != %v", fresh, ancient)
		}
	})

	t.Run("a stored quality is used as-is", func(t *testing.T) {
		stored := 4.2
		item := post("x", 10, map[string]float64{"like": 999999})
		item.StoredQuality = &stored
		if got, _ := ranking.Quality(item, cfg); got != 4.2 {
			t.Fatalf("got %v, want the stored 4.2", got)
		}
	})
}

func TestExplain(t *testing.T) {
	cfg := feed()
	item := post("x", 24, map[string]float64{"like": 100, "comment": 10, "share": 2})

	detail, err := ranking.Explain(item, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if math.Abs(detail.Quality-detail.TimePenalty-detail.Score) > 1e-12 {
		t.Fatalf("the parts do not add up: %v - %v != %v", detail.Quality, detail.TimePenalty, detail.Score)
	}
	if detail.Engagement != 140 {
		t.Fatalf("engagement is %v, want 100 + 3*10 + 5*2", detail.Engagement)
	}

	// Signals are reported in sorted order, as in every other SDK.
	wantOrder := []string{"comment", "like", "share"}
	for i, s := range detail.Signals {
		if s.Field != wantOrder[i] {
			t.Fatalf("signal %d is %q, want %q", i, s.Field, wantOrder[i])
		}
	}

	total := 0.0
	for _, s := range detail.Signals {
		total += s.Share
	}
	if math.Abs(total-1) > 1e-12 {
		t.Fatalf("shares sum to %v, want 1", total)
	}
}

func TestTuningProtocol(t *testing.T) {
	t.Run("SolveGravity inverts EngagementRatio", func(t *testing.T) {
		for _, tc := range []struct{ ratio, after float64 }{{47, 24}, {10, 6}, {2, 168}, {1000, 1}} {
			gravity, err := ranking.SolveGravity(tc.ratio, tc.after, 2)
			if err != nil {
				t.Fatal(err)
			}
			got, err := ranking.EngagementRatio(tc.after, ranking.Config{Gravity: gravity, GraceHours: 2})
			if err != nil {
				t.Fatal(err)
			}
			if math.Abs(got-tc.ratio) > 1e-9 {
				t.Fatalf("round trip for %vx at %v h gave %v", tc.ratio, tc.after, got)
			}
		}
	})

	t.Run("presets behave as documented", func(t *testing.T) {
		for _, tc := range []struct {
			cfg   ranking.Config
			hours float64
			want  float64
		}{
			{ranking.SocialFeed(), 24, 46.87},
			{ranking.SocialFeed(), 48, 125.0},
			{ranking.Ecommerce(), 90 * 24, 2.8},
			{ranking.Ecommerce(), 365 * 24, 4.23},
		} {
			got, err := ranking.EngagementRatio(tc.hours, tc.cfg)
			if err != nil {
				t.Fatal(err)
			}
			if math.Abs(got-tc.want) > 0.05 {
				t.Fatalf("at %v h: got %vx, want ~%vx", tc.hours, got, tc.want)
			}
		}
	})

	t.Run("DecadeHours is exactly ten times", func(t *testing.T) {
		cfg := ranking.SocialFeed()
		window, err := ranking.DecadeHours(cfg)
		if err != nil {
			t.Fatal(err)
		}
		got, _ := ranking.EngagementRatio(window, cfg)
		if math.Abs(got-10) > 1e-9 {
			t.Fatalf("at DecadeHours the ratio is %v, want 10", got)
		}

		cfg.Gravity = 0
		if flat, _ := ranking.DecadeHours(cfg); !math.IsInf(flat, 1) {
			t.Fatalf("with gravity 0 DecadeHours is %v, want +Inf", flat)
		}
	})
}

func TestBayesianSmoothing(t *testing.T) {
	one := ranking.Item{ID: "one", CreatedAt: hoursAgo(24), Signals: map[string]float64{"purchase": 10, "stars": 5, "reviews": 1}}
	many := ranking.Item{ID: "many", CreatedAt: hoursAgo(24), Signals: map[string]float64{"purchase": 10, "stars": 4.8, "reviews": 200}}

	plain := ranking.Ecommerce()
	plain.Now = now
	if mustScore(t, one, plain) != mustScore(t, many, plain) {
		t.Fatal("smoothing must be off by default")
	}

	smoothed := plain
	smoothed.Bayesian = &ranking.Bayesian{RatingField: "stars", CountField: "reviews", Prior: 3.8, PriorCount: 25, Weight: 12}
	want := []string{"many", "one"}
	if got := mustRankIDs(t, []ranking.Item{one, many}, smoothed); !equalStrings(got, want) {
		t.Fatalf("got %v, want %v — 200 reviews at 4.8 must beat a single 5-star review", got, want)
	}

	unreviewed := ranking.Item{ID: "x", CreatedAt: hoursAgo(24), Signals: map[string]float64{}}
	detail, err := ranking.Explain(unreviewed, smoothed)
	if err != nil {
		t.Fatal(err)
	}
	if detail.Bayesian == nil || detail.Bayesian.Smoothed != 3.8 {
		t.Fatalf("an unreviewed product must sit at the prior, got %+v", detail.Bayesian)
	}
}

func TestValidation(t *testing.T) {
	t.Run("unknown preset", func(t *testing.T) {
		if _, err := ranking.Preset("tiktok"); !errors.Is(err, ranking.ErrUnsupported) {
			t.Fatalf("got %v", err)
		}
	})

	t.Run("negative gravity", func(t *testing.T) {
		cfg := feed()
		cfg.Gravity = -1
		if _, err := ranking.Score(post("a", 1, nil), cfg); !errors.Is(err, ranking.ErrInvalidConfig) {
			t.Fatalf("got %v", err)
		}
	})

	t.Run("missing publication date", func(t *testing.T) {
		cfg := feed()
		item := ranking.Item{ID: "a", Signals: map[string]float64{"like": 1}}
		if _, err := ranking.Score(item, cfg); !errors.Is(err, ranking.ErrMissingDate) {
			t.Fatalf("got %v", err)
		}
	})

	t.Run("NaN signal", func(t *testing.T) {
		cfg := feed()
		item := post("a", 1, map[string]float64{"like": math.NaN()})
		if _, err := ranking.Score(item, cfg); !errors.Is(err, ranking.ErrInvalidItem) {
			t.Fatalf("got %v", err)
		}
	})

	t.Run("a missing signal counts as zero", func(t *testing.T) {
		cfg := feed()
		if q, err := ranking.Quality(post("a", 1, nil), cfg); err != nil || q != 0 {
			t.Fatalf("got %v, %v", q, err)
		}
	})

	t.Run("Rank needs an adapter", func(t *testing.T) {
		if _, err := ranking.Rank[ranking.Item](nil, nil, feed()); !errors.Is(err, ranking.ErrUnsupported) {
			t.Fatalf("got %v", err)
		}
	})
}

func TestPresetsReturnIndependentCopies(t *testing.T) {
	first := ranking.SocialFeed()
	first.Signals["like"] = 999
	if second := ranking.SocialFeed(); second.Signals["like"] != 1 {
		t.Fatalf("mutating one preset leaked into the next: like weight is %v", second.Signals["like"])
	}
}
