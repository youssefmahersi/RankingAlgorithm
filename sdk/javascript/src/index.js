/**
 * Deterministic, dependency-free ranking for feeds and catalogues.
 *
 *     score = log10(1 + sum(w_i * p_i)) - g * log10(t + t0)
 *
 * One file, no build step, standard ESM. Drop it into a browser with
 * `<script type="module">`, import it from Deno by URL, or `npm i
 * @youssefmahersi/ranking-js` for Node. If you want CommonJS or TypeScript
 * source, use `@youssefmahersi/ranking` instead — the two are held to the same
 * conformance fixture and produce identical orderings.
 *
 * @module
 */

/** Release of this SDK. Kept in sync across all four by scripts/sync-version.mjs. */
export const VERSION = '2.0.0';

/** Major revision of the ranking specification implemented here. */
export const SPEC_VERSION = 2;

/** The scoring formula, for logs, docs and `explain()` output. */
export const FORMULA = 'score = log10(1 + sum(w_i * p_i)) - g * log10(t + t0)';

const MS_PER_HOUR = 3600000;

/** Every error thrown by this library is a `RankingError`. */
export class RankingError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'RankingError';
  }
}

/**
 * Presets are the product; configuration is the advanced option.
 *
 * `social-feed`: a 24 h old item needs ~47x the engagement of a fresh one to tie,
 * ~125x at 48 h. Content is effectively dead in two days.
 *
 * `ecommerce`: a 90-day-old product needs only ~2.8x the sales of a new one, and
 * over a full year the penalty reaches only ~4.2x — a genuine best-seller stays
 * on top for years while remaining separable by age.
 */
export const PRESETS = Object.freeze({
  'social-feed': Object.freeze({
    gravity: 1.5,
    graceHours: 2,
    signals: Object.freeze({ like: 1, comment: 3, share: 5 }),
    dateField: 'createdAt',
    idField: 'id',
    onFutureItem: 'error',
  }),
  ecommerce: Object.freeze({
    gravity: 0.3,
    graceHours: 72,
    signals: Object.freeze({ view: 0.05, cart: 1, purchase: 10 }),
    dateField: 'createdAt',
    idField: 'id',
    onFutureItem: 'error',
  }),
});

/** The preset used when none is named. */
export const DEFAULT_PRESET = 'social-feed';

/** 2020-01-01T00:00:00Z. Counting from here rather than 1970 preserves float precision. */
export const EPOCH_OFFSET_2020 = 1577836800;

/* ------------------------------------------------------------------ config */

/**
 * Merge a preset with caller overrides and validate the result.
 *
 * @param {object} [options]
 * @returns {object} a fully resolved configuration
 */
export function resolveConfig(options = {}) {
  const presetName = options.preset ?? DEFAULT_PRESET;
  const base = PRESETS[presetName];
  if (base === undefined) {
    throw new RankingError(
      `Unknown preset ${JSON.stringify(presetName)}. Available: ${Object.keys(PRESETS).join(', ')}.`,
    );
  }

  const config = { ...base };
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined && key !== 'preset') config[key] = value;
  }

  validate(config);
  return config;
}

/** @param {object} config */
function validate(config) {
  if (!Number.isFinite(config.gravity)) {
    throw new RankingError(`gravity must be a finite number, received ${String(config.gravity)}.`);
  }
  if (config.gravity < 0) {
    throw new RankingError(
      `gravity must be >= 0, received ${config.gravity}. A negative gravity ranks old items first.`,
    );
  }
  if (!Number.isFinite(config.graceHours) || config.graceHours <= 0) {
    throw new RankingError(
      `graceHours must be a finite number > 0, received ${String(config.graceHours)}. ` +
        'It is what keeps log10(t + t0) finite at t = 0.',
    );
  }
  for (const [field, weight] of Object.entries(config.signals)) {
    if (!Number.isFinite(weight)) {
      throw new RankingError(
        `Weight for signal ${JSON.stringify(field)} must be a finite number, received ${String(weight)}.`,
      );
    }
  }
  if (config.onFutureItem !== 'error' && config.onFutureItem !== 'clamp') {
    throw new RankingError(`onFutureItem must be 'error' or 'clamp', received ${JSON.stringify(config.onFutureItem)}.`);
  }
  if (config.bayesian) {
    const { prior, priorCount, weight } = config.bayesian;
    if (!Number.isFinite(prior) || !Number.isFinite(priorCount) || !Number.isFinite(weight)) {
      throw new RankingError('bayesian.prior, bayesian.priorCount and bayesian.weight must all be finite numbers.');
    }
    if (priorCount < 0) throw new RankingError(`bayesian.priorCount must be >= 0, received ${priorCount}.`);
  }
}

/* -------------------------------------------------------------- primitives */

/**
 * Read a numeric field, treating a missing field as zero.
 * @param {object} item
 * @param {string} field
 * @returns {number}
 */
function numberAt(item, field) {
  const raw = item?.[field];
  if (raw === undefined || raw === null) return 0;
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(value)) {
    throw new RankingError(`Field ${JSON.stringify(field)} must be a finite number, received ${JSON.stringify(raw)}.`);
  }
  return value;
}

/**
 * Normalise `Date | ISO string | epoch milliseconds` to epoch milliseconds.
 * @param {Date|string|number} value
 * @param {string} label
 * @returns {number}
 */
export function toEpochMs(value, label) {
  if (value instanceof Date) {
    const ms = value.getTime();
    if (Number.isNaN(ms)) throw new RankingError(`${label} is an Invalid Date.`);
    return ms;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new RankingError(`${label} must be finite epoch milliseconds, received ${value}.`);
    return value;
  }
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) throw new RankingError(`${label} is not a parsable date: ${JSON.stringify(value)}.`);
    return ms;
  }
  throw new RankingError(
    `${label} must be a Date, an ISO 8601 string or epoch milliseconds, received ${typeof value}.`,
  );
}

/**
 * The Bayesian term, or `null` when smoothing is disabled.
 *
 * Kept separate from the weighted sum so `explain()` can report it on its own
 * line — it is an opt-in exception to "no ML, no heuristics", and hiding it
 * inside the signal list would misrepresent the score.
 */
function bayesianTerm(item, config) {
  const b = config.bayesian;
  if (!b) return null;
  const average = numberAt(item, b.ratingField);
  const count = numberAt(item, b.countField);
  const denominator = b.priorCount + count;
  const smoothed = denominator === 0 ? b.prior : (b.priorCount * b.prior + count * average) / denominator;
  return { average, count, smoothed, weight: b.weight, contribution: b.weight * smoothed };
}

function engagementWith(item, config) {
  if (config.engagement) {
    const value = config.engagement(item);
    if (!Number.isFinite(value)) {
      throw new RankingError(`The engagement() callback must return a finite number, received ${String(value)}.`);
    }
    return value;
  }
  let total = 0;
  for (const [field, weight] of Object.entries(config.signals)) {
    total += weight * numberAt(item, field);
  }
  const bayes = bayesianTerm(item, config);
  if (bayes) total += bayes.contribution;
  return total;
}

function qualityWith(item, config) {
  if (config.qualityField !== undefined && item?.[config.qualityField] !== undefined) {
    return numberAt(item, config.qualityField);
  }
  const total = engagementWith(item, config);
  if (total < -1) {
    throw new RankingError(
      `Engagement sum is ${total}; log10(1 + sum) is undefined below -1. ` +
        'Negative weights large enough to push the sum under -1 are not supported — this library has no moderation logic.',
    );
  }
  return Math.log10(1 + total);
}

function assertAge(ageHours, config) {
  if (!Number.isFinite(ageHours)) {
    throw new RankingError(`Age must be a finite number of hours, received ${String(ageHours)}.`);
  }
  if (ageHours < 0) {
    if (config.onFutureItem === 'clamp') return 0;
    throw new RankingError(
      `Age is ${ageHours} hours: the item is published in the future relative to \`now\`. ` +
        'A negative age silently inverts the ranking, so it is rejected. ' +
        "Pass { onFutureItem: 'clamp' } to treat future items as brand new instead.",
    );
  }
  return ageHours;
}

function timePenaltyWith(ageHours, config) {
  if (config.gravity === 0) return 0;
  return config.gravity * Math.log10(ageHours + config.graceHours);
}

function ageHoursWith(item, config) {
  const nowMs = config.now === undefined ? Date.now() : toEpochMs(config.now, 'now');
  const raw = config.getDate ? config.getDate(item) : item?.[config.dateField];
  if (raw === undefined || raw === null) {
    throw new RankingError(
      `Item is missing its publication date. Expected field ${JSON.stringify(config.dateField)}; ` +
        'set `dateField` or pass a `getDate(item)` function.',
    );
  }
  const createdMs = toEpochMs(raw, `Field ${JSON.stringify(config.dateField)}`);
  return assertAge((nowMs - createdMs) / MS_PER_HOUR, config);
}

/* ------------------------------------------------------------ public: score */

/** `sum(w_i * p_i)` — the raw, pre-log engagement of an item. */
export function engagement(item, options = {}) {
  return engagementWith(item, resolveConfig(options));
}

/**
 * `log10(1 + sum(w_i * p_i))` — the time-independent half of the score.
 *
 * This is the half you can store in a column and index: it only changes when
 * engagement changes, not on every tick of the clock. `rank()` reads it back
 * from `config.qualityField` if you tell it where you put it.
 */
export function quality(item, options = {}) {
  return qualityWith(item, resolveConfig(options));
}

/**
 * `g * log10(t + t0)` — the time-dependent half, applied at query time.
 *
 * It is subtracted, and it is negative while `t + t0 < 1`. Only differences
 * between items matter, so the sign carries no meaning.
 */
export function timePenalty(ageHours, options = {}) {
  const config = resolveConfig(options);
  return timePenaltyWith(assertAge(ageHours, config), config);
}

/** Age of an item in hours at `now`, validated against the future policy. */
export function ageHours(item, options = {}) {
  return ageHoursWith(item, resolveConfig(options));
}

/** The score of a single item: `quality - timePenalty`. Higher ranks first. */
export function score(item, options = {}) {
  const config = resolveConfig(options);
  return qualityWith(item, config) - timePenaltyWith(ageHoursWith(item, config), config);
}

/**
 * Full decomposition of a score: every signal's contribution, the time penalty,
 * the final number.
 *
 * This is the "not AI" argument made tangible — and the fastest way to find out
 * why an item you expected on top is not.
 */
export function explain(item, options = {}) {
  const config = resolveConfig(options);
  const total = engagementWith(item, config);
  const bayes = bayesianTerm(item, config);
  const share = (contribution) => (total === 0 ? 0 : contribution / total);

  // Signal names are reported in sorted order in every SDK, so the breakdown does
  // not depend on how the signals object was written (and Go, whose maps have no
  // order at all, can agree).
  const signals = config.engagement
    ? []
    : Object.keys(config.signals)
        .sort()
        .map((field) => {
          const weight = config.signals[field];
          const value = numberAt(item, field);
          const contribution = weight * value;
          return { field, value, weight, contribution, share: share(contribution) };
        });

  const q = qualityWith(item, config);
  const age = ageHoursWith(item, config);
  const penalty = timePenaltyWith(age, config);
  const rawId = item?.[config.idField];

  return {
    id: rawId === undefined || rawId === null ? null : String(rawId),
    engagement: total,
    signals,
    ...(bayes ? { bayesian: bayes } : {}),
    quality: q,
    ageHours: age,
    timePenalty: penalty,
    score: q - penalty,
    config: { gravity: config.gravity, graceHours: config.graceHours },
    formula: FORMULA,
  };
}

/* ------------------------------------------------------------- public: rank */

/**
 * Pin `now` once for the whole batch.
 *
 * Without this, `Date.now()` is read per item and a long array can be scored
 * across a clock tick — two items with identical inputs would then get different
 * penalties.
 */
function freezeNow(config) {
  return config.now === undefined ? { ...config, now: Date.now() } : config;
}

function idOf(item, idField) {
  const raw = item?.[idField];
  return raw === undefined || raw === null ? null : String(raw);
}

/**
 * Order items best-first.
 *
 * Returns a new array; the input is not mutated. Ties break on the stable id
 * (ascending), then on input position, so repeated calls on the same data always
 * produce the same order.
 */
export function rank(items, options = {}) {
  return rankWithScores(items, options).map((entry) => entry.item);
}

/** Like `rank()`, but keeps each item's score. */
export function rankWithScores(items, options = {}) {
  if (!Array.isArray(items)) {
    throw new TypeError(`rank() expects an array of items, received ${typeof items}.`);
  }
  const config = freezeNow(resolveConfig(options));

  const entries = items.map((item, index) => ({
    item,
    index,
    score: qualityWith(item, config) - timePenaltyWith(ageHoursWith(item, config), config),
    id: idOf(item, config.idField),
  }));

  entries.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.id !== null && b.id !== null && a.id !== b.id) return a.id < b.id ? -1 : 1;
    return a.index - b.index;
  });

  return entries.map(({ item, score: value }) => ({ item, score: value }));
}

/**
 * Top `n` items, best-first.
 *
 * Still a full sort — this library is the rescoring stage of a funnel, sized for
 * a few hundred to a few thousand in-memory candidates, not for a table scan.
 * Bound the candidate set in SQL first; see `toSQL()`.
 */
export function top(items, n, options = {}) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError(`top() expects a non-negative integer, received ${String(n)}.`);
  }
  return rank(items, options).slice(0, n);
}

/* ----------------------------------------------------------- public: tuning */

/**
 * Tuning protocol.
 *
 * Do not tune by trial and error. Answer one product question — "an item X hours
 * old, how many times more engagement must it have to beat a brand-new one?" —
 * and invert it:
 *
 *     g = log(ratio) / log((X + t0) / t0)
 *
 * Set `graceHours` first ("how long does content get to start?"), then solve for
 * gravity. The two interact strongly: raising `graceHours` flattens the entire
 * time penalty, not just the early window, so re-solve gravity whenever you
 * change it.
 */
export function solveGravity({ ratio, afterHours, graceHours }) {
  if (!(ratio > 0)) throw new RankingError(`ratio must be > 0, received ${String(ratio)}.`);
  if (!(afterHours > 0)) throw new RankingError(`afterHours must be > 0, received ${String(afterHours)}.`);
  if (!(graceHours > 0)) throw new RankingError(`graceHours must be > 0, received ${String(graceHours)}.`);
  return Math.log(ratio) / Math.log((afterHours + graceHours) / graceHours);
}

/**
 * The forward direction: how much more engagement an item `afterHours` old needs
 * to tie with a brand-new one. Use it to sanity-check a configuration.
 */
export function engagementRatio(afterHours, options = {}) {
  const config = resolveConfig(options);
  if (!(afterHours >= 0)) throw new RankingError(`afterHours must be >= 0, received ${String(afterHours)}.`);
  return ((afterHours + config.graceHours) / config.graceHours) ** config.gravity;
}

/**
 * Hours until the time penalty is worth exactly one factor of ten in engagement:
 * "after this long, you need 10x the engagement to hold your place".
 */
export function decadeHours(options = {}) {
  const config = resolveConfig(options);
  if (config.gravity === 0) return Infinity;
  return config.graceHours * (10 ** (1 / config.gravity) - 1);
}

/**
 * The exponential-family time constant that best matches this configuration, in
 * seconds — the `tau` used by SQL strategy A. The two curves are matched at the
 * point both parameter families are defined by: one factor of ten in engagement.
 */
export function tauSeconds(options = {}) {
  return decadeHours(options) * 3600;
}

/* -------------------------------------------------------------- public: SQL */

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/** Validate a name and return it bare. Anything needing escaping is rejected. */
function identifier(name, label) {
  if (!IDENTIFIER.test(name)) {
    throw new RankingError(
      `${label} ${JSON.stringify(name)} is not a plain SQL identifier. ` +
        'Pass a bare name matching [A-Za-z_][A-Za-z0-9_$]*, or write the SQL by hand.',
    );
  }
  return name;
}

/**
 * Quote an identifier for the target dialect.
 *
 * Everything is quoted, always. `like` — the default weight name in the
 * `social-feed` preset — is a reserved word in Postgres, so bare emission
 * produces a syntax error on the default path. Quoting also preserves the case of
 * camelCase columns, which is what ORM-created schemas usually have.
 */
function quoted(name, label, dialect) {
  const bare = identifier(name, label);
  return dialect === 'mysql' ? `\`${bare}\`` : `"${bare}"`;
}

/** Trim float noise so the emitted SQL stays readable. */
function num(value) {
  const rounded = Number(value.toPrecision(12));
  return Number.isInteger(rounded) ? `${rounded}.0` : String(rounded);
}

function logFn(dialect) {
  // Postgres `log(x)` is already base 10; MySQL needs log10() since log() is natural.
  return dialect === 'postgres' ? 'log' : 'log10';
}

function engagementSQL(config, options, dialect) {
  if (config.engagement) {
    throw new RankingError(
      'A custom engagement() callback cannot be translated to SQL. ' +
        'Express the same thing as { signals } weights, or write the expression by hand.',
    );
  }
  const columns = options.columns ?? {};
  const terms = [];
  // Sorted, so the emitted SQL does not depend on how the signals object was
  // written — and so Go, whose maps have no iteration order, can match it.
  for (const field of Object.keys(config.signals).sort()) {
    const weight = config.signals[field];
    if (weight === 0) continue;
    const column = quoted(columns[field] ?? field, 'Column', dialect);
    terms.push(weight === 1 ? column : `${num(weight)} * ${column}`);
  }

  if (config.bayesian) {
    const { ratingField, countField, prior, priorCount, weight } = config.bayesian;
    const rating = quoted(columns[ratingField] ?? ratingField, 'Column', dialect);
    const count = quoted(columns[countField] ?? countField, 'Column', dialect);
    terms.push(
      `${num(weight)} * ((${num(priorCount)} * ${num(prior)} + ${count} * ${rating}) ` +
        `/ nullif(${num(priorCount)} + ${count}, 0))`,
    );
  }

  return terms.length === 0 ? '0' : terms.join(' + ');
}

/** Just the score expression, without the surrounding statement. */
export function sqlExpression(options = {}, strategy = 'B') {
  const config = resolveConfig(options);
  const dialect = options.dialect ?? 'postgres';
  const log = logFn(dialect);
  const sum = engagementSQL(config, options, dialect);

  if (strategy === 'A') {
    const epoch = quoted(options.epochColumn ?? 'created_epoch', 'Column', dialect);
    const tau = options.tauSeconds ?? tauSeconds(options);
    const offset = options.epochOffset ?? EPOCH_OFFSET_2020;
    if (!Number.isFinite(tau) || tau <= 0) {
      throw new RankingError(
        'Strategy A needs a finite, positive tau. With gravity = 0 time is ignored entirely, ' +
          'so there is nothing to index on — rank by engagement alone.',
      );
    }
    return `${log}(1 + ${sum}) + (${epoch} - ${num(offset)}) / ${num(tau)}`;
  }

  const dateColumn = quoted(options.dateColumn ?? 'created_at', 'Column', dialect);
  const age =
    dialect === 'postgres'
      ? `extract(epoch from now() - ${dateColumn}) / 3600.0`
      : `timestampdiff(second, ${dateColumn}, now()) / 3600.0`;
  return `${log}(1 + ${sum}) - ${num(config.gravity)} * ${log}((${age}) + ${num(config.graceHours)})`;
}

/**
 * Emit the SQL equivalent of a configuration.
 *
 * **The question that decides everything: does `now` cancel when comparing two
 * rows?** Under the power law time sits inside a log, so it does not cancel —
 * the order genuinely changes as the clock moves, and no static index can hold
 * it. Under the exponential family time enters linearly and `now` cancels
 * completely: only the difference of publication dates matters, and that never
 * changes. This is why Reddit's formula is linear in time, and it was not an
 * accident.
 *
 * - **Strategy A** (high volume): an indexed generated column. Frozen order,
 *   constant-cost index scan, recomputed on a vote rather than every second.
 *   Recommended for `social-feed`.
 * - **Strategy B** (power law, bounded window): the exact formula over a
 *   candidate set the `WHERE` clause has already cut to a few thousand rows.
 *   Valid whenever the relevance window is bounded — true of a feed, never of a
 *   catalogue. Recommended for `ecommerce` with a nightly batch recompute.
 */
export function toSQL(options = {}, strategy = 'B') {
  const dialect = options.dialect ?? 'postgres';
  if (dialect !== 'postgres' && dialect !== 'mysql') {
    throw new RankingError(`Unsupported dialect ${JSON.stringify(dialect)}. Supported: postgres, mysql.`);
  }
  const tableName = identifier(options.table ?? 'posts', 'Table');
  const table = quoted(tableName, 'Table', dialect);
  const limit = options.limit ?? 20;
  const expression = sqlExpression(options, strategy);

  if (strategy === 'A') {
    const scoreName = identifier(options.scoreColumn ?? 'hot', 'Column');
    const scoreColumn = quoted(scoreName, 'Column', dialect);
    const epochColumn = identifier(options.epochColumn ?? 'created_epoch', 'Column');
    const type = dialect === 'postgres' ? 'double precision' : 'double';
    return [
      `-- Strategy A: indexed generated column. Order is frozen, so the index stays valid.`,
      `-- ${epochColumn} must be a plain bigint written at insert time:`,
      `--   ${dialect === 'postgres' ? 'extract(epoch from created_at)' : 'unix_timestamp(created_at)'} is not immutable on a timestamp`,
      `--   with time zone, and generated columns must be immutable.`,
      `ALTER TABLE ${table} ADD COLUMN ${scoreColumn} ${type}`,
      `  GENERATED ALWAYS AS (`,
      `    ${expression}`,
      `  ) STORED;`,
      ``,
      `CREATE INDEX ${quoted(`${tableName}_${scoreName}_idx`, 'Index', dialect)} ON ${table} (${scoreColumn} DESC);`,
      ``,
      `SELECT * FROM ${table} ORDER BY ${scoreColumn} DESC LIMIT ${limit};`,
    ].join('\n');
  }

  const windowDays = options.windowDays ?? 7;
  if (!Number.isInteger(windowDays) || windowDays <= 0) {
    throw new RankingError(`windowDays must be a positive integer, received ${String(windowDays)}.`);
  }
  const dateColumn = quoted(options.dateColumn ?? 'created_at', 'Column', dialect);
  const window =
    dialect === 'postgres' ? `now() - interval '${windowDays} days'` : `now() - interval ${windowDays} day`;

  return [
    `-- Strategy B: exact power law over a bounded candidate set.`,
    `-- The WHERE clause uses an ordinary index on ${dateColumn} and cuts the set to a few`,
    `-- thousand rows; sorting that handful is free.`,
    `SELECT *,`,
    `       ${expression} AS score`,
    `FROM ${table}`,
    `WHERE ${dateColumn} > ${window}`,
    `ORDER BY score DESC`,
    `LIMIT ${limit};`,
  ].join('\n');
}
