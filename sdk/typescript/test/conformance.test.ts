// The shared cross-SDK fixture. The Python, Go and JavaScript suites read the
// same file and assert the same numbers, so a change that shifts one
// implementation's output fails in all four.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SPEC_VERSION, explain, rankWithScores } from '../src/index.js';

interface ExpectedRow {
  id: string | null;
  engagement: number;
  quality: number;
  ageHours: number;
  timePenalty: number;
  score: number;
}

interface Case {
  name: string;
  now: string;
  config: Record<string, unknown>;
  items: Record<string, unknown>[];
  expected: ExpectedRow[];
}

const fixture = JSON.parse(readFileSync(new URL('../../../conformance/cases.json', import.meta.url), 'utf8')) as {
  specVersion: number;
  tolerance: number;
  cases: Case[];
};

const digits = Math.round(-Math.log10(fixture.tolerance));

describe('conformance fixture', () => {
  it('targets the spec version this SDK implements', () => {
    expect(fixture.specVersion).toBe(SPEC_VERSION);
  });

  for (const testCase of fixture.cases) {
    describe(testCase.name, () => {
      const options = { ...testCase.config, now: testCase.now };
      const ranked = rankWithScores(testCase.items, options);

      it('produces the expected order', () => {
        expect(ranked.map((r) => String(r.item[(testCase.config.idField as string) ?? 'id']))).toEqual(
          testCase.expected.map((e) => e.id),
        );
      });

      it('produces the expected numbers', () => {
        ranked.forEach(({ item, score }, index) => {
          const want = testCase.expected[index]!;
          const detail = explain(item, options);
          expect(score).toBeCloseTo(want.score, digits);
          expect(detail.engagement).toBeCloseTo(want.engagement, digits);
          expect(detail.quality).toBeCloseTo(want.quality, digits);
          expect(detail.ageHours).toBeCloseTo(want.ageHours, digits);
          expect(detail.timePenalty).toBeCloseTo(want.timePenalty, digits);
        });
      });
    });
  }
});
