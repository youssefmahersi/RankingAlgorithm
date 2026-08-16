#!/usr/bin/env node
// Single source of truth for the release version across four SDKs.
//
//   node scripts/sync-version.mjs            write VERSION into every SDK
//   node scripts/sync-version.mjs --check    fail if anything is out of sync (CI)
//   node scripts/sync-version.mjs 2.1.0      set a new version, then write it
//
// Four independent package managers each want the version in their own file and
// their own syntax. Hand-editing five files and forgetting the sixth is how a
// release ships a Python wheel claiming 2.0.0 next to a Go module claiming 2.0.1,
// so the version lives in /VERSION and everything else is generated from it.
//
// SPEC_VERSION is checked too, but never rewritten: it is the contract that says
// "these four SDKs produce identical orderings". It changes only in a deliberate
// commit, alongside the conformance fixture.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const path = (relative) => fileURLToPath(new URL(relative, root));

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

const args = process.argv.slice(2);
const check = args.includes('--check');
const explicit = args.find((arg) => !arg.startsWith('--'));

if (explicit && check) {
  console.error('Pass a version or --check, not both.');
  process.exit(1);
}
if (explicit && !SEMVER.test(explicit)) {
  console.error(`${explicit} is not a semver version.`);
  process.exit(1);
}

if (explicit) writeFileSync(path('VERSION'), `${explicit}\n`);

const version = readFileSync(path('VERSION'), 'utf8').trim();
if (!SEMVER.test(version)) {
  console.error(`VERSION contains ${JSON.stringify(version)}, which is not a semver version.`);
  process.exit(1);
}
const major = Number(version.split('.')[0]);

// Each target names a file, a pattern that must match exactly once, and how to
// rebuild that line from the version.
const targets = [
  { file: 'package.json', find: /("version":\s*")[^"]+(")/, build: (a, b) => `${a}${version}${b}` },
  { file: 'sdk/typescript/package.json', find: /("version":\s*")[^"]+(")/, build: (a, b) => `${a}${version}${b}` },
  { file: 'sdk/javascript/package.json', find: /("version":\s*")[^"]+(")/, build: (a, b) => `${a}${version}${b}` },
  { file: 'sdk/typescript/src/version.ts', find: /(export const VERSION = ')[^']+(')/, build: (a, b) => `${a}${version}${b}` },
  { file: 'sdk/javascript/src/index.js', find: /(export const VERSION = ')[^']+(')/, build: (a, b) => `${a}${version}${b}` },
  { file: 'sdk/python/pyproject.toml', find: /(\nversion = ")[^"]+(")/, build: (a, b) => `${a}${version}${b}` },
  { file: 'sdk/python/src/rankingalgorithm/version.py', find: /(VERSION = ")[^"]+(")/, build: (a, b) => `${a}${version}${b}` },
  { file: 'sdk/go/version.go', find: /(Version = ")[^"]+(")/, build: (a, b) => `${a}${version}${b}` },
];

// SPEC_VERSION must agree everywhere; it is verified, never rewritten.
const specTargets = [
  { file: 'sdk/typescript/src/version.ts', find: /export const SPEC_VERSION = (\d+)/ },
  { file: 'sdk/javascript/src/index.js', find: /export const SPEC_VERSION = (\d+)/ },
  { file: 'sdk/python/src/rankingalgorithm/version.py', find: /SPEC_VERSION = (\d+)/ },
  { file: 'sdk/go/version.go', find: /SpecVersion = (\d+)/ },
  { file: 'conformance/cases.json', find: /"specVersion":\s*(\d+)/ },
];

let stale = 0;
let failed = false;

for (const target of targets) {
  const file = path(target.file);
  const before = readFileSync(file, 'utf8');
  const matches = before.match(new RegExp(target.find, 'g'));
  if (!matches || matches.length !== 1) {
    console.error(`${target.file}: expected exactly one version line, found ${matches ? matches.length : 0}.`);
    failed = true;
    continue;
  }
  const after = before.replace(target.find, (_, a, b) => target.build(a, b));
  if (after === before) continue;

  stale += 1;
  if (check) {
    console.error(`${target.file}: does not carry version ${version}.`);
  } else {
    writeFileSync(file, after);
    console.log(`  updated ${target.file}`);
  }
}

const specVersions = new Map();
for (const target of specTargets) {
  const found = readFileSync(path(target.file), 'utf8').match(target.find);
  if (!found) {
    console.error(`${target.file}: no SPEC_VERSION found.`);
    failed = true;
    continue;
  }
  specVersions.set(target.file, Number(found[1]));
}

const distinct = new Set(specVersions.values());
if (distinct.size > 1) {
  console.error('SPEC_VERSION disagrees between SDKs:');
  for (const [file, value] of specVersions) console.error(`  ${file}: ${value}`);
  console.error('All four SDKs must implement the same spec revision, or they will rank differently.');
  failed = true;
} else if (distinct.size === 1 && ![...distinct][0]) {
  console.error('SPEC_VERSION is 0 or unparsable.');
  failed = true;
} else if (distinct.size === 1 && [...distinct][0] !== major) {
  console.error(
    `SPEC_VERSION is ${[...distinct][0]} but the release version is ${version}. ` +
      'A major release must bump the spec version, and a spec version bump is a major release.',
  );
  failed = true;
}

if (failed) process.exit(1);

if (check) {
  if (stale > 0) {
    console.error(`\n${stale} file(s) out of sync. Run: node scripts/sync-version.mjs`);
    process.exit(1);
  }
  console.log(`version: all SDKs report ${version}, spec version ${[...distinct][0]}.`);
} else {
  console.log(
    stale === 0
      ? `version: already at ${version} everywhere (spec version ${[...distinct][0]}).`
      : `version: synced ${stale} file(s) to ${version} (spec version ${[...distinct][0]}).`,
  );
}
