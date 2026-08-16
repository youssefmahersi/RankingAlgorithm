import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { EPOCH_OFFSET_2020, RankingError, sqlExpression, tauSeconds, toSQL } from '../src/index.js';

describe('strategy B — exact power law over a bounded window', () => {
  const sql = toSQL({ preset: 'social-feed', table: 'posts' }, 'B');

  it('emits the formula with the preset constants inlined', () => {
    // Signal names are emitted in sorted order, so the output does not depend on
    // how the signals object was written — and so Go, whose maps have no
    // iteration order, can produce the same bytes.
    assert.ok(sql.includes('log(1 + 3.0 * "comment" + "like" + 5.0 * "share")'), sql);
    assert.ok(sql.includes('1.5 * log((extract(epoch from now() - "created_at") / 3600.0) + 2.0)'), sql);
  });

  it('bounds the candidate set so an ordinary index can be used', () => {
    assert.ok(sql.includes(`WHERE "created_at" > now() - interval '7 days'`), sql);
    assert.match(sql, /ORDER BY score DESC/);
    assert.match(sql, /LIMIT 20/);
  });

  it('maps signal fields onto real column names', () => {
    const mapped = sqlExpression({ preset: 'social-feed', columns: { like: 'n_likes', comment: 'n_comments' } }, 'B');
    assert.ok(mapped.includes('"n_likes"'), mapped);
  });
});

describe('strategy A — indexed generated column', () => {
  const sql = toSQL({ preset: 'social-feed', table: 'posts' }, 'A');

  it('uses the exponential family so that `now` cancels and the order freezes', () => {
    assert.match(sql, /created_epoch/);
    assert.ok(!sql.includes('now() -'), 'no clock may appear inside a generated column');
    assert.match(sql, /GENERATED ALWAYS AS/);
    assert.match(sql, /STORED/);
    assert.ok(sql.includes('CREATE INDEX "posts_hot_idx" ON "posts" ("hot" DESC);'), sql);
  });

  it('offsets the epoch from 2020 to preserve float precision', () => {
    assert.ok(sql.includes(`"created_epoch" - ${EPOCH_OFFSET_2020}`));
  });

  it('derives tau from the configuration rather than hard-coding it', () => {
    const tau = tauSeconds({ preset: 'social-feed' });
    assert.ok(Math.abs(tau - 2 * (10 ** (1 / 1.5) - 1) * 3600) < 1e-6);
    assert.ok(sql.includes(String(Number(tau.toPrecision(12)))));
  });

  it('documents the immutability trap in the emitted comments', () => {
    assert.match(sql, /not immutable/);
  });

  it('refuses to emit when gravity is zero, where there is nothing to decay', () => {
    assert.throws(() => toSQL({ preset: 'social-feed', gravity: 0 }, 'A'), RankingError);
  });
});

describe('mysql dialect', () => {
  it('uses log10() and timestampdiff()', () => {
    const sql = toSQL({ preset: 'social-feed', dialect: 'mysql' }, 'B');
    assert.match(sql, /log10\(1 \+/);
    assert.ok(sql.includes('timestampdiff(second, `created_at`, now()) / 3600.0'), sql);
  });
});

describe('refusals', () => {
  it('will not translate a custom engagement callback', () => {
    assert.throws(() => toSQL({ preset: 'social-feed', engagement: () => 1 }), /cannot be translated/);
  });

  it('will not interpolate anything that is not a plain identifier', () => {
    assert.throws(() => toSQL({ table: 'posts; drop table users --' }), RankingError);
    assert.throws(() => toSQL({ preset: 'social-feed', columns: { like: '"weird name"' } }), RankingError);
  });

  it('rejects an unknown dialect', () => {
    assert.throws(() => toSQL({ dialect: 'oracle' }), /postgres, mysql/);
  });
});

describe('cross-SDK SQL parity', () => {
  // All four SDKs emit these byte-for-byte. If one drifts, its suite fails here.
  const expected = JSON.parse(
    readFileSync(new URL('../../../conformance/cases.json', import.meta.url), 'utf8'),
  ).sqlExpressions;

  for (const [key, want] of Object.entries(expected)) {
    it(key, () => {
      const [preset, dialect] = key.split('/');
      assert.equal(sqlExpression({ preset, dialect }, 'B'), want);
    });
  }
});
