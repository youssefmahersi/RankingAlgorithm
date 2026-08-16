package ranking

// Version is the release of this SDK.
//
// SpecVersion is the major revision of the ranking specification it implements:
// every SDK (TypeScript, JavaScript, Python, Go) reporting the same SpecVersion
// produces identical orderings for identical input. Both values are kept in sync
// by scripts/sync-version.mjs and verified in CI; do not edit them by hand.
const (
	Version = "2.0.0"

	SpecVersion = 2

	// Formula is the scoring formula, for logs, docs and Explain output.
	Formula = "score = log10(1 + sum(w_i * p_i)) - g * log10(t + t0)"
)
