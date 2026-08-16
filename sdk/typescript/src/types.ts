/** An item to rank. Any object; fields are read by name. */
export type Item = Record<string, unknown>;

/** Anything this library accepts as a publication date. */
export type DateInput = Date | string | number;

/** Weights per signal, keyed by field name: `{ like: 1, comment: 3 }`. */
export type SignalWeights = Readonly<Record<string, number>>;

/**
 * Bayesian smoothing for star ratings. Opt-in, never on the default path.
 *
 * Without it a product with a single 5-star review outranks one with 200 reviews
 * averaging 4.8. The smoothed rating pulls low-count averages towards `prior`:
 *
 *     smoothed = (priorCount * prior + count * average) / (priorCount + count)
 *
 * The result enters the engagement sum as one more additive term, weighted by
 * `weight`.
 */
export interface BayesianConfig {
  /** Field holding the average rating, e.g. `'stars'`. */
  readonly ratingField: string;
  /** Field holding the number of ratings, e.g. `'reviews'`. */
  readonly countField: string;
  /** Rating a product is assumed to have before any review arrives. */
  readonly prior: number;
  /** Strength of the prior, expressed in reviews. */
  readonly priorCount: number;
  /** Weight of the smoothed rating inside the engagement sum. */
  readonly weight: number;
}

/** What to do with an item published in the future (`t < 0`). */
export type FuturePolicy = 'error' | 'clamp';

/** A fully resolved configuration. All optional fields have been defaulted. */
export interface RankingConfig {
  /** Gravity `g`: decay speed. `0` ignores time entirely. */
  readonly gravity: number;
  /** Grace window `t0`, in hours. Must be > 0. */
  readonly graceHours: number;
  /** Additive signal weights, by field name. */
  readonly signals: SignalWeights;
  /** Replaces the weighted sum entirely when provided. */
  readonly engagement?: (item: Item) => number;
  /** Field holding the publication date. */
  readonly dateField: string;
  /** Escape hatch when the date is not a plain field. */
  readonly getDate?: (item: Item) => DateInput;
  /** Field holding a stable id, used for the deterministic tie-break. */
  readonly idField: string;
  /** Field holding a precomputed `log10(1 + sum)`, if you store it. */
  readonly qualityField?: string;
  /** Reference instant. Injectable for tests, SQL parity and pagination. */
  readonly now?: DateInput;
  /** Behaviour for future-dated items. Defaults to `'error'`. */
  readonly onFutureItem: FuturePolicy;
  /** Opt-in Bayesian smoothing of star ratings. */
  readonly bayesian?: BayesianConfig;
}

/** Name of a built-in preset. */
export type PresetName = 'social-feed' | 'ecommerce';

/**
 * What callers pass. Every field is optional: `{ preset }` alone is enough, and
 * so is `{}` — the default preset is `'social-feed'`.
 *
 * Fields given alongside a preset override that preset's values.
 */
export interface RankingOptions extends Partial<RankingConfig> {
  readonly preset?: PresetName;
}

/** One signal's contribution to the engagement sum. */
export interface SignalBreakdown {
  readonly field: string;
  /** Raw value read from the item. */
  readonly value: number;
  readonly weight: number;
  /** `weight * value`. */
  readonly contribution: number;
  /** Fraction of the engagement sum, in `[0, 1]`. */
  readonly share: number;
}

/** Full decomposition of a score, as returned by `explain()`. */
export interface Explanation {
  readonly id: string | null;
  /** `sum(w_i * p_i)` before the log. */
  readonly engagement: number;
  readonly signals: readonly SignalBreakdown[];
  /** Contribution of the Bayesian term, when enabled. */
  readonly bayesian?: {
    readonly average: number;
    readonly count: number;
    readonly smoothed: number;
    readonly weight: number;
    readonly contribution: number;
  };
  /** `log10(1 + engagement)`. Time-independent, storable, indexable. */
  readonly quality: number;
  /** Age in hours at `now`. */
  readonly ageHours: number;
  /** `g * log10(t + t0)`. Subtracted from quality. */
  readonly timePenalty: number;
  /** `quality - timePenalty`. */
  readonly score: number;
  readonly config: { readonly gravity: number; readonly graceHours: number };
  readonly formula: string;
}
