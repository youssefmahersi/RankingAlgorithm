from __future__ import annotations

import pytest

from rankingalgorithm import (
    EPOCH_OFFSET_2020,
    Bayesian,
    RankingError,
    sql_expression,
    tau_seconds,
    to_sql,
)


class TestStrategyB:
    SQL = to_sql("social-feed", "B", table="posts")

    def test_inlines_the_preset_constants(self):
        # Signal names are emitted in sorted order, so the output does not depend
        # on how the signals dict was written — and so Go, whose maps have no
        # iteration order, can produce the same bytes.
        assert 'log(1 + 3.0 * "comment" + "like" + 5.0 * "share")' in self.SQL
        assert '1.5 * log((extract(epoch from now() - "created_at") / 3600.0) + 2.0)' in self.SQL

    def test_bounds_the_candidate_set(self):
        assert "WHERE \"created_at\" > now() - interval '7 days'" in self.SQL
        assert "ORDER BY score DESC" in self.SQL
        assert "LIMIT 20" in self.SQL

    def test_maps_signal_fields_onto_real_columns(self):
        mapped = sql_expression("social-feed", "B", columns={"like": "n_likes"})
        assert '"n_likes"' in mapped


class TestStrategyA:
    SQL = to_sql("social-feed", "A", table="posts")

    def test_uses_the_exponential_family_so_now_cancels(self):
        assert "created_epoch" in self.SQL
        assert "now() -" not in self.SQL, "no clock may appear inside a generated column"
        assert "GENERATED ALWAYS AS" in self.SQL
        assert "STORED" in self.SQL
        assert 'CREATE INDEX "posts_hot_idx" ON "posts" ("hot" DESC);' in self.SQL

    def test_offsets_the_epoch_from_2020(self):
        assert f'"created_epoch" - {EPOCH_OFFSET_2020}' in self.SQL

    def test_derives_tau_from_the_configuration(self):
        tau = tau_seconds("social-feed")
        assert tau == pytest.approx(2 * (10 ** (1 / 1.5) - 1) * 3600)

    def test_documents_the_immutability_trap(self):
        assert "not immutable" in self.SQL

    def test_refuses_when_gravity_is_zero(self):
        with pytest.raises(RankingError, match="tau"):
            to_sql("social-feed", "A", gravity=0)


class TestMysqlDialect:
    def test_uses_log10_and_timestampdiff(self):
        sql = to_sql("social-feed", "B", dialect="mysql")
        assert "log10(1 +" in sql
        assert "timestampdiff(second, `created_at`, now()) / 3600.0" in sql


class TestRefusals:
    def test_will_not_translate_a_custom_callable(self):
        with pytest.raises(RankingError, match="cannot be translated"):
            to_sql("social-feed", engagement=lambda item: 1.0)

    def test_will_not_interpolate_a_non_identifier(self):
        with pytest.raises(RankingError):
            to_sql("social-feed", table="posts; drop table users --")
        with pytest.raises(RankingError):
            to_sql("social-feed", columns={"like": '"weird name"'})

    def test_rejects_an_unknown_dialect(self):
        with pytest.raises(RankingError, match="postgres, mysql"):
            to_sql("social-feed", dialect="oracle")


class TestBayesianInSQL:
    def test_emits_the_smoothing_expression_with_a_zero_guard(self):
        sql = sql_expression(
            "ecommerce",
            bayesian=Bayesian(
                rating_field="stars", count_field="reviews", prior=3.8, prior_count=25, weight=12
            ),
        )
        assert 'nullif(25.0 + "reviews", 0)' in sql
        assert '25.0 * 3.8 + "reviews" * "stars"' in sql
