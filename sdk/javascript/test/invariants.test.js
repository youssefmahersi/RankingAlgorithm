// Invariants, not values. Every assertion here survives a change to the
// constants: retune a preset and these still pass, break the formula and they
// all fail.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
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
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600000);
const post = (id, ageHours, signals = {}) => ({
  id,
  createdAt: hoursAgo(ageHours),
  like: 0,
  comment: 0,
  share: 0,
  ...signals,
});
const opts = { preset: 'social-feed', now: NOW };
const close = (a, b, epsilon = 1e-12) => assert.ok(Math.abs(a - b) < epsilon, `${a} !~= ${b}`);

describe('score is strictly decreasing in t for fixed engagement', () => {
  it('holds across five orders of magnitude of age', () => {
    const scores = [0, 0.5, 1, 2, 6, 24, 72, 240, 8760, 87600].map((age) => score(post('x', age, { like: 42 }), opts));
    for (let i = 1; i < scores.length; i++) assert.ok(scores[i] < scores[i - 1]);
  });

  it('never saturates — this is the v1 bug', () => {
    const day = score(post('a', 24, { like: 100 }), opts);
    const year = score(post('b', 8760, { like: 100 }), opts);
    assert.ok(day - year > 1, 'a day-old and a year-old item must be more than 10x apart');
  });

  it('is flat only when gravity is zero', () => {
    const flat = { ...opts, gravity: 0 };
    assert.equal(score(post('a', 1, { like: 10 }), flat), score(post('b', 100000, { like: 10 }), flat));
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
    assert.deepEqual(
      rank(items, opts).map((i) => i.id),
      ['high', 'comments', 'mid', 'low'],
    );
  });

  it('respects relative signal weights', () => {
    assert.equal(quality(post('a', 0, { comment: 1 }), opts), quality(post('b', 0, { like: 3 }), opts));
    assert.equal(quality(post('a', 0, { share: 1 }), opts), quality(post('b', 0, { like: 5 }), opts));
  });
});

describe('order is identical to the naive E / (t + t0)^g reference', () => {
  // The additive log form is algebraically log(A/B). Rewriting a division as a
  // subtraction of logs cannot change the order, because log is strictly
  // increasing — this is what makes that claim checkable rather than asserted.
  it('agrees on a hundred pseudo-random items', () => {
    let seed = 20260115;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const items = Array.from({ length: 100 }, (_, i) => {
      const age = random() * 500;
      return {
        id: `p${String(i).padStart(3, '0')}`,
        createdAt: hoursAgo(age),
        age,
        like: Math.floor(random() * 5000),
        comment: Math.floor(random() * 300),
        share: 0,
      };
    });

    const { gravity, graceHours } = PRESETS['social-feed'];
    const naive = (item) => (1 + item.like + 3 * item.comment) / (item.age + graceHours) ** gravity;

    assert.deepEqual(
      rank(items, opts).map((i) => i.id),
      [...items].sort((a, b) => naive(b) - naive(a) || (a.id < b.id ? -1 : 1)).map((i) => i.id),
    );
  });
});

describe('cold start', () => {
  it('gives a finite score to an item with zero engagement', () => {
    assert.ok(Number.isFinite(score(post('empty', 0), opts)));
    assert.equal(quality(post('empty', 0), opts), 0);
  });

  it('ranks a fresh empty item above an old empty one', () => {
    // v1 multiplied the freshness boost by zero, so a new item with no
    // engagement never surfaced and therefore never received engagement.
    assert.deepEqual(
      rank([post('old', 240), post('fresh', 0)], opts).map((i) => i.id),
      ['fresh', 'old'],
    );
  });

  it('leaves the grace window nearly flat', () => {
    const { graceHours } = PRESETS['social-feed'];
    assert.ok(engagementRatio(graceHours / 10, opts) < 1.2);
  });

  it('spreads its dynamic range across the window instead of front-loading it', () => {
    // v1 fell from 5000x to under 10x inside the first 10% of its window.
    const consumed = timePenalty(decadeHours(opts) / 10, opts) - timePenalty(0, opts);
    assert.ok(consumed > 0.05 && consumed < 0.35, `first tenth consumed ${consumed} of a decade`);
  });
});

describe('t < 0 raises rather than silently inverting the ranking', () => {
  it('rejects a future-dated item by default', () => {
    assert.throws(() => score(post('future', -1, { like: 5 }), opts), RankingError);
    assert.throws(() => score(post('future', -1, { like: 5 }), opts), /future/i);
  });

  it('clamps to zero when explicitly asked', () => {
    const clamped = { ...opts, onFutureItem: 'clamp' };
    assert.equal(score(post('future', -48, { like: 5 }), clamped), score(post('now', 0, { like: 5 }), clamped));
  });
});

describe('t = 0 does not divide by zero', () => {
  it('scores a brand-new item finitely', () => {
    assert.ok(Number.isFinite(score(post('new', 0, { like: 1 }), opts)));
    assert.ok(Number.isFinite(timePenalty(0, opts)));
  });

  it('rejects a grace window of zero, which is what would break it', () => {
    assert.throws(() => score(post('new', 0), { ...opts, graceHours: 0 }), RankingError);
  });
});

describe('tie-break is deterministic across repeated calls', () => {
  const tied = [post('zulu', 6, { like: 10 }), post('alpha', 6, { like: 10 }), post('mike', 6, { like: 10 })];

  it('orders equal scores by id, ascending', () => {
    assert.deepEqual(
      rank(tied, opts).map((i) => i.id),
      ['alpha', 'mike', 'zulu'],
    );
  });

  it('returns the same order every time, from any input order', () => {
    for (let i = 0; i < 20; i++) {
      assert.deepEqual(
        rank([...tied].reverse(), opts).map((x) => x.id),
        ['alpha', 'mike', 'zulu'],
      );
    }
  });

  it('falls back to input position when there is no id', () => {
    const anonymous = [
      { createdAt: hoursAgo(6), like: 10, tag: 'first' },
      { createdAt: hoursAgo(6), like: 10, tag: 'second' },
    ];
    assert.deepEqual(
      rank(anonymous, opts).map((i) => i.tag),
      ['first', 'second'],
    );
  });
});

describe('rank()', () => {
  it('produces a sensible ordering with no arguments at all', () => {
    const items = [
      { id: 'old', createdAt: new Date(Date.now() - 72 * 3600000), like: 10 },
      { id: 'new', createdAt: new Date(Date.now() - 60000), like: 10 },
    ];
    assert.deepEqual(
      rank(items).map((i) => i.id),
      ['new', 'old'],
    );
  });

  it('does not mutate the input array', () => {
    const items = [post('a', 1, { like: 1 }), post('b', 1, { like: 99 })];
    rank(items, opts);
    assert.deepEqual(
      items.map((i) => i.id),
      ['a', 'b'],
    );
  });

  it('pins `now` once for the batch, even without an injected clock', () => {
    const same = { createdAt: new Date(Date.now() - 3600000), like: 7 };
    const scored = rankWithScores([
      { id: 'a', ...same },
      { id: 'b', ...same },
    ]);
    assert.equal(scored[0].score, scored[1].score);
  });

  it('top(n) is rank(...).slice(0, n)', () => {
    const items = [post('a', 1, { like: 1 }), post('b', 1, { like: 99 }), post('c', 1, { like: 50 })];
    assert.deepEqual(
      top(items, 2, opts).map((i) => i.id),
      ['b', 'c'],
    );
    assert.deepEqual(top(items, 0, opts), []);
  });
});

describe('the two halves are separately accessible', () => {
  it('score = quality - timePenalty', () => {
    const item = post('x', 17, { like: 33, comment: 4 });
    close(score(item, opts), quality(item, opts) - timePenalty(17, opts));
  });

  it('quality is time-independent', () => {
    const signals = { like: 33, comment: 4 };
    assert.equal(quality(post('a', 0, signals), opts), quality(post('b', 9999, signals), opts));
  });

  it('reads a stored quality column back instead of recomputing', () => {
    const stored = { id: 'x', createdAt: hoursAgo(10), hot: 4.2, like: 999999 };
    assert.equal(quality(stored, { ...opts, qualityField: 'hot' }), 4.2);
  });
});

describe('explain()', () => {
  const item = post('x', 24, { like: 100, comment: 10, share: 2 });

  it('decomposes into parts that add back up', () => {
    const detail = explain(item, opts);
    close(detail.quality - detail.timePenalty, detail.score);
    close(detail.score, score(item, opts));
  });

  it('reports each signal contribution and its share', () => {
    const detail = explain(item, opts);
    const byField = Object.fromEntries(detail.signals.map((s) => [s.field, s]));
    assert.equal(byField.comment.contribution, 30);
    assert.equal(detail.engagement, 140);
    close(
      detail.signals.reduce((sum, s) => sum + s.share, 0),
      1,
    );
  });

  it('names the formula it used', () => {
    const detail = explain(item, opts);
    assert.match(detail.formula, /log10/);
    assert.deepEqual(detail.config, { gravity: 1.5, graceHours: 2 });
  });
});

describe('the tuning protocol', () => {
  it('round-trips: solveGravity is the inverse of engagementRatio', () => {
    for (const [ratio, afterHours] of [
      [47, 24],
      [10, 6],
      [2, 168],
      [1000, 1],
    ]) {
      const gravity = solveGravity({ ratio, afterHours, graceHours: 2 });
      close(engagementRatio(afterHours, { gravity, graceHours: 2 }), ratio, 1e-9);
    }
  });

  it('reproduces the documented preset behaviour', () => {
    close(engagementRatio(24, { preset: 'social-feed' }), 46.87, 0.05);
    close(engagementRatio(48, { preset: 'social-feed' }), 125.0, 0.05);
    close(engagementRatio(90 * 24, { preset: 'ecommerce' }), 2.8, 0.05);
    close(engagementRatio(365 * 24, { preset: 'ecommerce' }), 4.23, 0.05);
  });

  it('decadeHours is where the penalty is worth exactly 10x', () => {
    close(engagementRatio(decadeHours(opts), opts), 10, 1e-9);
    assert.equal(decadeHours({ ...opts, gravity: 0 }), Infinity);
  });
});

describe('bayesian smoothing (opt-in)', () => {
  const bayesian = { ratingField: 'stars', countField: 'reviews', prior: 3.8, priorCount: 25, weight: 12 };
  const one = { id: 'one', createdAt: hoursAgo(24), purchase: 10, stars: 5, reviews: 1 };
  const many = { id: 'many', createdAt: hoursAgo(24), purchase: 10, stars: 4.8, reviews: 200 };

  it('is off by default', () => {
    const plain = { preset: 'ecommerce', now: NOW };
    assert.equal(score(one, plain), score(many, plain));
  });

  it('ranks 200 reviews at 4.8 above a single 5-star review', () => {
    assert.deepEqual(
      rank([one, many], { preset: 'ecommerce', now: NOW, bayesian }).map((i) => i.id),
      ['many', 'one'],
    );
  });

  it('pulls an unreviewed product to the prior', () => {
    const detail = explain(
      { id: 'x', createdAt: hoursAgo(24), stars: 0, reviews: 0 },
      { preset: 'ecommerce', now: NOW, bayesian },
    );
    assert.equal(detail.bayesian.smoothed, 3.8);
  });
});

describe('input validation', () => {
  it('rejects an unknown preset by name, and lists the real ones', () => {
    assert.throws(() => score(post('a', 1), { preset: 'tiktok' }), /social-feed/);
  });

  it('rejects a negative gravity', () => {
    assert.throws(() => score(post('a', 1), { ...opts, gravity: -1 }), RankingError);
  });

  it('reports a missing date field by name', () => {
    assert.throws(() => score({ id: 'a', like: 1 }, opts), /createdAt/);
  });

  it('rejects an unparsable date', () => {
    assert.throws(() => score({ id: 'a', createdAt: 'last tuesday' }, opts), RankingError);
  });

  it('rejects a non-numeric signal value', () => {
    assert.throws(() => score({ id: 'a', createdAt: hoursAgo(1), like: 'lots' }, opts), /like/);
  });

  it('treats a missing signal as zero rather than failing', () => {
    assert.equal(quality({ id: 'a', createdAt: hoursAgo(1) }, opts), 0);
  });
});

describe('accepted date formats', () => {
  it('agrees across Date, ISO string and epoch milliseconds', () => {
    const at = hoursAgo(5);
    const expected = score({ id: 'a', createdAt: at, like: 9 }, opts);
    assert.equal(score({ id: 'a', createdAt: at.toISOString(), like: 9 }, opts), expected);
    assert.equal(score({ id: 'a', createdAt: at.getTime(), like: 9 }, opts), expected);
  });
});
