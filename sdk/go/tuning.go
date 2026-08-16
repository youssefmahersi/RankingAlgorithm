package ranking

import (
	"fmt"
	"math"
)

// SolveGravity derives Gravity from one product question.
//
// Do not tune by trial and error. Ask: an item afterHours old, how many times
// more engagement must it have to beat a brand-new one? Then invert:
//
//	g = log(ratio) / log((X + t₀) / t₀)
//
// Set GraceHours first ("how long does content get to start?"), then solve for
// gravity. The two interact strongly: raising GraceHours flattens the entire time
// penalty, not just the early window, so re-solve gravity whenever you change it.
func SolveGravity(ratio, afterHours, graceHours float64) (float64, error) {
	if !(ratio > 0) {
		return 0, fmt.Errorf("%w: ratio must be > 0, got %v", ErrInvalidConfig, ratio)
	}
	if !(afterHours > 0) {
		return 0, fmt.Errorf("%w: afterHours must be > 0, got %v", ErrInvalidConfig, afterHours)
	}
	if !(graceHours > 0) {
		return 0, fmt.Errorf("%w: graceHours must be > 0, got %v", ErrInvalidConfig, graceHours)
	}
	return math.Log(ratio) / math.Log((afterHours+graceHours)/graceHours), nil
}

// EngagementRatio is the forward direction of [SolveGravity]: how much more
// engagement an item afterHours old needs to tie with a brand-new one.
//
// Use it to sanity-check a configuration you did not derive yourself — including
// the presets.
func EngagementRatio(afterHours float64, cfg Config) (float64, error) {
	if err := cfg.Validate(); err != nil {
		return 0, err
	}
	if !(afterHours >= 0) {
		return 0, fmt.Errorf("%w: afterHours must be >= 0, got %v", ErrInvalidConfig, afterHours)
	}
	return math.Pow((afterHours+cfg.GraceHours)/cfg.GraceHours, cfg.Gravity), nil
}

// DecadeHours is the age at which the time penalty is worth exactly one factor of
// ten in engagement: "after this long, you need 10x the engagement to hold your
// place". It is +Inf when Gravity is zero.
func DecadeHours(cfg Config) (float64, error) {
	if err := cfg.Validate(); err != nil {
		return 0, err
	}
	if cfg.Gravity == 0 {
		return math.Inf(1), nil
	}
	return cfg.GraceHours * (math.Pow(10, 1/cfg.Gravity) - 1), nil
}

// TauSeconds is the exponential-family time constant matching this configuration,
// in seconds — the tau used by SQL strategy A.
//
// The power law and the exponential family are different curves; they are matched
// here at the point both parameter families are defined by, one factor of ten in
// engagement. Strategy A trades exactness for a static index, and this is the
// conversion that trade goes through.
func TauSeconds(cfg Config) (float64, error) {
	hours, err := DecadeHours(cfg)
	if err != nil {
		return 0, err
	}
	return hours * 3600, nil
}
