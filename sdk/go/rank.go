package ranking

import (
	"fmt"
	"sort"
)

// Adapter converts your own type into the shape the ranker needs.
type Adapter[T any] func(T) Item

// Identity is the Adapter for []Item itself.
func Identity(item Item) Item { return item }

// Scored is an item paired with its score, as returned by [RankWithScores].
type Scored[T any] struct {
	Item  T
	Score float64
}

// Rank orders items best-first.
//
// It returns a new slice; the input is not mutated. Ties break on Item.ID
// (ascending), then on input position, so repeated calls on the same data always
// produce the same order.
//
// Now is pinned once for the whole batch. Without that, the clock is read per
// item and a long slice can be scored across a tick, so two items with identical
// inputs would get different penalties.
func Rank[T any](items []T, adapt Adapter[T], cfg Config) ([]T, error) {
	scored, err := RankWithScores(items, adapt, cfg)
	if err != nil {
		return nil, err
	}
	out := make([]T, len(scored))
	for i, entry := range scored {
		out[i] = entry.Item
	}
	return out, nil
}

// RankWithScores is [Rank], keeping each item's score.
//
// Use it when you need the numbers downstream — a cursor, a debug column, a
// cutoff threshold — instead of recomputing them.
func RankWithScores[T any](items []T, adapt Adapter[T], cfg Config) ([]Scored[T], error) {
	if adapt == nil {
		return nil, fmt.Errorf("%w: Rank needs an Adapter; pass ranking.Identity for []Item", ErrUnsupported)
	}
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	now := cfg.now()

	type entry struct {
		index int
		id    string
		score float64
	}
	entries := make([]entry, len(items))
	for i, raw := range items {
		item := adapt(raw)
		value, err := score(item, now, cfg)
		if err != nil {
			return nil, err
		}
		entries[i] = entry{index: i, id: item.ID, score: value}
	}

	// Score descending, then ID ascending, then input position. Two items only
	// compare by ID when both carry one; the TypeScript, JavaScript and Python
	// SDKs use the same rule.
	sort.SliceStable(entries, func(a, b int) bool {
		x, y := entries[a], entries[b]
		if x.score != y.score {
			return x.score > y.score
		}
		if x.id != "" && y.id != "" && x.id != y.id {
			return x.id < y.id
		}
		return x.index < y.index
	})

	out := make([]Scored[T], len(entries))
	for i, e := range entries {
		out[i] = Scored[T]{Item: items[e.index], Score: e.score}
	}
	return out, nil
}

// RankItems is [Rank] for a slice that is already []Item.
func RankItems(items []Item, cfg Config) ([]Item, error) {
	return Rank(items, Identity, cfg)
}

// Top returns the best n items.
//
// It is still a full sort. This package is the rescoring stage of a funnel, sized
// for a few hundred to a few thousand in-memory candidates, not for a table scan;
// bound the candidate set in SQL first. See [ToSQL].
func Top[T any](items []T, n int, adapt Adapter[T], cfg Config) ([]T, error) {
	if n < 0 {
		return nil, fmt.Errorf("%w: Top needs a non-negative n, got %d", ErrUnsupported, n)
	}
	ordered, err := Rank(items, adapt, cfg)
	if err != nil {
		return nil, err
	}
	if n > len(ordered) {
		n = len(ordered)
	}
	return ordered[:n], nil
}

// sortedKeys returns a map's keys in ascending order, so that output built from
// a map is stable between runs.
func sortedKeys(m map[string]float64) []string {
	keys := make([]string, 0, len(m))
	for key := range m {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
