// Invariants, not values.
//
// Every assertion here survives a change to the constants. If a preset is
// retuned these tests still pass; if the formula is broken they all fail.
import { describe, expect, it } from 'vitest';
import {
  PRESETS,
  RankingError,
  decadeHours,
  engagementRatio,
  explain,
  quality,
  rank,
  rankWithScores,
  score,
  solveGravity,
  timePenalty,
  top,
} from '../src/index.js';

const NOW = new Date('2026-01-15T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

const post = (id: string, ageHours: number, signals: Record<string, number> = {}) => ({
  id,
  createdAt: hoursAgo(ageHours),
  like: 0,
  comment: 0,
  share: 0,
  ...signals,
});

const opts = { preset: 'social-feed' as const, now: NOW };

describe('score is strictly decreasing in t for fixed engagement', () => {
  it('holds across five orders of magnitude of age', () => {
    const ages = [0, 0.5, 1, 2, 6, 24, 72, 240, 8760, 87600];
    const scores = ages.map((age) => score(post('x', age, { like: 42 }), opts));
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]!).toBeLessThan(scores[i - 1]!);
    }
  });

  it('never saturates — this is the v1 bug', () => {
    // v1's denominator tended to 1 + startValue, so time stopped discriminating
    // entirely and a day-old item tied with a year-old one.
    const day = score(post('a', 24, { like: 100 }), opts);
    const year = score(post('b', 8760, { like: 100 }), opts);
    expect(day - year).toBeGreaterThan(1); // more than a factor of ten apart
  });

  it('is flat only when gravity is zero', () => {
    const flat = { ...opts, gravity: 0 };
    expect(score(post('a', 1, { like: 10 }), flat)).toBe(score(post('b', 100000, { like: 10 }), flat));
  });
});

describe('two items of equal age order by engagement', () => {
  it('orders a fixed-age cohort by weighted sum', () => {
    const items = [
      post('low', 5, { like: 2 }),
      post('high', 5, { like: 500 }),
      post('mid', 5, { like: 50 }),
      post('comments', 5, { comment: 30 }),
    ];
    const ordered = rank(items, opts).map((i) => i.id);
    expect(ordered).toEqual(['high', 'comments', 'mid', 'low']);
  });

  it('respects relative signal weights', () => {
    // comment is worth 3 likes, share 5.
    expect(quality(post('a', 0, { comment: 1 }), opts)).toBe(quality(post('b', 0, { like: 3 }), opts));
    expect(quality(post('a', 0, { share: 1 }), opts)).toBe(quality(post('b', 0, { like: 5 }), opts));
  });
});

describe('order is identical to the naive E / (t + t0)^g reference', () => {
  // The additive log form is algebraically log(A/B). Rewriting a division as a
  // subtraction of logs cannot change the order, because log is strictly
  // increasing — this test is what makes that claim checkable rather than
  // asserted.
  const naive = (engagement: number, ageHours: number, gravity: number, graceHours: number) =>
    (1 + engagement) / (ageHours + graceHours) ** gravity;

  it('agrees on a hundred pseudo-random items', () => {
    let seed = 20260115;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };

    const items = Array.from({ length: 100 }, (_, i) => {
      const age = random() * 500;
      const likes = Math.floor(random() * 5000);
      const comments = Math.floor(random() * 300);
      return {
        id: `p${String(i).padStart(3, '0')}`,
        createdAt: hoursAgo(age),
        age,
        like: likes,
        comment: comments,
        share: 0,
      };
    });

    const { gravity, graceHours } = PRESETS['social-feed'];
    const byLog = rank(items, opts).map((i) => i.id);
    const byNaive = [...items]
      .sort((a, b) => {
        const sa = naive(a.like + 3 * a.comment, a.age, gravity, graceHours);
        const sb = naive(b.like + 3 * b.comment, b.age, gravity, graceHours);
        return sb - sa || (a.id < b.id ? -1 : 1);
      })
      .map((i) => i.id);

    expect(byLog).toEqual(byNaive);
  });
});

describe('cold start', () => {
  it('gives a finite score to an item with zero engagement', () => {
    const s = score(post('empty', 0), opts);
    expect(Number.isFinite(s)).toBe(true);
    expect(quality(post('empty', 0), opts)).toBe(0); // log10(1 + 0)
  });

  it('ranks a fresh empty item above an old empty one', () => {
    // The v1 formula multiplied the freshness boost by zero, so a new item with
    // no engagement never surfaced and therefore never received engagement.
    const ordered = rank([post('old', 240), post('fresh', 0)], opts).map((i) => i.id);
    expect(ordered).toEqual(['fresh', 'old']);
  });

  it('leaves the grace window nearly flat', () => {
    const { graceHours } = PRESETS['social-feed'];
    // Inside the grace window the penalty is negligible: an item a tenth of the
    // way through needs less than 1.2x the engagement of a brand-new one. This
    // is the period during which new content accumulates its first signals.
    expect(engagementRatio(graceHours / 10, opts)).toBeLessThan(1.2);
  });

  it('spreads its dynamic range across the window instead of front-loading it', () => {
    // v1's real defect: with startValue = 0.0002 the multiplier fell from 5000x
    // to under 10x within the first 10% of the tuning window, so `stretch`
    // controlled only the region where nothing happened. Here the first tenth of
    // the window must account for well under half of the first decade of decay.
    const window = decadeHours(opts);
    const consumed = (timePenalty(window / 10, opts) - timePenalty(0, opts)) / 1;
    expect(consumed).toBeGreaterThan(0.05);
    expect(consumed).toBeLessThan(0.35);
  });
});

describe('t < 0 raises rather than silently inverting the ranking', () => {
  it('rejects a future-dated item by default', () => {
    expect(() => score(post('future', -1, { like: 5 }), opts)).toThrow(RankingError);
    expect(() => score(post('future', -1, { like: 5 }), opts)).toThrow(/future/i);
  });

  it('clamps to zero when explicitly asked', () => {
    const clamped = { ...opts, onFutureItem: 'clamp' as const };
    expect(score(post('future', -48, { like: 5 }), clamped)).toBe(score(post('now', 0, { like: 5 }), clamped));
  });
});

describe('t = 0 does not divide by zero', () => {
  it('scores a brand-new item finitely', () => {
    expect(Number.isFinite(score(post('new', 0, { like: 1 }), opts))).toBe(true);
    expect(Number.isFinite(timePenalty(0, opts))).toBe(true);
  });

  it('rejects a grace window of zero, which is what would break it', () => {
    expect(() => score(post('new', 0), { ...opts, graceHours: 0 })).toThrow(RankingError);
  });
});

describe('tie-break is deterministic across repeated calls', () => {
  const tied = [post('zulu', 6, { like: 10 }), post('alpha', 6, { like: 10 }), post('mike', 6, { like: 10 })];

  it('orders equal scores by id, ascending', () => {
    expect(rank(tied, opts).map((i) => i.id)).toEqual(['alpha', 'mike', 'zulu']);
  });

  it('returns the same order every time, from any input order', () => {
    const first = rank(tied, opts).map((i) => i.id);
    for (let i = 0; i < 20; i++) {
      expect(rank([...tied].reverse(), opts).map((x) => x.id)).toEqual(first);
    }
  });

  it('falls back to input position when there is no id', () => {
    const anonymous = [
      { createdAt: hoursAgo(6), like: 10, tag: 'first' },
      { createdAt: hoursAgo(6), like: 10, tag: 'second' },
    ];
    expect(rank(anonymous, opts).map((i) => i.tag)).toEqual(['first', 'second']);
  });
});

describe('rank()', () => {
  it('produces a sensible ordering with no arguments at all', () => {
    const items = [
      { id: 'old', createdAt: new Date(Date.now() - 72 * 3_600_000), like: 10 },
      { id: 'new', createdAt: new Date(Date.now() - 60_000), like: 10 },
    ];
    expect(rank(items).map((i) => i.id)).toEqual(['new', 'old']);
  });

  it('does not mutate the input array', () => {
    const items = [post('a', 1, { like: 1 }), post('b', 1, { like: 99 })];
    const before = items.map((i) => i.id);
    rank(items, opts);
    expect(items.map((i) => i.id)).toEqual(before);
  });

  it('pins `now` once for the batch, even without an injected clock', () => {
    // Two identical items scored across a clock tick must still tie.
    const same = { createdAt: new Date(Date.now() - 3_600_000), like: 7 };
    const scored = rankWithScores([
      { id: 'a', ...same },
      { id: 'b', ...same },
    ]);
    expect(scored[0]!.score).toBe(scored[1]!.score);
  });

  it('top(n) is rank(...).slice(0, n)', () => {
    const items = [post('a', 1, { like: 1 }), post('b', 1, { like: 99 }), post('c', 1, { like: 50 })];
    expect(top(items, 2, opts).map((i) => i.id)).toEqual(['b', 'c']);
    expect(top(items, 0, opts)).toEqual([]);
  });
});

describe('the two halves are separately accessible', () => {
  it('score = quality - timePenalty', () => {
    const item = post('x', 17, { like: 33, comment: 4 });
    expect(score(item, opts)).toBeCloseTo(quality(item, opts) - timePenalty(17, opts), 12);
  });

  it('quality is time-independent', () => {
    const signals = { like: 33, comment: 4 };
    expect(quality(post('a', 0, signals), opts)).toBe(quality(post('b', 9999, signals), opts));
  });

  it('reads a stored quality column back instead of recomputing', () => {
    const stored = { id: 'x', createdAt: hoursAgo(10), hot: 4.2, like: 999999 };
    expect(quality(stored, { ...opts, qualityField: 'hot' })).toBe(4.2);
  });
});

describe('explain()', () => {
  const item = post('x', 24, { like: 100, comment: 10, share: 2 });
  const detail = explain(item, opts);

  it('decomposes into parts that add back up', () => {
    expect(detail.quality - detail.timePenalty).toBeCloseTo(detail.score, 12);
    expect(detail.score).toBeCloseTo(score(item, opts), 12);
  });

  it('reports each signal contribution and its share', () => {
    const byField = Object.fromEntries(detail.signals.map((s) => [s.field, s]));
    expect(byField.comment!.contribution).toBe(30); // 10 comments * weight 3
    expect(detail.engagement).toBe(100 + 30 + 10);
    expect(detail.signals.reduce((sum, s) => sum + s.share, 0)).toBeCloseTo(1, 12);
  });

  it('names the formula it used', () => {
    expect(detail.formula).toContain('log10');
    expect(detail.config).toEqual({ gravity: 1.5, graceHours: 2 });
  });
});

describe('the tuning protocol', () => {
  it('round-trips: solveGravity is the inverse of engagementRatio', () => {
    const graceHours = 2;
    for (const [ratio, afterHours] of [
      [47, 24],
      [10, 6],
      [2, 168],
      [1000, 1],
    ] as const) {
      const gravity = solveGravity({ ratio, afterHours, graceHours });
      expect(engagementRatio(afterHours, { gravity, graceHours })).toBeCloseTo(ratio, 9);
    }
  });

  it('reproduces the documented preset behaviour', () => {
    expect(engagementRatio(24, { preset: 'social-feed' })).toBeCloseTo(46.9, 1);
    expect(engagementRatio(48, { preset: 'social-feed' })).toBeCloseTo(125.0, 1);
    expect(engagementRatio(90 * 24, { preset: 'ecommerce' })).toBeCloseTo(2.8, 1);
    expect(engagementRatio(365 * 24, { preset: 'ecommerce' })).toBeCloseTo(4.2, 1);
  });

  it('decadeHours is where the penalty is worth exactly 10x', () => {
    const hours = decadeHours(opts);
    expect(engagementRatio(hours, opts)).toBeCloseTo(10, 9);
    expect(decadeHours({ ...opts, gravity: 0 })).toBe(Infinity);
  });
});

describe('bayesian smoothing (opt-in)', () => {
  const bayesian = { ratingField: 'stars', countField: 'reviews', prior: 3.8, priorCount: 25, weight: 12 };
  const withBayes = { preset: 'ecommerce' as const, now: NOW, bayesian };

  it('is off by default', () => {
    const one = { id: 'one', createdAt: hoursAgo(24), purchase: 10, stars: 5, reviews: 1 };
    const many = { id: 'many', createdAt: hoursAgo(24), purchase: 10, stars: 4.8, reviews: 200 };
    expect(score(one, { preset: 'ecommerce', now: NOW })).toBe(score(many, { preset: 'ecommerce', now: NOW }));
  });

  it('ranks 200 reviews at 4.8 above a single 5-star review', () => {
    const one = { id: 'one', createdAt: hoursAgo(24), purchase: 10, stars: 5, reviews: 1 };
    const many = { id: 'many', createdAt: hoursAgo(24), purchase: 10, stars: 4.8, reviews: 200 };
    expect(rank([one, many], withBayes).map((i) => i.id)).toEqual(['many', 'one']);
  });

  it('pulls an unreviewed product to the prior', () => {
    const detail = explain({ id: 'x', createdAt: hoursAgo(24), stars: 0, reviews: 0 }, withBayes);
    expect(detail.bayesian!.smoothed).toBe(3.8);
  });
});

describe('input validation', () => {
  it('rejects an unknown preset by name, and lists the real ones', () => {
    expect(() => score(post('a', 1), { preset: 'tiktok' as never })).toThrow(/social-feed/);
  });

  it('rejects a negative gravity', () => {
    expect(() => score(post('a', 1), { ...opts, gravity: -1 })).toThrow(RankingError);
  });

  it('reports a missing date field by name', () => {
    expect(() => score({ id: 'a', like: 1 }, opts)).toThrow(/createdAt/);
  });

  it('rejects an unparsable date', () => {
    expect(() => score({ id: 'a', createdAt: 'last tuesday' }, opts)).toThrow(RankingError);
  });

  it('rejects a non-numeric signal value', () => {
    expect(() => score({ id: 'a', createdAt: hoursAgo(1), like: 'lots' }, opts)).toThrow(/like/);
  });

  it('treats a missing signal as zero rather than failing', () => {
    expect(quality({ id: 'a', createdAt: hoursAgo(1) }, opts)).toBe(0);
  });
});

describe('custom engagement callback', () => {
  it('replaces the weighted sum entirely', () => {
    const items = [
      { id: 'a', createdAt: hoursAgo(1), likes: 10, audience: 1000 },
      { id: 'b', createdAt: hoursAgo(1), likes: 400, audience: 5 },
    ];
    const engagement = (item: Record<string, unknown>) =>
      Number(item.likes) / Math.max(1, Number(item.audience) / 1000);
    expect(rank(items, { ...opts, engagement }).map((i) => i.id)).toEqual(['b', 'a']);
  });
});

describe('accepted date formats', () => {
  it('agrees across Date, ISO string and epoch milliseconds', () => {
    const at = hoursAgo(5);
    const asDate = score({ id: 'a', createdAt: at, like: 9 }, opts);
    const asIso = score({ id: 'a', createdAt: at.toISOString(), like: 9 }, opts);
    const asEpoch = score({ id: 'a', createdAt: at.getTime(), like: 9 }, opts);
    expect(asIso).toBe(asDate);
    expect(asEpoch).toBe(asDate);
  });
});
