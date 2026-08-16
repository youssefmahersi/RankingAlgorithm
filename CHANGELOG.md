# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Since 2.0.0 the four SDKs share one version number and one **spec version**. The
spec version is the contract that says they rank identically; it is verified in CI
and can only change in a major release.

## [2.0.0] — 2026-08-16

Complete rewrite. New formula, new API, four SDKs. **Spec version 2.**

### The formula

```
score = log10(1 + Σ wᵢ·pᵢ) − g · log10(t + t₀)
```

This is algebraically `log(A/B)` — the same division as v1, in log space. The
ordering is rigorously identical because `log` is strictly increasing, and a test
asserts that against a naive `E / (t + t₀)^g` reference on a hundred items. The
benefit is numerical: no 5000× dynamic range, no float precision problems, and an
expression that pastes into SQL.

### Fixed — the four v1 defects

- **Unintended saturation.** v1's denominator tended to `1 + startValue ≈ 1`, so
  past a few multiples of `stretch` the score converged to the raw engagement sum
  and time stopped discriminating entirely — a day-old and a year-old item with
  equal engagement scored the same. The log form decays without bound.
- **Collapsed dynamic range.** With `startValue = 0.0002`, ~99.8% of the freshness
  boost was consumed in the first 10% of the tuning window, so `stretch`
  controlled only the region where nothing happened. `gravity` and `graceHours`
  now spread the decay across the whole window.
- **Coupled parameters.** `startValue` set both the peak and the knee of the
  curve, so tuning one knob silently moved the other and tuning was necessarily
  empirical. `gravity` and `graceHours` are orthogonal, and
  [`solveGravity()`](README.md#tuning) derives one from a product question rather
  than from guesses.
- **Cold start death spiral.** A zero engagement sum produced a zero score
  regardless of age, so a new item never surfaced and therefore never received
  engagement — the freshness boost multiplied zero. The `1 +` guarantees a finite
  score at zero engagement, and `graceHours` gives new content a window in which
  the age penalty is negligible.

### Added

- **Four SDKs**, all implementing spec version 2 and held to a
  [shared conformance fixture](conformance/cases.json) in CI:
  `@youssefmahersi/ranking` (TypeScript), `@youssefmahersi/ranking-js`
  (JavaScript), `rankingalgorithm` (Python), and
  `github.com/youssefmahersi/RankingAlgorithm/sdk/go/v2` (Go).
- **Presets.** `social-feed` and `ecommerce`. `rank(items)` with no arguments
  produces a sensible ordering.
- **`explain()`** returns the full decomposition: each signal's contribution and
  share, the quality half, the age, the time penalty, the final score.
- **`toSQL()`** emits the equivalent SQL for Postgres and MySQL, in two strategies
  — an indexed generated column (exponential family, frozen order) and the exact
  power law over a bounded candidate set. CI runs the emitted SQL against a real
  Postgres and asserts it produces the same ordering as the library.
- **`quality()` and `timePenalty()` are separately accessible.** The
  time-independent half can be stored and indexed; point `qualityField` at it and
  it is read back instead of recomputed.
- **The tuning protocol** as code: `solveGravity()`, `engagementRatio()`,
  `decadeHours()`, `tauSeconds()`.
- **`now` is injectable** everywhere — required for tests, for SQL parity, and for
  pagination stability. `rank()` pins it once per call so a long array is never
  scored across a clock tick.
- **Deterministic tie-break** on a stable id, then input position. Equal scores
  never reorder between calls.
- **Opt-in Bayesian smoothing** for star ratings, so a product with one 5★ review
  does not beat one with 200 reviews averaging 4.8. A separate term, off by
  default, never on the default path.
- **`onFutureItem`.** An item published after `now` gives `t < 0`, which would
  silently invert the ranking, so it raises. `'clamp'` admits scheduled content as
  brand new.
- **`VERSION`, `SPEC_VERSION` and `FORMULA`** exported by every SDK, kept in sync
  by `scripts/sync-version.mjs` and verified in CI.

### Changed — breaking

- **Object arguments, never positional.** v1 required arguments in config-array
  order, with a rule that a `ref` property had to appear immediately after its
  target. Signals are now passed by name.
- **`valuable` / `typeOfAdd` / `ref` collapsed.** One concept spread across three
  fields, with `""` as a meaningful value, is now `{ field: weight }`. For
  anything a weight cannot express, pass an `engagement(item) => number` callback
  — simpler and more powerful than a miniature expression language.
- **Field names are now used for lookup.** v1 declared `field: "nLikes"` but never
  looked anything up by it; the names were documentation, not data.
- **Package renamed** to `@youssefmahersi/ranking`. The v1 README instructed
  `npm install --save rannkingalgorithm` (double *n*) while the import was
  `rankingalgorithm` — the first thing a visitor tried was broken.
- **Signal order is canonical.** Signals are emitted and reported in sorted field
  order in every SDK, so output does not depend on how a map was written — and so
  Go, whose maps have no iteration order, can produce identical bytes.
- **SQL identifiers are quoted.** `like`, the default `social-feed` signal name, is
  a reserved word in Postgres, so bare emission was a syntax error on the default
  path. Quoting also preserves the case of camelCase columns.

### Deprecated

- **The v1 API** is preserved bug-for-bug behind a `/legacy` entry point
  (`rankingalgorithm.legacy` in Python) and emits a one-time deprecation notice.
  **It is removed in 3.0.0.** See [MIGRATION.md](MIGRATION.md).

### Repository

- GitHub Actions CI across four SDKs, five Python versions, three Node versions,
  three Go versions — plus a Postgres job for SQL parity, and a consistency job
  that fails if any SDK disagrees on the version or the spec revision. The build
  badge is real; Jest was configured in 1.x but never run in CI.
- TSLint (deprecated since 2019) replaced with ESLint + `typescript-eslint`; ruff
  and mypy `--strict` on the Python side; `gofmt` and `go vet` on the Go side.
- The MIT badge pointed at another repository's LICENSE
  (`tterb/atomic-design-ui`). It points here now.
- The formula diagrams lived on postimg.cc and would rot. GitHub renders LaTeX, so
  the formula is real text.
- The design brief is committed as [docs/SPEC.md](docs/SPEC.md).
- Proofread throughout. 1.x contained "propreties", "medieum", "constatnt",
  "ordre", and "NW" where "NB" was meant.

## [1.0.6] and earlier

See the git history. 1.x is unmaintained; the formula it implements has the four
defects listed above.

[2.0.0]: https://github.com/youssefmahersi/RankingAlgorithm/releases/tag/v2.0.0
