import { describe, expect, it } from 'vitest';
import { EPOCH_OFFSET_2020, RankingError, sqlExpression, tauSeconds, toSQL } from '../src/index.js';

describe('strategy B — exact power law over a bounded window', () => {
  const sql = toSQL({ preset: 'social-feed', table: 'posts' }, 'B');

  it('emits the formula with the preset constants inlined', () => {
    // Signal names are emitted in sorted order, so the output does not depend on
    // how the signals object was written — and so Go, whose maps have no
    // iteration order, can produce the same bytes.
    expect(sql).toContain('log(1 + 3.0 * "comment" + "like" + 5.0 * "share")');
    expect(sql).toContain('1.5 * log((extract(epoch from now() - "created_at") / 3600.0) + 2.0)');
  });

  it('bounds the candidate set so an ordinary index can be used', () => {
    expect(sql).toContain(`WHERE "created_at" > now() - interval '7 days'`);
    expect(sql).toContain('ORDER BY score DESC');
    expect(sql).toContain('LIMIT 20');
  });

  it('maps signal fields onto real column names', () => {
    const mapped = sqlExpression(
      { preset: 'social-feed', columns: { like: 'n_likes', comment: 'n_comments', share: 'n_shares' } },
      'B',
    );
    expect(mapped).toContain('"n_likes"');
    expect(mapped).not.toContain('"like"');
  });
});

describe('strategy A — indexed generated column', () => {
  const sql = toSQL({ preset: 'social-feed', table: 'posts' }, 'A');

  it('uses the exponential family so that `now` cancels and the order freezes', () => {
    expect(sql).toContain('created_epoch');
    expect(sql).not.toContain('now()' + ' -'); // no clock inside the generated expression
    expect(sql).toContain('GENERATED ALWAYS AS');
    expect(sql).toContain('STORED');
    expect(sql).toContain('CREATE INDEX "posts_hot_idx" ON "posts" ("hot" DESC);');
  });

  it('offsets the epoch from 2020 to preserve float precision', () => {
    expect(sql).toContain(`"created_epoch" - ${EPOCH_OFFSET_2020}`);
  });

  it('derives tau from the configuration rather than hard-coding it', () => {
    // tau = t0 * (10^(1/g) - 1) hours: the point where both parameter families
    // are defined by the same thing, one factor of ten in engagement.
    expect(tauSeconds({ preset: 'social-feed' })).toBeCloseTo(2 * (10 ** (1 / 1.5) - 1) * 3600, 6);
    expect(sql).toContain(String(Number(tauSeconds({ preset: 'social-feed' }).toPrecision(12))));
  });

  it('documents the immutability trap in the emitted comments', () => {
    expect(sql).toContain('not immutable');
  });

  it('refuses to emit when gravity is zero, where there is nothing to decay', () => {
    expect(() => toSQL({ preset: 'social-feed', gravity: 0 }, 'A')).toThrow(RankingError);
  });
});

describe('mysql dialect', () => {
  it('uses log10() and timestampdiff()', () => {
    const sql = toSQL({ preset: 'social-feed', dialect: 'mysql' }, 'B');
    expect(sql).toContain('log10(1 +');
    expect(sql).toContain('timestampdiff(second, `created_at`, now()) / 3600.0');
  });
});

describe('refusals', () => {
  it('will not translate a custom engagement callback', () => {
    expect(() => toSQL({ preset: 'social-feed', engagement: () => 1 })).toThrow(/cannot be translated/);
  });

  it('will not interpolate anything that is not a plain identifier', () => {
    expect(() => toSQL({ table: 'posts; drop table users --' })).toThrow(RankingError);
    expect(() => toSQL({ preset: 'social-feed', columns: { like: '"weird name"' } })).toThrow(RankingError);
  });

  it('rejects an unknown dialect', () => {
    expect(() => toSQL({ dialect: 'oracle' as never })).toThrow(/postgres, mysql/);
  });
});

describe('bayesian term in SQL', () => {
  it('emits the smoothing expression with a zero guard', () => {
    const sql = sqlExpression({
      preset: 'ecommerce',
      bayesian: { ratingField: 'stars', countField: 'reviews', prior: 3.8, priorCount: 25, weight: 12 },
    });
    expect(sql).toContain('nullif(25.0 + "reviews", 0)');
    expect(sql).toContain('25.0 * 3.8 + "reviews" * "stars"');
  });
});
