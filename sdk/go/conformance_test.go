// The shared cross-SDK fixture. The TypeScript, JavaScript and Python suites read
// the same file and assert the same numbers, so a change that shifts one
// implementation's output fails in all four.
package ranking_test

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	ranking "github.com/youssefmahersi/RankingAlgorithm/sdk/go/v2"
)

type expectedRow struct {
	ID          string  `json:"id"`
	Engagement  float64 `json:"engagement"`
	Quality     float64 `json:"quality"`
	AgeHours    float64 `json:"ageHours"`
	TimePenalty float64 `json:"timePenalty"`
	Score       float64 `json:"score"`
}

type fixtureCase struct {
	Name     string                   `json:"name"`
	Now      string                   `json:"now"`
	Config   fixtureConfig            `json:"config"`
	Items    []map[string]interface{} `json:"items"`
	Expected []expectedRow            `json:"expected"`
}

type fixtureConfig struct {
	Preset       string             `json:"preset"`
	Gravity      *float64           `json:"gravity"`
	GraceHours   *float64           `json:"graceHours"`
	Signals      map[string]float64 `json:"signals"`
	DateField    string             `json:"dateField"`
	IDField      string             `json:"idField"`
	OnFutureItem string             `json:"onFutureItem"`
	Bayesian     *struct {
		RatingField string  `json:"ratingField"`
		CountField  string  `json:"countField"`
		Prior       float64 `json:"prior"`
		PriorCount  float64 `json:"priorCount"`
		Weight      float64 `json:"weight"`
	} `json:"bayesian"`
}

type fixture struct {
	SpecVersion    int               `json:"specVersion"`
	Tolerance      float64           `json:"tolerance"`
	Cases          []fixtureCase     `json:"cases"`
	SQLExpressions map[string]string `json:"sqlExpressions"`
}

func loadFixture(t *testing.T) fixture {
	t.Helper()
	path := filepath.Join("..", "..", "conformance", "cases.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading %s: %v", path, err)
	}
	var f fixture
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("parsing %s: %v", path, err)
	}
	return f
}

// buildConfig translates the fixture's JSON config into a Go Config.
func buildConfig(t *testing.T, c fixtureCase) ranking.Config {
	t.Helper()
	cfg := ranking.SocialFeed()
	if c.Config.Preset != "" {
		var err error
		if cfg, err = ranking.Preset(c.Config.Preset); err != nil {
			t.Fatalf("preset %q: %v", c.Config.Preset, err)
		}
	}
	if c.Config.Gravity != nil {
		cfg.Gravity = *c.Config.Gravity
	}
	if c.Config.GraceHours != nil {
		cfg.GraceHours = *c.Config.GraceHours
	}
	if c.Config.Signals != nil {
		cfg.Signals = c.Config.Signals
	}
	if c.Config.OnFutureItem == "clamp" {
		cfg.OnFutureItem = ranking.ClampFuture
	}
	if b := c.Config.Bayesian; b != nil {
		cfg.Bayesian = &ranking.Bayesian{
			RatingField: b.RatingField,
			CountField:  b.CountField,
			Prior:       b.Prior,
			PriorCount:  b.PriorCount,
			Weight:      b.Weight,
		}
	}
	moment, err := time.Parse(time.RFC3339, c.Now)
	if err != nil {
		t.Fatalf("parsing now %q: %v", c.Now, err)
	}
	cfg.Now = moment
	return cfg
}

// buildItems maps the fixture's free-form JSON items onto ranking.Item.
func buildItems(t *testing.T, c fixtureCase, cfg ranking.Config) []ranking.Item {
	t.Helper()
	idField := c.Config.IDField
	if idField == "" {
		idField = "id"
	}
	dateField := c.Config.DateField
	if dateField == "" {
		dateField = "createdAt"
	}

	items := make([]ranking.Item, len(c.Items))
	for i, raw := range c.Items {
		signals := map[string]float64{}
		for key, value := range raw {
			if number, ok := value.(float64); ok {
				signals[key] = number
			}
		}
		text, ok := raw[dateField].(string)
		if !ok {
			t.Fatalf("item %d has no %q string field", i, dateField)
		}
		created, err := time.Parse(time.RFC3339, text)
		if err != nil {
			t.Fatalf("item %d: parsing %q: %v", i, text, err)
		}
		id, _ := raw[idField].(string)
		items[i] = ranking.Item{ID: id, CreatedAt: created, Signals: signals}
	}
	return items
}

func TestConformanceSpecVersion(t *testing.T) {
	if got := loadFixture(t).SpecVersion; got != ranking.SpecVersion {
		t.Fatalf("fixture targets spec version %d, this SDK implements %d", got, ranking.SpecVersion)
	}
}

func TestConformanceCases(t *testing.T) {
	f := loadFixture(t)
	for _, c := range f.Cases {
		c := c
		t.Run(c.Name, func(t *testing.T) {
			cfg := buildConfig(t, c)
			items := buildItems(t, c, cfg)

			scored, err := ranking.RankWithScores(items, ranking.Identity, cfg)
			if err != nil {
				t.Fatalf("RankWithScores: %v", err)
			}
			if len(scored) != len(c.Expected) {
				t.Fatalf("got %d results, want %d", len(scored), len(c.Expected))
			}

			for i, entry := range scored {
				want := c.Expected[i]
				if entry.Item.ID != want.ID {
					got := make([]string, len(scored))
					for j, e := range scored {
						got[j] = e.Item.ID
					}
					t.Fatalf("position %d is %q, want %q (full order %v)", i, entry.Item.ID, want.ID, got)
				}

				detail, err := ranking.Explain(entry.Item, cfg)
				if err != nil {
					t.Fatalf("Explain(%q): %v", want.ID, err)
				}
				for _, check := range []struct {
					label     string
					got, want float64
				}{
					{"score", entry.Score, want.Score},
					{"engagement", detail.Engagement, want.Engagement},
					{"quality", detail.Quality, want.Quality},
					{"ageHours", detail.AgeHours, want.AgeHours},
					{"timePenalty", detail.TimePenalty, want.TimePenalty},
				} {
					if math.Abs(check.got-check.want) > f.Tolerance {
						t.Errorf("%s %s: got %v, want %v", want.ID, check.label, check.got, check.want)
					}
				}
			}
		})
	}
}

func TestConformanceSQLExpressions(t *testing.T) {
	f := loadFixture(t)
	if len(f.SQLExpressions) == 0 {
		t.Fatal("the fixture carries no SQL expressions")
	}
	for key, want := range f.SQLExpressions {
		key, want := key, want
		t.Run(key, func(t *testing.T) {
			parts := strings.Split(key, "/")
			if len(parts) != 3 {
				t.Fatalf("malformed key %q, want preset/dialect/strategy", key)
			}
			preset, dialect := parts[0], parts[1]
			cfg, err := ranking.Preset(preset)
			if err != nil {
				t.Fatal(err)
			}
			got, err := ranking.SQLExpression(cfg, ranking.StrategyB, ranking.SQLOptions{Dialect: dialect})
			if err != nil {
				t.Fatal(err)
			}
			if got != want {
				t.Errorf("SQL drifted from the other SDKs:\n got %s\nwant %s", got, want)
			}
		})
	}
}
