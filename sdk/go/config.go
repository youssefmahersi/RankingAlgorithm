package ranking

import (
	"fmt"
	"math"
	"time"
)

// Item is the shape the ranker needs. Adapt your own type into it with [Rank].
type Item struct {
	// ID is a stable identifier, used for the deterministic tie-break. Items
	// with equal scores order by ID ascending; an empty ID falls back to input
	// position.
	ID string

	// CreatedAt is the publication date. The zero value is rejected.
	CreatedAt time.Time

	// Signals are the engagement counts, keyed by the same names used in
	// Config.Signals. A signal that is absent counts as zero.
	Signals map[string]float64

	// StoredQuality, when non-nil, is used instead of recomputing
	// log10(1 + Σ wᵢ·pᵢ). Set it when you keep the time-independent half in an
	// indexed column and want to avoid re-reading the raw counts.
	StoredQuality *float64
}

// FuturePolicy decides what happens to an item published after Now.
type FuturePolicy int

const (
	// ErrorOnFuture rejects the item. This is the default: a negative age
	// silently inverts the ranking, which is worse than a loud failure.
	ErrorOnFuture FuturePolicy = iota

	// ClampFuture treats a future-dated item as brand new. Use it when you
	// deliberately publish scheduled content ahead of time.
	ClampFuture
)

// Bayesian configures opt-in smoothing for star ratings.
//
// Without it a product with a single 5-star review outranks one with 200 reviews
// averaging 4.8. The smoothed rating pulls low-count averages towards Prior:
//
//	smoothed = (PriorCount*Prior + count*average) / (PriorCount + count)
//
// The result enters the engagement sum as one more additive term, weighted by
// Weight. RatingField and CountField name entries in Item.Signals.
type Bayesian struct {
	RatingField string
	CountField  string
	Prior       float64
	PriorCount  float64
	Weight      float64
}

// Config is a resolved ranking configuration. Build one from a preset —
// [SocialFeed], [Ecommerce] — and adjust the fields you care about.
type Config struct {
	// Gravity (g) is the decay speed. Zero ignores time entirely.
	Gravity float64

	// GraceHours (t₀) is the window during which the age penalty is negligible,
	// so new content can accumulate its first signals. Must be > 0; it is also
	// what keeps log10(t + t₀) finite at t = 0.
	GraceHours float64

	// Signals are the additive weights, by signal name.
	Signals map[string]float64

	// Engagement, when non-nil, replaces the weighted sum entirely. It cannot be
	// translated to SQL.
	Engagement func(Item) float64

	// Now is the reference instant. The zero value means time.Now(). Injecting
	// it is required for tests, for SQL parity and for pagination stability.
	Now time.Time

	// OnFutureItem decides what happens when an item's age is negative.
	OnFutureItem FuturePolicy

	// Bayesian enables opt-in smoothing of star ratings. Nil by default.
	Bayesian *Bayesian
}

// SocialFeed returns the social-feed preset.
//
// A 24 h old item needs ~47x the engagement of a fresh one to tie, ~125x at 48 h.
// Content is effectively dead in two days.
//
// Each call returns a fresh Config with its own Signals map, so mutating the
// result cannot affect anyone else.
func SocialFeed() Config {
	return Config{
		Gravity:    1.5,
		GraceHours: 2,
		Signals:    map[string]float64{"like": 1, "comment": 3, "share": 5},
	}
}

// Ecommerce returns the ecommerce preset.
//
// A 90-day-old product needs only ~2.8x the sales of a new one, and over a full
// year the penalty reaches only ~4.2x — a genuine best-seller stays on top for
// years while remaining separable by age.
func Ecommerce() Config {
	return Config{
		Gravity:    0.3,
		GraceHours: 72,
		Signals:    map[string]float64{"view": 0.05, "cart": 1, "purchase": 10},
	}
}

// Preset returns a preset by name: "social-feed" or "ecommerce".
func Preset(name string) (Config, error) {
	switch name {
	case "social-feed":
		return SocialFeed(), nil
	case "ecommerce":
		return Ecommerce(), nil
	default:
		return Config{}, fmt.Errorf("%w: unknown preset %q, available: social-feed, ecommerce", ErrUnsupported, name)
	}
}

// Validate reports whether the configuration can be used. Every public entry
// point calls it, so you rarely need to.
func (c Config) Validate() error {
	if math.IsNaN(c.Gravity) || math.IsInf(c.Gravity, 0) {
		return fmt.Errorf("%w: gravity must be finite, got %v", ErrInvalidConfig, c.Gravity)
	}
	if c.Gravity < 0 {
		return fmt.Errorf("%w: gravity must be >= 0, got %v (a negative gravity ranks old items first)", ErrInvalidConfig, c.Gravity)
	}
	if math.IsNaN(c.GraceHours) || math.IsInf(c.GraceHours, 0) || c.GraceHours <= 0 {
		return fmt.Errorf("%w: graceHours must be > 0, got %v (it is what keeps log10(t + t0) finite at t = 0)", ErrInvalidConfig, c.GraceHours)
	}
	for name, weight := range c.Signals {
		if math.IsNaN(weight) || math.IsInf(weight, 0) {
			return fmt.Errorf("%w: weight for signal %q must be finite, got %v", ErrInvalidConfig, name, weight)
		}
	}
	if c.OnFutureItem != ErrorOnFuture && c.OnFutureItem != ClampFuture {
		return fmt.Errorf("%w: onFutureItem must be ErrorOnFuture or ClampFuture", ErrInvalidConfig)
	}
	if b := c.Bayesian; b != nil {
		for label, v := range map[string]float64{"prior": b.Prior, "priorCount": b.PriorCount, "weight": b.Weight} {
			if math.IsNaN(v) || math.IsInf(v, 0) {
				return fmt.Errorf("%w: bayesian.%s must be finite, got %v", ErrInvalidConfig, label, v)
			}
		}
		if b.PriorCount < 0 {
			return fmt.Errorf("%w: bayesian.priorCount must be >= 0, got %v", ErrInvalidConfig, b.PriorCount)
		}
	}
	return nil
}

// now resolves the reference instant, pinning it once per batch.
func (c Config) now() time.Time {
	if c.Now.IsZero() {
		return time.Now()
	}
	return c.Now
}
