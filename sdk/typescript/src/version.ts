/**
 * Version metadata.
 *
 * `VERSION` is the release of this SDK. `SPEC_VERSION` is the major revision of
 * the ranking specification it implements — every SDK (TypeScript, JavaScript,
 * Python, Go) that reports the same `SPEC_VERSION` produces identical orderings
 * for identical input. Both values are kept in sync by `scripts/sync-version.mjs`
 * and verified in CI; do not edit them by hand.
 */
export const VERSION = '2.0.0';

/** Major revision of the ranking specification implemented here. */
export const SPEC_VERSION = 2;

/** The scoring formula, for logs, docs and `explain()` output. */
export const FORMULA = 'score = log10(1 + sum(w_i * p_i)) - g * log10(t + t0)';
