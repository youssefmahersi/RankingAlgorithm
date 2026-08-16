import { RankingError } from './errors.js';
import { resolveConfig } from './presets.js';
import { tauSeconds } from './tuning.js';
import type { RankingConfig, RankingOptions } from './types.js';

/** SQL dialects with a tested emitter. */
export type Dialect = 'postgres' | 'mysql';

/**
 * `'B'` reproduces the library's power law exactly, over a bounded candidate set.
 * `'A'` swaps the power law for the exponential family so the ordering is fixed
 * and therefore indexable. See `toSQL()` for why that choice is forced.
 */
export type Strategy = 'A' | 'B';

export interface SQLOptions extends RankingOptions {
  /** Table to read from. Defaults to `'posts'`. */
  readonly table?: string;
  /** Signal field -> column name, when they differ. */
  readonly columns?: Readonly<Record<string, string>>;
  /** Timestamp column, used by strategy B. Defaults to `'created_at'`. */
  readonly dateColumn?: string;
  /** Immutable `bigint` epoch column, required by strategy A. Defaults to `'created_epoch'`. */
  readonly epochColumn?: string;
  /** Name of the generated column in strategy A. Defaults to `'hot'`. */
  readonly scoreColumn?: string;
  /** Candidate window for strategy B, in days. Defaults to 7. */
  readonly windowDays?: number;
  /** `LIMIT` in the emitted `SELECT`. Defaults to 20. */
  readonly limit?: number;
  /** Override the derived exponential time constant of strategy A. */
  readonly tauSeconds?: number;
  /** Seconds subtracted from the epoch to keep the numbers small. Defaults to 2020-01-01. */
  readonly epochOffset?: number;
  readonly dialect?: Dialect;
}

/** 2020-01-01T00:00:00Z. Counting from here rather than 1970 preserves float precision. */
export const EPOCH_OFFSET_2020 = 1_577_836_800;

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/** Validate a name and return it bare. Anything needing escaping is rejected. */
function identifier(name: string, label: string): string {
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
function quoted(name: string, label: string, dialect: Dialect): string {
  const bare = identifier(name, label);
  return dialect === 'mysql' ? `\`${bare}\`` : `"${bare}"`;
}

/** Trim float noise so the emitted SQL stays readable. */
function num(value: number): string {
  const rounded = Number(value.toPrecision(12));
  return Number.isInteger(rounded) ? `${rounded}.0` : String(rounded);
}

function logFn(dialect: Dialect): string {
  // Postgres `log(x)` is already base 10; MySQL needs log10() since log() is natural.
  return dialect === 'postgres' ? 'log' : 'log10';
}

/** The `sum(w_i * p_i)` half, as a SQL expression. */
function engagementSQL(config: RankingConfig, options: SQLOptions, dialect: Dialect): string {
  if (config.engagement) {
    throw new RankingError(
      'A custom engagement() callback cannot be translated to SQL. ' +
        'Express the same thing as { signals } weights, or write the expression by hand.',
    );
  }
  const columns = options.columns ?? {};
  const terms: string[] = [];
  // Sorted, so the emitted SQL does not depend on how the signals object was
  // written — and so Go, whose maps have no iteration order, can match it.
  for (const field of Object.keys(config.signals).sort()) {
    const weight = config.signals[field]!;
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
export function sqlExpression(options: SQLOptions = {}, strategy: Strategy = 'B'): string {
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
 * - **Strategy A** (high volume): an indexed generated column. The exponential
 *   form, frozen order, constant-cost index scan, recomputed on a vote rather
 *   than every second. Recommended for `social-feed`.
 * - **Strategy B** (power law, bounded window): the exact formula, over a
 *   candidate set the `WHERE` clause has already cut to a few thousand rows.
 *   Valid whenever the relevance window is bounded — true of a feed, never of a
 *   catalogue. Recommended for `ecommerce` with a nightly batch recompute.
 */
export function toSQL(options: SQLOptions = {}, strategy: Strategy = 'B'): string {
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
