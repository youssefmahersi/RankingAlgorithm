package ranking

import (
	"fmt"
	"math"
	"time"
)

// SignalBreakdown is one signal's contribution to the engagement sum.
type SignalBreakdown struct {
	Field        string
	Value        float64
	Weight       float64
	Contribution float64 // Weight * Value
	Share        float64 // fraction of the engagement sum, in [0, 1]
}

// BayesianBreakdown is the smoothing term, when it is enabled.
type BayesianBreakdown struct {
	Average      float64
	Count        float64
	Smoothed     float64
	Weight       float64
	Contribution float64
}

// Explanation is the full decomposition of a score, as returned by [Explain].
type Explanation struct {
	ID string

	// Engagement is Σ wᵢ·pᵢ, before the log.
	Engagement float64
	Signals    []SignalBreakdown
	Bayesian   *BayesianBreakdown

	// Quality is log10(1 + Engagement): time-independent, storable, indexable.
	Quality float64

	AgeHours float64

	// TimePenalty is g · log10(t + t₀). It is subtracted from Quality.
	TimePenalty float64

	Score      float64
	Gravity    float64
	GraceHours float64
	Formula    string
}

// bayesianTerm returns the smoothing term, or nil when it is disabled.
//
// It is kept separate from the weighted sum so that Explain can report it on its
// own line: it is an opt-in exception to "no ML, no heuristics", and hiding it
// inside the signal list would misrepresent the score.
func bayesianTerm(item Item, cfg Config) (*BayesianBreakdown, error) {
	b := cfg.Bayesian
	if b == nil {
		return nil, nil
	}
	average, err := signalOf(item, b.RatingField)
	if err != nil {
		return nil, err
	}
	count, err := signalOf(item, b.CountField)
	if err != nil {
		return nil, err
	}
	denominator := b.PriorCount + count
	smoothed := b.Prior
	if denominator != 0 {
		smoothed = (b.PriorCount*b.Prior + count*average) / denominator
	}
	return &BayesianBreakdown{
		Average:      average,
		Count:        count,
		Smoothed:     smoothed,
		Weight:       b.Weight,
		Contribution: b.Weight * smoothed,
	}, nil
}

// signalOf reads a signal, treating an absent one as zero.
func signalOf(item Item, field string) (float64, error) {
	value := item.Signals[field]
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return 0, fmt.Errorf("%w: signal %q of item %q must be finite, got %v", ErrInvalidItem, field, item.ID, value)
	}
	return value, nil
}

// Engagement returns Σ wᵢ·pᵢ, the raw pre-log engagement of an item.
func Engagement(item Item, cfg Config) (float64, error) {
	if err := cfg.Validate(); err != nil {
		return 0, err
	}
	return engagement(item, cfg)
}

func engagement(item Item, cfg Config) (float64, error) {
	if cfg.Engagement != nil {
		value := cfg.Engagement(item)
		if math.IsNaN(value) || math.IsInf(value, 0) {
			return 0, fmt.Errorf("%w: the Engagement func returned %v for item %q, which must be finite", ErrInvalidItem, value, item.ID)
		}
		return value, nil
	}
	total := 0.0
	for field, weight := range cfg.Signals {
		value, err := signalOf(item, field)
		if err != nil {
			return 0, err
		}
		total += weight * value
	}
	term, err := bayesianTerm(item, cfg)
	if err != nil {
		return 0, err
	}
	if term != nil {
		total += term.Contribution
	}
	return total, nil
}

// Quality returns log10(1 + Σ wᵢ·pᵢ), the time-independent half of the score.
//
// This is the half you can store in a column and index: it only changes when
// engagement changes, not on every tick of the clock. If Item.StoredQuality is
// set, it is returned as-is.
func Quality(item Item, cfg Config) (float64, error) {
	if err := cfg.Validate(); err != nil {
		return 0, err
	}
	return quality(item, cfg)
}

func quality(item Item, cfg Config) (float64, error) {
	if item.StoredQuality != nil {
		return *item.StoredQuality, nil
	}
	total, err := engagement(item, cfg)
	if err != nil {
		return 0, err
	}
	if total < -1 {
		return 0, fmt.Errorf("%w: engagement sum for item %q is %v; log10(1 + sum) is undefined below -1", ErrInvalidItem, item.ID, total)
	}
	return math.Log10(1 + total), nil
}

// TimePenalty returns g · log10(t + t₀), the time-dependent half of the score.
//
// It is subtracted, and it is negative while t + t₀ < 1. Only differences between
// items matter, so the sign carries no meaning.
func TimePenalty(ageHours float64, cfg Config) (float64, error) {
	if err := cfg.Validate(); err != nil {
		return 0, err
	}
	age, err := checkAge(ageHours, cfg, "")
	if err != nil {
		return 0, err
	}
	return timePenalty(age, cfg), nil
}

func timePenalty(ageHours float64, cfg Config) float64 {
	if cfg.Gravity == 0 {
		return 0
	}
	return cfg.Gravity * math.Log10(ageHours+cfg.GraceHours)
}

func checkAge(ageHours float64, cfg Config, id string) (float64, error) {
	if math.IsNaN(ageHours) || math.IsInf(ageHours, 0) {
		return 0, fmt.Errorf("%w: age of item %q must be finite, got %v", ErrInvalidItem, id, ageHours)
	}
	if ageHours < 0 {
		if cfg.OnFutureItem == ClampFuture {
			return 0, nil
		}
		return 0, fmt.Errorf("%w: item %q has age %v hours relative to Now; set OnFutureItem to ClampFuture to admit it as brand new", ErrFutureItem, id, ageHours)
	}
	return ageHours, nil
}

// AgeHours returns an item's age in hours at cfg.Now, validated against the
// future policy.
func AgeHours(item Item, cfg Config) (float64, error) {
	if err := cfg.Validate(); err != nil {
		return 0, err
	}
	return ageHours(item, cfg.now(), cfg)
}

func ageHours(item Item, now time.Time, cfg Config) (float64, error) {
	if item.CreatedAt.IsZero() {
		return 0, fmt.Errorf("%w: item %q has a zero CreatedAt", ErrMissingDate, item.ID)
	}
	return checkAge(now.Sub(item.CreatedAt).Hours(), cfg, item.ID)
}

// Score returns an item's score: Quality minus TimePenalty. Higher ranks first.
//
// One point of difference equals a factor of ten in engagement. Negative scores
// are normal and carry no meaning — only the order matters.
func Score(item Item, cfg Config) (float64, error) {
	if err := cfg.Validate(); err != nil {
		return 0, err
	}
	return score(item, cfg.now(), cfg)
}

func score(item Item, now time.Time, cfg Config) (float64, error) {
	q, err := quality(item, cfg)
	if err != nil {
		return 0, err
	}
	age, err := ageHours(item, now, cfg)
	if err != nil {
		return 0, err
	}
	return q - timePenalty(age, cfg), nil
}

// Explain decomposes a score: every signal's contribution, the time penalty, the
// final number.
//
// This is the "not AI" argument made tangible — and the fastest way to find out
// why an item you expected on top is not.
func Explain(item Item, cfg Config) (Explanation, error) {
	if err := cfg.Validate(); err != nil {
		return Explanation{}, err
	}
	total, err := engagement(item, cfg)
	if err != nil {
		return Explanation{}, err
	}
	term, err := bayesianTerm(item, cfg)
	if err != nil {
		return Explanation{}, err
	}

	var breakdowns []SignalBreakdown
	if cfg.Engagement == nil {
		// Map iteration order is random in Go, so sort by field name to keep the
		// output stable between calls.
		for _, field := range sortedKeys(cfg.Signals) {
			value, err := signalOf(item, field)
			if err != nil {
				return Explanation{}, err
			}
			contribution := cfg.Signals[field] * value
			share := 0.0
			if total != 0 {
				share = contribution / total
			}
			breakdowns = append(breakdowns, SignalBreakdown{
				Field:        field,
				Value:        value,
				Weight:       cfg.Signals[field],
				Contribution: contribution,
				Share:        share,
			})
		}
	}

	q, err := quality(item, cfg)
	if err != nil {
		return Explanation{}, err
	}
	age, err := ageHours(item, cfg.now(), cfg)
	if err != nil {
		return Explanation{}, err
	}
	penalty := timePenalty(age, cfg)

	return Explanation{
		ID:          item.ID,
		Engagement:  total,
		Signals:     breakdowns,
		Bayesian:    term,
		Quality:     q,
		AgeHours:    age,
		TimePenalty: penalty,
		Score:       q - penalty,
		Gravity:     cfg.Gravity,
		GraceHours:  cfg.GraceHours,
		Formula:     Formula,
	}, nil
}
