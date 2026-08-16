import { RankingError } from './errors.js';
import { resolveConfig } from './presets.js';
import type { DateInput, Explanation, Item, RankingConfig, RankingOptions, SignalBreakdown } from './types.js';
import { FORMULA } from './version.js';

const MS_PER_HOUR = 3_600_000;

/** Read a numeric field, treating a missing field as zero. */
function numberAt(item: Item, field: string): number {
  const raw = item?.[field];
  if (raw === undefined || raw === null) return 0;
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(value)) {
    throw new RankingError(`Field ${JSON.stringify(field)} must be a finite number, received ${JSON.stringify(raw)}.`);
  }
  return value;
}

/** Normalise `Date | ISO string | epoch milliseconds` to epoch milliseconds. */
export function toEpochMs(value: DateInput, label: string): number {
  if (value instanceof Date) {
    const ms = value.getTime();
    if (Number.isNaN(ms)) throw new RankingError(`${label} is an Invalid Date.`);
    return ms;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new RankingError(`${label} must be finite epoch milliseconds, received ${value}.`);
    return value;
  }
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) throw new RankingError(`${label} is not a parsable date: ${JSON.stringify(value)}.`);
    return ms;
  }
  throw new RankingError(
    `${label} must be a Date, an ISO 8601 string or epoch milliseconds, received ${typeof value}.`,
  );
}

/**
 * The Bayesian term, or `null` when smoothing is disabled.
 *
 * Separate from the weighted sum so that `explain()` can report it on its own
 * line — it is an opt-in exception to "no ML, no heuristics", and hiding it
 * inside the signal list would misrepresent the score.
 */
function bayesianTerm(item: Item, config: RankingConfig) {
  const b = config.bayesian;
  if (!b) return null;
  const average = numberAt(item, b.ratingField);
  const count = numberAt(item, b.countField);
  const denominator = b.priorCount + count;
  const smoothed = denominator === 0 ? b.prior : (b.priorCount * b.prior + count * average) / denominator;
  return { average, count, smoothed, weight: b.weight, contribution: b.weight * smoothed };
}

/** `sum(w_i * p_i)` — the raw, pre-log engagement of an item. */
export function engagement(item: Item, options: RankingOptions = {}): number {
  return engagementWith(item, resolveConfig(options));
}

function engagementWith(item: Item, config: RankingConfig): number {
  if (config.engagement) {
    const value = config.engagement(item);
    if (!Number.isFinite(value)) {
      throw new RankingError(`The engagement() callback must return a finite number, received ${String(value)}.`);
    }
    return value;
  }
  let total = 0;
  for (const [field, weight] of Object.entries(config.signals)) {
    total += weight * numberAt(item, field);
  }
  const bayes = bayesianTerm(item, config);
  if (bayes) total += bayes.contribution;
  return total;
}

/**
 * `log10(1 + sum(w_i * p_i))` — the time-independent half of the score.
 *
 * This is the half you can store in a column and index: it only changes when
 * engagement changes, not on every tick of the clock. `rank()` will read it back
 * from `config.qualityField` if you tell it where you put it.
 */
export function quality(item: Item, options: RankingOptions = {}): number {
  return qualityWith(item, resolveConfig(options));
}

function qualityWith(item: Item, config: RankingConfig): number {
  if (config.qualityField !== undefined && item?.[config.qualityField] !== undefined) {
    return numberAt(item, config.qualityField);
  }
  const total = engagementWith(item, config);
  if (total < -1) {
    throw new RankingError(
      `Engagement sum is ${total}; log10(1 + sum) is undefined below -1. ` +
        'Negative weights large enough to push the sum under -1 are not supported — this library has no moderation logic.',
    );
  }
  return Math.log10(1 + total);
}

/**
 * `g * log10(t + t0)` — the time-dependent half, applied at query time.
 *
 * Note it is subtracted, and that it is negative while `t + t0 < 1`. Only
 * differences between items matter, so the sign carries no meaning.
 */
export function timePenalty(ageHours: number, options: RankingOptions = {}): number {
  const config = resolveConfig(options);
  return timePenaltyWith(assertAge(ageHours, config), config);
}

function timePenaltyWith(ageHours: number, config: RankingConfig): number {
  if (config.gravity === 0) return 0;
  return config.gravity * Math.log10(ageHours + config.graceHours);
}

function assertAge(ageHours: number, config: RankingConfig): number {
  if (!Number.isFinite(ageHours)) {
    throw new RankingError(`Age must be a finite number of hours, received ${String(ageHours)}.`);
  }
  if (ageHours < 0) {
    if (config.onFutureItem === 'clamp') return 0;
    throw new RankingError(
      `Age is ${ageHours} hours: the item is published in the future relative to \`now\`. ` +
        'A negative age silently inverts the ranking, so it is rejected. ' +
        "Pass { onFutureItem: 'clamp' } to treat future items as brand new instead.",
    );
  }
  return ageHours;
}

/** Age of an item in hours at `config.now`, validated against the future policy. */
export function ageHours(item: Item, options: RankingOptions = {}): number {
  return ageHoursWith(item, resolveConfig(options));
}

function ageHoursWith(item: Item, config: RankingConfig): number {
  const nowMs = config.now === undefined ? Date.now() : toEpochMs(config.now, 'now');
  const raw = config.getDate ? config.getDate(item) : (item?.[config.dateField] as DateInput | undefined);
  if (raw === undefined || raw === null) {
    throw new RankingError(
      `Item is missing its publication date. Expected field ${JSON.stringify(config.dateField)}; ` +
        'set `dateField` or pass a `getDate(item)` function.',
    );
  }
  const createdMs = toEpochMs(raw, `Field ${JSON.stringify(config.dateField)}`);
  return assertAge((nowMs - createdMs) / MS_PER_HOUR, config);
}

/** The score of a single item: `quality - timePenalty`. Higher ranks first. */
export function score(item: Item, options: RankingOptions = {}): number {
  return scoreWith(item, resolveConfig(options));
}

/** @internal Shared by `score()`, `explain()` and `rank()` after one config resolve. */
export function scoreWith(item: Item, config: RankingConfig): number {
  return qualityWith(item, config) - timePenaltyWith(ageHoursWith(item, config), config);
}

/**
 * Full decomposition of a score: every signal's contribution, the time penalty,
 * the final number.
 *
 * This is the "not AI" argument made tangible — and the fastest way to find out
 * why an item you expected on top is not.
 */
export function explain(item: Item, options: RankingOptions = {}): Explanation {
  const config = resolveConfig(options);
  const total = engagementWith(item, config);
  const bayes = bayesianTerm(item, config);
  const share = (contribution: number) => (total === 0 ? 0 : contribution / total);

  // Signal names are reported in sorted order in every SDK, so the breakdown does
  // not depend on how the signals object was written (and Go, whose maps have no
  // order at all, can agree).
  const signals: SignalBreakdown[] = config.engagement
    ? []
    : Object.keys(config.signals)
        .sort()
        .map((field) => {
          const weight = config.signals[field]!;
          const value = numberAt(item, field);
          const contribution = weight * value;
          return { field, value, weight, contribution, share: share(contribution) };
        });

  const q = qualityWith(item, config);
  const age = ageHoursWith(item, config);
  const penalty = timePenaltyWith(age, config);
  const rawId = item?.[config.idField];

  return {
    id: rawId === undefined || rawId === null ? null : String(rawId),
    engagement: total,
    signals,
    ...(bayes ? { bayesian: bayes } : {}),
    quality: q,
    ageHours: age,
    timePenalty: penalty,
    score: q - penalty,
    config: { gravity: config.gravity, graceHours: config.graceHours },
    formula: FORMULA,
  };
}
