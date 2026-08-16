# Cross-SDK conformance

`cases.json` is the contract between the four SDKs. Each one reads this file in
its own test suite and must reproduce `expected` exactly, within `tolerance`
(1e-9). A change that shifts one implementation's output fails in all four.

It is what makes the claim on the tin — *TypeScript, JavaScript, Python and Go
produce identical orderings* — a thing CI checks rather than a thing the README
asserts.

## What it covers

| Case | What it pins down |
| --- | --- |
| social-feed preset, mixed ages | the default path, across five orders of magnitude of age |
| ecommerce preset | a catalogue spanning a year, where the plateau matters |
| cold start | a fresh empty item outranks an old empty one, and both are finite |
| exact tie | equal scores break on id, ascending |
| gravity 0 | time is ignored entirely |
| custom weights | a non-preset config, a negative weight, custom `dateField` and `idField` |
| bayesian smoothing | 200 reviews at 4.8 beat one 5★ review; an unreviewed item sits at the prior |
| clamp policy | future-dated items admitted as brand new |

`sqlExpressions` pins the emitted SQL byte-for-byte across all four SDKs, for both
presets and both dialects. Only strategy B is compared this way: strategy A's `τ`
is a float whose shortest round-trip representation is not guaranteed to agree
across language runtimes, so each SDK asserts it numerically in its own suite.

## Regenerating

The TypeScript SDK is the reference implementation. After a deliberate behaviour
change:

```bash
npm run build                              # in sdk/typescript
node scripts/generate-conformance.mjs      # rewrites the expected block
```

CI runs `--check` and fails if the committed file is stale.

**Regenerating is not a way to make a failing test pass.** If Python or Go
disagrees with this file, the bug is in that SDK — or the change was not as
deliberate as it looked. Regenerate only when you intended the numbers to move,
and say so in the CHANGELOG.

## Adding a case

Append to `cases` with `name`, `now`, `config` and `items`, leaving `expected`
out, then regenerate. The new case is picked up by all four test suites
automatically — nothing to wire up per SDK.

Config keys use the wire spelling (`graceHours`, `dateField`, `onFutureItem`); the
Python and Go suites translate them to their own naming in their test harnesses.

## Changing the spec version

`specVersion` must match the `SPEC_VERSION` every SDK exports;
`scripts/sync-version.mjs` verifies this and the release workflow refuses to
publish otherwise. Bumping it means the four SDKs now rank differently from the
previous major, so it can only happen in a major release.
