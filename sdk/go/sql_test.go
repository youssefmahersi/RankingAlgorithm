package ranking_test

import (
	"errors"
	"fmt"
	"math"
	"strings"
	"testing"

	ranking "github.com/youssefmahersi/RankingAlgorithm/sdk/go/v2"
)

func mustSQL(t *testing.T, cfg ranking.Config, strategy ranking.Strategy, opts ranking.SQLOptions) string {
	t.Helper()
	sql, err := ranking.ToSQL(cfg, strategy, opts)
	if err != nil {
		t.Fatalf("ToSQL: %v", err)
	}
	return sql
}

func TestStrategyB(t *testing.T) {
	sql := mustSQL(t, ranking.SocialFeed(), ranking.StrategyB, ranking.SQLOptions{})

	for _, want := range []string{
		`log(1 + 3.0 * "comment" + "like" + 5.0 * "share")`,
		`1.5 * log((extract(epoch from now() - "created_at") / 3600.0) + 2.0)`,
		`WHERE "created_at" > now() - interval '7 days'`,
		"ORDER BY score DESC",
		"LIMIT 20",
	} {
		if !strings.Contains(sql, want) {
			t.Errorf("missing %q in:\n%s", want, sql)
		}
	}
}

func TestStrategyBMapsColumns(t *testing.T) {
	expr, err := ranking.SQLExpression(ranking.SocialFeed(), ranking.StrategyB, ranking.SQLOptions{
		Columns: map[string]string{"like": "n_likes", "comment": "n_comments", "share": "n_shares"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(expr, `"n_likes"`) || strings.Contains(expr, `"like"`) {
		t.Fatalf("columns were not remapped: %s", expr)
	}
}

func TestStrategyA(t *testing.T) {
	sql := mustSQL(t, ranking.SocialFeed(), ranking.StrategyA, ranking.SQLOptions{})

	for _, want := range []string{
		`"created_epoch"`,
		"GENERATED ALWAYS AS",
		"STORED",
		`CREATE INDEX "posts_hot_idx" ON "posts" ("hot" DESC);`,
		"not immutable",
		fmt.Sprintf(`"created_epoch" - %d`, ranking.EpochOffset2020),
	} {
		if !strings.Contains(sql, want) {
			t.Errorf("missing %q in:\n%s", want, sql)
		}
	}

	// No clock may appear inside a generated column: that is the whole point of
	// strategy A, and Postgres would reject it as non-immutable anyway.
	if strings.Contains(sql, "now() -") {
		t.Errorf("a clock leaked into the generated expression:\n%s", sql)
	}
}

func TestStrategyADerivesTau(t *testing.T) {
	// tau = t0 * (10^(1/g) - 1) hours: the point where both parameter families
	// are defined by the same thing, one factor of ten in engagement.
	tau, err := ranking.TauSeconds(ranking.SocialFeed())
	if err != nil {
		t.Fatal(err)
	}
	want := 2 * (math.Pow(10, 1/1.5) - 1) * 3600
	if math.Abs(tau-want) > 1e-6 {
		t.Fatalf("tau is %v, want %v", tau, want)
	}
}

func TestStrategyARefusesGravityZero(t *testing.T) {
	cfg := ranking.SocialFeed()
	cfg.Gravity = 0
	if _, err := ranking.ToSQL(cfg, ranking.StrategyA, ranking.SQLOptions{}); !errors.Is(err, ranking.ErrUnsupported) {
		t.Fatalf("got %v, want ErrUnsupported — with no decay there is nothing to index on", err)
	}
}

func TestMysqlDialect(t *testing.T) {
	sql := mustSQL(t, ranking.SocialFeed(), ranking.StrategyB, ranking.SQLOptions{Dialect: "mysql"})
	if !strings.Contains(sql, "log10(1 +") {
		t.Errorf("MySQL log() is natural; log10() is required:\n%s", sql)
	}
	if !strings.Contains(sql, "timestampdiff(second, `created_at`, now()) / 3600.0") {
		t.Errorf("missing the MySQL age expression:\n%s", sql)
	}
}

func TestSQLRefusals(t *testing.T) {
	t.Run("custom engagement func", func(t *testing.T) {
		cfg := ranking.SocialFeed()
		cfg.Engagement = func(ranking.Item) float64 { return 1 }
		if _, err := ranking.ToSQL(cfg, ranking.StrategyB, ranking.SQLOptions{}); !errors.Is(err, ranking.ErrUnsupported) {
			t.Fatalf("got %v", err)
		}
	})

	t.Run("non-identifier table", func(t *testing.T) {
		opts := ranking.SQLOptions{Table: "posts; drop table users --"}
		if _, err := ranking.ToSQL(ranking.SocialFeed(), ranking.StrategyB, opts); !errors.Is(err, ranking.ErrUnsupported) {
			t.Fatalf("got %v", err)
		}
	})

	t.Run("non-identifier column", func(t *testing.T) {
		opts := ranking.SQLOptions{Columns: map[string]string{"like": `"weird name"`}}
		if _, err := ranking.ToSQL(ranking.SocialFeed(), ranking.StrategyB, opts); !errors.Is(err, ranking.ErrUnsupported) {
			t.Fatalf("got %v", err)
		}
	})

	t.Run("unknown dialect", func(t *testing.T) {
		opts := ranking.SQLOptions{Dialect: "oracle"}
		if _, err := ranking.ToSQL(ranking.SocialFeed(), ranking.StrategyB, opts); !errors.Is(err, ranking.ErrUnsupported) {
			t.Fatalf("got %v", err)
		}
	})
}

func TestBayesianInSQL(t *testing.T) {
	cfg := ranking.Ecommerce()
	cfg.Bayesian = &ranking.Bayesian{RatingField: "stars", CountField: "reviews", Prior: 3.8, PriorCount: 25, Weight: 12}
	expr, err := ranking.SQLExpression(cfg, ranking.StrategyB, ranking.SQLOptions{})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`nullif(25.0 + "reviews", 0)`, `25.0 * 3.8 + "reviews" * "stars"`} {
		if !strings.Contains(expr, want) {
			t.Errorf("missing %q in:\n%s", want, expr)
		}
	}
}

func TestNumFormattingMatchesTheOtherSDKs(t *testing.T) {
	// The emitter must print floats exactly as JavaScript, TypeScript and Python
	// do, or the cross-SDK SQL comparison in conformance_test.go drifts.
	cfg := ranking.Config{Gravity: 1.5, GraceHours: 2, Signals: map[string]float64{
		"a": 1, "b": 3, "c": 0.05, "d": 10, "e": 0.3,
	}}
	expr, err := ranking.SQLExpression(cfg, ranking.StrategyB, ranking.SQLOptions{})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"a"`, `3.0 * "b"`, `0.05 * "c"`, `10.0 * "d"`, `0.3 * "e"`} {
		if !strings.Contains(expr, want) {
			t.Errorf("missing %q in:\n%s", want, expr)
		}
	}
}
