package ranking

import (
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
)

// EpochOffset2020 is 2020-01-01T00:00:00Z. Counting from here rather than 1970
// keeps the numbers small and preserves float precision.
const EpochOffset2020 = 1577836800

// Strategy selects which SQL translation to emit. See [ToSQL].
type Strategy string

const (
	// StrategyA is the indexed generated column: the exponential family, frozen
	// order, constant-cost index scan. Recommended for social-feed.
	StrategyA Strategy = "A"

	// StrategyB is the exact power law over a bounded candidate set.
	// Recommended for ecommerce with a nightly batch recompute.
	StrategyB Strategy = "B"
)

// SQLOptions configures the emitter. The zero value is usable: it emits Postgres
// against a table named "posts".
type SQLOptions struct {
	Table       string            // default "posts"
	Columns     map[string]string // signal name -> column name, when they differ
	DateColumn  string            // default "created_at"; strategy B
	EpochColumn string            // default "created_epoch"; strategy A
	ScoreColumn string            // default "hot"; strategy A
	WindowDays  int               // default 7; strategy B
	Limit       int               // default 20
	TauSeconds  float64           // default: derived from the config
	EpochOffset int64             // default EpochOffset2020
	Dialect     string            // "postgres" (default) or "mysql"
}

func (o SQLOptions) withDefaults() SQLOptions {
	if o.Table == "" {
		o.Table = "posts"
	}
	if o.DateColumn == "" {
		o.DateColumn = "created_at"
	}
	if o.EpochColumn == "" {
		o.EpochColumn = "created_epoch"
	}
	if o.ScoreColumn == "" {
		o.ScoreColumn = "hot"
	}
	if o.WindowDays == 0 {
		o.WindowDays = 7
	}
	if o.Limit == 0 {
		o.Limit = 20
	}
	if o.EpochOffset == 0 {
		o.EpochOffset = EpochOffset2020
	}
	if o.Dialect == "" {
		o.Dialect = "postgres"
	}
	return o
}

var identifierPattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_$]*$`)

// identifier validates a name and returns it bare. Anything needing escaping is
// rejected.
func identifier(name, label string) (string, error) {
	if !identifierPattern.MatchString(name) {
		return "", fmt.Errorf("%w: %s %q is not a plain SQL identifier; pass a bare name matching [A-Za-z_][A-Za-z0-9_$]*", ErrUnsupported, label, name)
	}
	return name, nil
}

// quoted quotes an identifier for the target dialect.
//
// Everything is quoted, always. "like" — the default weight name in the
// social-feed preset — is a reserved word in Postgres, so bare emission produces
// a syntax error on the default path. Quoting also preserves the case of
// camelCase columns, which is what ORM-created schemas usually have.
func quoted(name, label, dialect string) (string, error) {
	bare, err := identifier(name, label)
	if err != nil {
		return "", err
	}
	if dialect == "mysql" {
		return "`" + bare + "`", nil
	}
	return `"` + bare + `"`, nil
}

// num formats a float the way every SDK formats it, so the emitted SQL is
// byte-identical across TypeScript, JavaScript, Python and Go.
func num(value float64) string {
	rounded, err := strconv.ParseFloat(strconv.FormatFloat(value, 'g', 12, 64), 64)
	if err != nil {
		rounded = value
	}
	if rounded == math.Trunc(rounded) && math.Abs(rounded) < 1e15 {
		return strconv.FormatFloat(rounded, 'f', 1, 64)
	}
	return strconv.FormatFloat(rounded, 'g', -1, 64)
}

func logFn(dialect string) string {
	// Postgres log(x) is already base 10; MySQL needs log10() since log() is natural.
	if dialect == "postgres" {
		return "log"
	}
	return "log10"
}

func engagementSQL(cfg Config, opts SQLOptions) (string, error) {
	if cfg.Engagement != nil {
		return "", fmt.Errorf("%w: a custom Engagement func cannot be translated to SQL; express it as Signals weights, or write the expression by hand", ErrUnsupported)
	}
	var terms []string
	// Signal names are emitted in sorted order in every SDK, so the output does
	// not depend on how the map was built.
	for _, field := range sortedKeys(cfg.Signals) {
		weight := cfg.Signals[field]
		if weight == 0 {
			continue
		}
		name := field
		if mapped, ok := opts.Columns[field]; ok {
			name = mapped
		}
		column, err := quoted(name, "Column", opts.Dialect)
		if err != nil {
			return "", err
		}
		if weight == 1 {
			terms = append(terms, column)
		} else {
			terms = append(terms, num(weight)+" * "+column)
		}
	}

	if b := cfg.Bayesian; b != nil {
		ratingName, countName := b.RatingField, b.CountField
		if mapped, ok := opts.Columns[b.RatingField]; ok {
			ratingName = mapped
		}
		if mapped, ok := opts.Columns[b.CountField]; ok {
			countName = mapped
		}
		rating, err := quoted(ratingName, "Column", opts.Dialect)
		if err != nil {
			return "", err
		}
		count, err := quoted(countName, "Column", opts.Dialect)
		if err != nil {
			return "", err
		}
		terms = append(terms, fmt.Sprintf("%s * ((%s * %s + %s * %s) / nullif(%s + %s, 0))",
			num(b.Weight), num(b.PriorCount), num(b.Prior), count, rating, num(b.PriorCount), count))
	}

	if len(terms) == 0 {
		return "0", nil
	}
	return strings.Join(terms, " + "), nil
}

// SQLExpression returns just the score expression, without the surrounding
// statement.
func SQLExpression(cfg Config, strategy Strategy, opts SQLOptions) (string, error) {
	if err := cfg.Validate(); err != nil {
		return "", err
	}
	opts = opts.withDefaults()
	if opts.Dialect != "postgres" && opts.Dialect != "mysql" {
		return "", fmt.Errorf("%w: dialect %q; supported: postgres, mysql", ErrUnsupported, opts.Dialect)
	}
	logName := logFn(opts.Dialect)
	total, err := engagementSQL(cfg, opts)
	if err != nil {
		return "", err
	}

	if strategy == StrategyA {
		epoch, err := quoted(opts.EpochColumn, "Column", opts.Dialect)
		if err != nil {
			return "", err
		}
		tau := opts.TauSeconds
		if tau == 0 {
			if tau, err = TauSeconds(cfg); err != nil {
				return "", err
			}
		}
		if math.IsInf(tau, 0) || math.IsNaN(tau) || tau <= 0 {
			return "", fmt.Errorf("%w: strategy A needs a finite, positive tau; with gravity = 0 time is ignored entirely, so there is nothing to index on", ErrUnsupported)
		}
		return fmt.Sprintf("%s(1 + %s) + (%s - %s) / %s",
			logName, total, epoch, num(float64(opts.EpochOffset)), num(tau)), nil
	}

	date, err := quoted(opts.DateColumn, "Column", opts.Dialect)
	if err != nil {
		return "", err
	}
	age := fmt.Sprintf("extract(epoch from now() - %s) / 3600.0", date)
	if opts.Dialect == "mysql" {
		age = fmt.Sprintf("timestampdiff(second, %s, now()) / 3600.0", date)
	}
	return fmt.Sprintf("%s(1 + %s) - %s * %s((%s) + %s)",
		logName, total, num(cfg.Gravity), logName, age, num(cfg.GraceHours)), nil
}

// ToSQL emits the SQL equivalent of a configuration.
//
// # The question that decides everything
//
// Does now cancel when comparing two rows? Under the power law time sits inside
// a log, so it does not cancel: the order genuinely changes as the clock moves,
// and no static index can hold it. Under the exponential family time enters
// linearly and now cancels completely — only the difference of publication dates
// matters, and that never changes. This is why Reddit's formula is linear in
// time, and it was not an accident.
//
// StrategyA (high volume) is an indexed generated column: frozen order, constant
// cost, recomputed on a vote rather than every second.
//
// StrategyB (power law, bounded window) is the exact formula over a candidate set
// the WHERE clause has already cut to a few thousand rows. Valid whenever the
// relevance window is bounded — true of a feed, never of a catalogue.
func ToSQL(cfg Config, strategy Strategy, opts SQLOptions) (string, error) {
	opts = opts.withDefaults()
	expression, err := SQLExpression(cfg, strategy, opts)
	if err != nil {
		return "", err
	}
	tableName, err := identifier(opts.Table, "Table")
	if err != nil {
		return "", err
	}
	table, err := quoted(tableName, "Table", opts.Dialect)
	if err != nil {
		return "", err
	}

	if strategy == StrategyA {
		scoreName, err := identifier(opts.ScoreColumn, "Column")
		if err != nil {
			return "", err
		}
		scoreColumn, err := quoted(scoreName, "Column", opts.Dialect)
		if err != nil {
			return "", err
		}
		index, err := quoted(tableName+"_"+scoreName+"_idx", "Index", opts.Dialect)
		if err != nil {
			return "", err
		}
		epochColumn, err := identifier(opts.EpochColumn, "Column")
		if err != nil {
			return "", err
		}
		columnType, extractor := "double precision", "extract(epoch from created_at)"
		if opts.Dialect == "mysql" {
			columnType, extractor = "double", "unix_timestamp(created_at)"
		}
		return strings.Join([]string{
			"-- Strategy A: indexed generated column. Order is frozen, so the index stays valid.",
			fmt.Sprintf("-- %s must be a plain bigint written at insert time:", epochColumn),
			fmt.Sprintf("--   %s is not immutable on a timestamp", extractor),
			"--   with time zone, and generated columns must be immutable.",
			fmt.Sprintf("ALTER TABLE %s ADD COLUMN %s %s", table, scoreColumn, columnType),
			"  GENERATED ALWAYS AS (",
			"    " + expression,
			"  ) STORED;",
			"",
			fmt.Sprintf("CREATE INDEX %s ON %s (%s DESC);", index, table, scoreColumn),
			"",
			fmt.Sprintf("SELECT * FROM %s ORDER BY %s DESC LIMIT %d;", table, scoreColumn, opts.Limit),
		}, "\n"), nil
	}

	if opts.WindowDays <= 0 {
		return "", fmt.Errorf("%w: windowDays must be positive, got %d", ErrUnsupported, opts.WindowDays)
	}
	dateColumn, err := quoted(opts.DateColumn, "Column", opts.Dialect)
	if err != nil {
		return "", err
	}
	window := fmt.Sprintf("now() - interval '%d days'", opts.WindowDays)
	if opts.Dialect == "mysql" {
		window = fmt.Sprintf("now() - interval %d day", opts.WindowDays)
	}
	return strings.Join([]string{
		"-- Strategy B: exact power law over a bounded candidate set.",
		fmt.Sprintf("-- The WHERE clause uses an ordinary index on %s and cuts the set to a few", dateColumn),
		"-- thousand rows; sorting that handful is free.",
		"SELECT *,",
		"       " + expression + " AS score",
		"FROM " + table,
		fmt.Sprintf("WHERE %s > %s", dateColumn, window),
		"ORDER BY score DESC",
		fmt.Sprintf("LIMIT %d;", opts.Limit),
	}, "\n"), nil
}
