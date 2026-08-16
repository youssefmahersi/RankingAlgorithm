// Cross-SDK SQL parity. All four SDKs emit these expressions byte-for-byte; if
// one drifts, its own suite fails here.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sqlExpression } from '../src/index.js';
import type { Dialect, PresetName } from '../src/index.js';

const { sqlExpressions } = JSON.parse(
  readFileSync(new URL('../../../conformance/cases.json', import.meta.url), 'utf8'),
) as { sqlExpressions: Record<string, string> };

describe('cross-SDK SQL parity', () => {
  for (const [key, want] of Object.entries(sqlExpressions)) {
    it(key, () => {
      const [preset, dialect] = key.split('/') as [PresetName, Dialect, string];
      expect(sqlExpression({ preset, dialect }, 'B')).toBe(want);
    });
  }
});
