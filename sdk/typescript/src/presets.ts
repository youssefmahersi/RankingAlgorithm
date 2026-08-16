import { RankingError } from './errors.js';
import type { PresetName, RankingConfig, RankingOptions } from './types.js';

/**
 * Presets are the product; configuration is the advanced option.
 *
 * `social-feed`: a 24 h old item needs ~47x the engagement of a fresh one to tie,
 * ~125x at 48 h. Content is effectively dead in two days.
 *
 * `ecommerce`: a 90-day-old product needs only ~2.8x the sales of a new one, and
 * over a full year the penalty reaches only ~4.2x — a genuine best-seller stays
 * on top for years while remaining separable by age.
 */
export const PRESETS: Readonly<Record<PresetName, RankingConfig>> = Object.freeze({
  'social-feed': Object.freeze({
    gravity: 1.5,
    graceHours: 2,
    signals: Object.freeze({ like: 1, comment: 3, share: 5 }),
    dateField: 'createdAt',
    idField: 'id',
    onFutureItem: 'error',
  }) as RankingConfig,
  ecommerce: Object.freeze({
    gravity: 0.3,
    graceHours: 72,
    signals: Object.freeze({ view: 0.05, cart: 1, purchase: 10 }),
    dateField: 'createdAt',
    idField: 'id',
    onFutureItem: 'error',
  }) as RankingConfig,
});

/** The preset used when none is named. */
export const DEFAULT_PRESET: PresetName = 'social-feed';

/**
 * Merge a preset with caller overrides and validate the result.
 *
 * Called on every public entry point, so it must stay cheap; it is O(1) apart
 * from copying the signal map.
 */
export function resolveConfig(options: RankingOptions = {}): RankingConfig {
  const presetName = options.preset ?? DEFAULT_PRESET;
  const base = PRESETS[presetName];
  if (base === undefined) {
    throw new RankingError(
      `Unknown preset ${JSON.stringify(presetName)}. Available: ${Object.keys(PRESETS).join(', ')}.`,
    );
  }

  const config: RankingConfig = {
    ...base,
    ...stripUndefined(options),
    signals: options.signals ?? base.signals,
  };

  validate(config);
  return config;
}

function stripUndefined(options: RankingOptions): Partial<RankingConfig> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined && key !== 'preset') out[key] = value;
  }
  return out as Partial<RankingConfig>;
}

function validate(config: RankingConfig): void {
  if (!Number.isFinite(config.gravity)) {
    throw new RankingError(`gravity must be a finite number, received ${String(config.gravity)}.`);
  }
  if (config.gravity < 0) {
    throw new RankingError(
      `gravity must be >= 0, received ${config.gravity}. A negative gravity ranks old items first.`,
    );
  }
  if (!Number.isFinite(config.graceHours) || config.graceHours <= 0) {
    throw new RankingError(
      `graceHours must be a finite number > 0, received ${String(config.graceHours)}. ` +
        'It is what keeps log10(t + t0) finite at t = 0.',
    );
  }
  for (const [field, weight] of Object.entries(config.signals)) {
    if (!Number.isFinite(weight)) {
      throw new RankingError(
        `Weight for signal ${JSON.stringify(field)} must be a finite number, received ${String(weight)}.`,
      );
    }
  }
  if (config.onFutureItem !== 'error' && config.onFutureItem !== 'clamp') {
    throw new RankingError(`onFutureItem must be 'error' or 'clamp', received ${JSON.stringify(config.onFutureItem)}.`);
  }
  if (config.bayesian) {
    const { prior, priorCount, weight } = config.bayesian;
    if (!Number.isFinite(prior) || !Number.isFinite(priorCount) || !Number.isFinite(weight)) {
      throw new RankingError('bayesian.prior, bayesian.priorCount and bayesian.weight must all be finite numbers.');
    }
    if (priorCount < 0) throw new RankingError(`bayesian.priorCount must be >= 0, received ${priorCount}.`);
  }
}
