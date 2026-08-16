#!/usr/bin/env node
// Prove that toSQL() really does reproduce the library's ordering, by running the
// emitted expression against a live Postgres and comparing against the same
// fixture the four SDKs are held to.
//
//   DATABASE_URL=postgres://... node scripts/sql-parity.mjs
//   node scripts/sql-parity.mjs --emit-only    write the script, run nothing
//
// Requires the `psql` client and sdk/typescript to be built. CI provides both;
// --emit-only needs neither and is how you inspect the SQL by hand.
//
// The emitted strategy-B expression calls now(), which would make the result
// depend on when the test runs. Each case carries its own reference instant, so
// now() is substituted with that literal — the only edit made to the generated
// SQL, and the reason a fixed `now` is injectable in the first place.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const fixturePath = fileURLToPath(new URL('../conformance/cases.json', import.meta.url));
const scratch = process.env.RUNNER_TEMP ?? '/tmp';
const sqlPath = `${scratch}/ranking-sql-parity.sql`;

const { rankWithScores, sqlExpression } = await import(
  new URL('../sdk/typescript/dist/esm/index.js', import.meta.url).href
);

const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
const emitOnly = process.argv.includes('--emit-only');
const url = process.env.DATABASE_URL;
if (!url && !emitOnly) {
  console.error('Set DATABASE_URL to a Postgres connection string, or pass --emit-only.');
  process.exit(1);
}

const quote = (name) => `"${name}"`;
const literal = (text) => `'${String(text).replaceAll("'", "''")}'`;

const statements = [];
const cases = [];

for (const [index, testCase] of fixture.cases.entries()) {
  const config = testCase.config;

  // A future-dated item gives log() a negative argument, which Postgres rejects
  // outright. The clamp policy is a library-side behaviour with no SQL analogue,
  // so those cases are checked in the unit suites instead.
  if (config.onFutureItem === 'clamp') continue;
  if (config.engagement) continue;

  const idField = config.idField ?? 'id';
  const dateField = config.dateField ?? 'createdAt';
  const table = `parity_${index}`;

  const numericFields = new Set();
  for (const item of testCase.items) {
    for (const [key, value] of Object.entries(item)) {
      if (typeof value === 'number') numericFields.add(key);
    }
  }
  const columns = [...numericFields].sort();

  statements.push(
    `DROP TABLE IF EXISTS ${quote(table)};`,
    `CREATE TABLE ${quote(table)} (` +
      [
        `${quote(idField)} text`,
        `${quote(dateField)} timestamptz`,
        ...columns.map((c) => `${quote(c)} double precision`),
      ].join(', ') +
      `);`,
  );

  for (const item of testCase.items) {
    const values = [
      literal(item[idField]),
      `${literal(item[dateField])}::timestamptz`,
      ...columns.map((c) => String(item[c] ?? 0)),
    ];
    statements.push(`INSERT INTO ${quote(table)} VALUES (${values.join(', ')});`);
  }

  const expression = sqlExpression({ ...config, dateColumn: dateField }, 'B').replaceAll(
    'now()',
    `${literal(testCase.now)}::timestamptz`,
  );

  statements.push(
    `\\echo CASE ${index}`,
    `SELECT ${quote(idField)} FROM ${quote(table)} ` +
      `ORDER BY (${expression}) DESC, ${quote(idField)} ASC;`,
  );

  cases.push({
    index,
    name: testCase.name,
    expected: rankWithScores(testCase.items, { ...config, now: testCase.now }).map((entry) =>
      String(entry.item[idField]),
    ),
  });
}

writeFileSync(sqlPath, `${statements.join('\n')}\n`);

if (emitOnly) {
  console.log(readFileSync(sqlPath, 'utf8'));
  console.error(`sql-parity: wrote ${cases.length} cases to ${sqlPath}; nothing was executed.`);
  process.exit(0);
}

const output = execFileSync('psql', [url, '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-f', sqlPath], {
  encoding: 'utf8',
});

// Split the output back into per-case id lists using the \echo markers.
const results = new Map();
let current = null;
for (const line of output.split('\n')) {
  const marker = line.match(/^CASE (\d+)$/);
  if (marker) {
    current = Number(marker[1]);
    results.set(current, []);
    continue;
  }
  const trimmed = line.trim();
  if (current !== null && trimmed !== '') results.get(current).push(trimmed);
}

let failures = 0;
for (const testCase of cases) {
  const got = results.get(testCase.index) ?? [];
  const same = got.length === testCase.expected.length && got.every((id, i) => id === testCase.expected[i]);
  if (same) {
    console.log(`  ok   ${testCase.name}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${testCase.name}`);
    console.error(`       postgres: ${got.join(', ')}`);
    console.error(`       library:  ${testCase.expected.join(', ')}`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} case(s) where toSQL() and the library disagree.`);
  process.exit(1);
}
console.log(`\nsql-parity: ${cases.length} cases, Postgres and the library agree on every ordering.`);
