// Package ranking implements deterministic, dependency-free ranking for feeds
// and catalogues.
//
//	score = log10(1 + Σ wᵢ·pᵢ) − g · log10(t + t₀)
//
// Ranking you can audit, run inside a SQL query, and explain to a lawyer. There
// is no model, no embedding, no inference cost and no per-request latency; the
// same inputs always produce the same order.
//
// # Quickstart
//
//	items := []ranking.Item{
//		{ID: "a", CreatedAt: hourAgo, Signals: map[string]float64{"like": 40, "comment": 12}},
//		{ID: "b", CreatedAt: dayAgo, Signals: map[string]float64{"like": 900, "comment": 120}},
//	}
//	ordered, err := ranking.RankItems(items, ranking.SocialFeed())
//
// To rank your own type, pass an adapter:
//
//	ordered, err := ranking.Rank(posts, func(p Post) ranking.Item {
//		return ranking.Item{
//			ID:        p.ID,
//			CreatedAt: p.CreatedAt,
//			Signals:   map[string]float64{"like": float64(p.Likes)},
//		}
//	}, ranking.SocialFeed())
//
// # Reading a score
//
// One point of difference equals a factor of ten in engagement. Negative scores
// are normal and carry no meaning — only the order matters.
//
// This package is the rescoring stage of a retrieval funnel, sized for a few
// hundred to a few thousand in-memory candidates. Use [ToSQL] to generate the
// candidate set; do not use it as the database sort.
package ranking
