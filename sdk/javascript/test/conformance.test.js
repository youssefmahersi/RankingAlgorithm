// The shared cross-SDK fixture. The TypeScript, Python and Go suites read the
// same file and assert the same numbers, so a change that shifts one
// implementation's output fails in all four.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { SPEC_VERSION, explain, rankWithScores } from '../src/index.js';

const fixture = JSON.parse(readFileSync(new URL('../../../conformance/cases.json', import.meta.url), 'utf8'));
const tolerance = fixture.tolerance;

const close = (actual, expected, what) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: ${actual} !~= ${expected}`);

describe('conformance fixture', () => {
  it('targets the spec version this SDK implements', () => {
    assert.equal(fixture.specVersion, SPEC_VERSION);
  });

  for (const testCase of fixture.cases) {
    describe(testCase.name, () => {
      const options = { ...testCase.config, now: testCase.now };
      const idField = testCase.config.idField ?? 'id';

      it('produces the expected order', () => {
        assert.deepEqual(
          rankWithScores(testCase.items, options).map((r) => String(r.item[idField])),
          testCase.expected.map((e) => e.id),
        );
      });

      it('produces the expected numbers', () => {
        rankWithScores(testCase.items, options).forEach(({ item, score }, index) => {
          const want = testCase.expected[index];
          const detail = explain(item, options);
          close(score, want.score, `${want.id} score`);
          close(detail.engagement, want.engagement, `${want.id} engagement`);
          close(detail.quality, want.quality, `${want.id} quality`);
          close(detail.ageHours, want.ageHours, `${want.id} ageHours`);
          close(detail.timePenalty, want.timePenalty, `${want.id} timePenalty`);
        });
      });
    });
  }
});
