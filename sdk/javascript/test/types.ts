// Compile-only exercise of the hand-written declarations. It is never executed;
// `tsc --noEmit` failing here means types/index.d.ts is wrong or incomplete.
import {
  PRESETS,
  RankingError,
  decadeHours,
  explain,
  quality,
  rank,
  rankWithScores,
  score,
  solveGravity,
  sqlExpression,
  timePenalty,
  toSQL,
  top,
  type Explanation,
  type RankingOptions,
  type Scored,
} from '../types/index.js';

interface Post {
  id: string;
  createdAt: string;
  like: number;
  comment: number;
  [key: string]: unknown;
}

const posts: Post[] = [{ id: 'a', createdAt: '2026-01-15T12:00:00Z', like: 1, comment: 0 }];

const options: RankingOptions = { preset: 'social-feed', now: new Date(), gravity: 1.5 };

// rank() preserves the element type rather than widening to Record<string, unknown>.
const ordered: Post[] = rank(posts, options);
const scored: Scored<Post>[] = rankWithScores(posts, options);
const best: Post[] = top(posts, 10, options);

const s: number = score(posts[0], options);
const q: number = quality(posts[0], options);
const penalty: number = timePenalty(24, options);
const detail: Explanation = explain(posts[0], options);
const firstSignal: string | undefined = detail.signals[0]?.field;

const g: number = solveGravity({ ratio: 47, afterHours: 24, graceHours: 2 });
const window: number = decadeHours({ preset: 'ecommerce' });

const ddl: string = toSQL({ preset: 'social-feed', table: 'posts', dialect: 'postgres' }, 'A');
const expr: string = sqlExpression({ preset: 'ecommerce' }, 'B');

const gravity: number = PRESETS['social-feed'].gravity;
const err: typeof RankingError = RankingError;

// A custom engagement function and a Bayesian block must both typecheck.
const advanced: RankingOptions = {
  preset: 'ecommerce',
  engagement: (item) => Number(item.purchase ?? 0),
  bayesian: { ratingField: 'stars', countField: 'reviews', prior: 3.8, priorCount: 25, weight: 12 },
  onFutureItem: 'clamp',
};

export type { Post };
export { ordered, scored, best, s, q, penalty, detail, firstSignal, g, window, ddl, expr, gravity, err, advanced };
