import { RankingError } from './errors.js';
import { resolveConfig } from './presets.js';
import type { RankingOptions } from './types.js';

/**
 * Tuning protocol.
 *
 * Do not tune by trial and error. Answer one product question — "an item X hours
 * old, how many times more engagement must it have to beat a brand-new one?" —
 * and invert it:
 *
 *     g = log(ratio) / log((X + t0) / t0)
 *
 * Set `graceHours` first ("how long does content get to start?"), then solve for
 * gravity. The two interact strongly: raising `graceHours` flattens the entire
 * time penalty, not just the early window, so re-solve gravity whenever you
 * change it.
 */
export function solveGravity(params: { ratio: number; afterHours: number; graceHours: number }): number {
  const { ratio, afterHours, graceHours } = params;
  if (!(ratio > 0)) throw new RankingError(`ratio must be > 0, received ${String(ratio)}.`);
  if (!(afterHours > 0)) throw new RankingError(`afterHours must be > 0, received ${String(afterHours)}.`);
  if (!(graceHours > 0)) throw new RankingError(`graceHours must be > 0, received ${String(graceHours)}.`);
  return Math.log(ratio) / Math.log((afterHours + graceHours) / graceHours);
}

/**
 * The forward direction: how much more engagement an item `afterHours` old needs
 * to tie with a brand-new one.
 *
 * Use it to sanity-check a configuration you did not derive yourself — including
 * the presets.
 */
export function engagementRatio(afterHours: number, options: RankingOptions = {}): number {
  const config = resolveConfig(options);
  if (!(afterHours >= 0)) throw new RankingError(`afterHours must be >= 0, received ${String(afterHours)}.`);
  return ((afterHours + config.graceHours) / config.graceHours) ** config.gravity;
}

/**
 * Hours until the time penalty is worth exactly one factor of ten in engagement.
 *
 * This is the single most legible number about a configuration: "after this long,
 * you need 10x the engagement to hold your place".
 */
export function decadeHours(options: RankingOptions = {}): number {
  const config = resolveConfig(options);
  if (config.gravity === 0) return Infinity;
  return config.graceHours * (10 ** (1 / config.gravity) - 1);
}

/**
 * The exponential-family time constant that best matches this configuration,
 * in seconds — the `tau` used by SQL strategy A.
 *
 * The power law and the exponential family are different curves; they are matched
 * here at the point that both parameters are defined by, one factor of ten in
 * engagement. Strategy A trades exactness for a static index, and this is the
 * conversion that trade goes through.
 */
export function tauSeconds(options: RankingOptions = {}): number {
  return decadeHours(options) * 3600;
}
