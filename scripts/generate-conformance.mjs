#!/usr/bin/env node
// Fill in the `expected` block of conformance/cases.json from the TypeScript
// implementation, which is the reference for all four SDKs.
//
//   node scripts/generate-conformance.mjs          rewrite the file
//   node scripts/generate-conformance.mjs --check  fail if it is stale (CI)
//
// Requires sdk/typescript to be built first (`npm run build` there).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const casesPath = fileURLToPath(new URL('../conformance/cases.json', import.meta.url));
const sdkEntry = new URL('../sdk/typescript/dist/esm/index.js', import.meta.url);

let sdk;
try {
  sdk = await import(sdkEntry.href);
} catch (error) {
  console.error(`Could not load the TypeScript build from ${sdkEntry.pathname}`);
  console.error('Run `npm run build` in sdk/typescript first.');
  console.error(String(error));
  process.exit(1);
}

const { rankWithScores, explain, sqlExpression, SPEC_VERSION } = sdk;
const fixture = JSON.parse(readFileSync(casesPath, 'utf8'));

if (fixture.specVersion !== SPEC_VERSION) {
  console.error(`Fixture targets spec version ${fixture.specVersion} but the SDK implements ${SPEC_VERSION}.`);
  process.exit(1);
}

// Round to a fixed number of significant digits so that the committed file is
// stable across platforms; the tolerance in the fixture is looser than this.
const round = (n) => (Number.isFinite(n) ? Number(n.toPrecision(15)) : n);

for (const testCase of fixture.cases) {
  const options = { ...testCase.config, now: testCase.now };
  const ranked = rankWithScores(testCase.items, options);
  testCase.expected = ranked.map(({ item, score }) => {
    const detail = explain(item, options);
    return {
      id: detail.id,
      engagement: round(detail.engagement),
      quality: round(detail.quality),
      ageHours: round(detail.ageHours),
      timePenalty: round(detail.timePenalty),
      score: round(score),
    };
  });
}

// Strategy B only. Its constants come straight from the presets and print
// identically in all four languages; strategy A's tau is an irrational-looking
// float whose shortest round-trip representation is not guaranteed to agree
// byte-for-byte across language runtimes, so each SDK asserts it numerically in
// its own suite instead.
fixture.sqlExpressions = Object.fromEntries(
  [
    ['social-feed', 'postgres'],
    ['ecommerce', 'postgres'],
    ['social-feed', 'mysql'],
    ['ecommerce', 'mysql'],
  ].map(([preset, dialect]) => [`${preset}/${dialect}/B`, sqlExpression({ preset, dialect }, 'B')]),
);

const serialized = `${JSON.stringify(fixture, null, 2)}\n`;

if (process.argv.includes('--check')) {
  if (readFileSync(casesPath, 'utf8') !== serialized) {
    console.error('conformance/cases.json is out of date.');
    console.error('Run: node scripts/generate-conformance.mjs');
    process.exit(1);
  }
  console.log(`conformance: up to date (${fixture.cases.length} cases).`);
} else {
  writeFileSync(casesPath, serialized);
  console.log(`conformance: wrote ${fixture.cases.length} cases to conformance/cases.json`);
}
