import { resolveConfig } from './presets.js';
import { scoreWith } from './score.js';
import type { Item, RankingConfig, RankingOptions } from './types.js';

/** An item paired with its score, as returned by `rankWithScores()`. */
export interface Scored<T> {
  readonly item: T;
  readonly score: number;
}

/**
 * Pin `now` once for the whole batch.
 *
 * Without this, `Date.now()` is read per item and a long array can be scored
 * across a clock tick — two items with identical inputs would then get different
 * penalties. Every call that touches more than one item goes through here.
 */
function freezeNow(config: RankingConfig): RankingConfig {
  return config.now === undefined ? { ...config, now: Date.now() } : config;
}

function idOf(item: Item, idField: string): string | null {
  const raw = item?.[idField];
  return raw === undefined || raw === null ? null : String(raw);
}

/**
 * Order items best-first.
 *
 * Returns a new array; the input is not mutated. Ties break on the stable id
 * (ascending), then on input position, so repeated calls on the same data always
 * produce the same order.
 */
export function rank<T extends Item>(items: readonly T[], options: RankingOptions = {}): T[] {
  return rankWithScores(items, options).map((entry) => entry.item);
}

/**
 * Like `rank()`, but keeps each item's score.
 *
 * Use it when you need the numbers downstream — a cursor, a debug column, a
 * cutoff threshold — instead of recomputing them.
 */
export function rankWithScores<T extends Item>(items: readonly T[], options: RankingOptions = {}): Scored<T>[] {
  if (!Array.isArray(items)) {
    throw new TypeError(`rank() expects an array of items, received ${typeof items}.`);
  }
  const config = freezeNow(resolveConfig(options));

  const entries = items.map((item, index) => ({
    item,
    index,
    score: scoreWith(item, config),
    id: idOf(item, config.idField),
  }));

  entries.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.id !== null && b.id !== null && a.id !== b.id) return a.id < b.id ? -1 : 1;
    return a.index - b.index;
  });

  return entries.map(({ item, score }) => ({ item, score }));
}

/**
 * Top `n` items, best-first.
 *
 * Still a full sort — this library is the rescoring stage of a funnel, sized for
 * a few hundred to a few thousand in-memory candidates, not for a table scan.
 * Bound the candidate set in SQL first; see `toSQL()`.
 */
export function top<T extends Item>(items: readonly T[], n: number, options: RankingOptions = {}): T[] {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError(`top() expects a non-negative integer, received ${String(n)}.`);
  }
  return rank(items, options).slice(0, n);
}
