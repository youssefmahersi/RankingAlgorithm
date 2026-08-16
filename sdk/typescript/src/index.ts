/**
 * Deterministic, dependency-free ranking for feeds and catalogues.
 *
 *     score = log10(1 + sum(w_i * p_i)) - g * log10(t + t0)
 *
 * Ranking you can audit, run inside a SQL query, and explain to a lawyer.
 *
 * @example
 * ```ts
 * import { rank } from '@youssefmahersi/ranking'
 *
 * const ordered = rank(posts, { preset: 'social-feed' })
 * ```
 */
export { RankingError } from './errors.js';
export { DEFAULT_PRESET, PRESETS, resolveConfig } from './presets.js';
export { rank, rankWithScores, top } from './rank.js';
export type { Scored } from './rank.js';
export { ageHours, engagement, explain, quality, score, timePenalty, toEpochMs } from './score.js';
export { EPOCH_OFFSET_2020, sqlExpression, toSQL } from './sql.js';
export type { Dialect, SQLOptions, Strategy } from './sql.js';
export { decadeHours, engagementRatio, solveGravity, tauSeconds } from './tuning.js';
export type {
  BayesianConfig,
  DateInput,
  Explanation,
  FuturePolicy,
  Item,
  PresetName,
  RankingConfig,
  RankingOptions,
  SignalBreakdown,
  SignalWeights,
} from './types.js';
export { FORMULA, SPEC_VERSION, VERSION } from './version.js';
