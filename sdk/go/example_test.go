package ranking_test

import (
	"fmt"
	"time"

	ranking "github.com/youssefmahersi/RankingAlgorithm/sdk/go/v2"
)

// A fixed instant, so the output is reproducible. In production leave Config.Now
// zero and it reads the clock.
var reference = time.Date(2026, 1, 15, 12, 0, 0, 0, time.UTC)

func ExampleRankItems() {
	items := []ranking.Item{
		{ID: "hour-old-good", CreatedAt: reference.Add(-1 * time.Hour),
			Signals: map[string]float64{"like": 40, "comment": 12, "share": 3}},
		{ID: "day-old-viral", CreatedAt: reference.Add(-24 * time.Hour),
			Signals: map[string]float64{"like": 900, "comment": 120, "share": 60}},
		{ID: "brand-new-empty", CreatedAt: reference,
			Signals: map[string]float64{}},
	}

	cfg := ranking.SocialFeed()
	cfg.Now = reference

	ordered, err := ranking.RankItems(items, cfg)
	if err != nil {
		panic(err)
	}
	for _, item := range ordered {
		fmt.Println(item.ID)
	}
	// Output:
	// hour-old-good
	// day-old-viral
	// brand-new-empty
}

// Rank works on your own types: pass an adapter and get your own values back, in
// order.
func ExampleRank() {
	type Post struct {
		Slug      string
		Published time.Time
		Upvotes   int
	}
	posts := []Post{
		{Slug: "quiet", Published: reference.Add(-time.Hour), Upvotes: 2},
		{Slug: "loud", Published: reference.Add(-time.Hour), Upvotes: 200},
	}

	cfg := ranking.SocialFeed()
	cfg.Now = reference
	cfg.Signals = map[string]float64{"upvote": 1}

	ordered, err := ranking.Rank(posts, func(p Post) ranking.Item {
		return ranking.Item{
			ID:        p.Slug,
			CreatedAt: p.Published,
			Signals:   map[string]float64{"upvote": float64(p.Upvotes)},
		}
	}, cfg)
	if err != nil {
		panic(err)
	}
	fmt.Println(ordered[0].Slug, ordered[1].Slug)
	// Output: loud quiet
}

func ExampleExplain() {
	item := ranking.Item{
		ID:        "hour-old-good",
		CreatedAt: reference.Add(-1 * time.Hour),
		Signals:   map[string]float64{"like": 40, "comment": 12, "share": 3},
	}
	cfg := ranking.SocialFeed()
	cfg.Now = reference

	detail, err := ranking.Explain(item, cfg)
	if err != nil {
		panic(err)
	}
	fmt.Printf("engagement  %.0f\n", detail.Engagement)
	fmt.Printf("quality     %.4f\n", detail.Quality)
	fmt.Printf("penalty     %.4f\n", detail.TimePenalty)
	fmt.Printf("score       %.4f\n", detail.Score)
	for _, s := range detail.Signals {
		fmt.Printf("  %-8s %.0f x %.1f = %.0f\n", s.Field, s.Value, s.Weight, s.Contribution)
	}
	// Output:
	// engagement  91
	// quality     1.9638
	// penalty     0.7157
	// score       1.2481
	//   comment  12 x 3.0 = 36
	//   like     40 x 1.0 = 40
	//   share    3 x 5.0 = 15
}

// SolveGravity turns a product question into a constant, instead of guessing.
func ExampleSolveGravity() {
	// "An item a day old should need 47x the engagement of a brand-new one."
	gravity, err := ranking.SolveGravity(47, 24, 2)
	if err != nil {
		panic(err)
	}
	fmt.Printf("gravity %.3f\n", gravity)

	// Check it the other way round.
	ratio, _ := ranking.EngagementRatio(24, ranking.Config{Gravity: gravity, GraceHours: 2})
	fmt.Printf("ratio at 24h %.1f\n", ratio)
	// Output:
	// gravity 1.501
	// ratio at 24h 47.0
}

func ExampleToSQL() {
	query, err := ranking.ToSQL(ranking.Ecommerce(), ranking.StrategyB, ranking.SQLOptions{
		Table: "products",
		Limit: 20,
	})
	if err != nil {
		panic(err)
	}
	fmt.Println(query)
	// Output:
	// -- Strategy B: exact power law over a bounded candidate set.
	// -- The WHERE clause uses an ordinary index on "created_at" and cuts the set to a few
	// -- thousand rows; sorting that handful is free.
	// SELECT *,
	//        log(1 + "cart" + 10.0 * "purchase" + 0.05 * "view") - 0.3 * log((extract(epoch from now() - "created_at") / 3600.0) + 72.0) AS score
	// FROM "products"
	// WHERE "created_at" > now() - interval '7 days'
	// ORDER BY score DESC
	// LIMIT 20;
}
