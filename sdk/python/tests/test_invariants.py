"""Invariants, not values.

Every assertion here survives a change to the constants: retune a preset and
these still pass, break the formula and they all fail.
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone

import pytest

from rankingalgorithm import (
    PRESETS,
    Bayesian,
    RankingError,
    decade_hours,
    engagement_ratio,
    explain,
    quality,
    rank,
    rank_with_scores,
    score,
    solve_gravity,
    time_penalty,
    top,
)

NOW = datetime(2026, 1, 15, 12, 0, 0, tzinfo=timezone.utc)


def hours_ago(h: float) -> datetime:
    return NOW - timedelta(hours=h)


def post(item_id: str, age_hours: float, **signals: float) -> dict:
    return {
        "id": item_id,
        "createdAt": hours_ago(age_hours),
        "like": 0,
        "comment": 0,
        "share": 0,
        **signals,
    }


OPTS = dict(config="social-feed", now=NOW)


def ranked_ids(items, **kwargs):
    return [i["id"] for i in rank(items, **{**OPTS, **kwargs})]


class TestMonotonicInTime:
    def test_strictly_decreasing_across_five_orders_of_magnitude(self):
        ages = [0, 0.5, 1, 2, 6, 24, 72, 240, 8760, 87600]
        scores = [score(post("x", age, like=42), **OPTS) for age in ages]
        for earlier, later in zip(scores, scores[1:]):
            assert later < earlier

    def test_never_saturates(self):
        # The v1 bug: its denominator tended to 1 + start_value, so time stopped
        # discriminating and a day-old item tied with a year-old one.
        day = score(post("a", 24, like=100), **OPTS)
        year = score(post("b", 8760, like=100), **OPTS)
        assert day - year > 1  # more than a factor of ten apart

    def test_flat_only_when_gravity_is_zero(self):
        opts = {**OPTS, "gravity": 0}
        assert score(post("a", 1, like=10), **opts) == score(post("b", 100000, like=10), **opts)


class TestEqualAgeOrdersByEngagement:
    def test_orders_a_fixed_age_cohort(self):
        items = [
            post("low", 5, like=2),
            post("high", 5, like=500),
            post("mid", 5, like=50),
            post("comments", 5, comment=30),
        ]
        assert ranked_ids(items) == ["high", "comments", "mid", "low"]

    def test_respects_relative_signal_weights(self):
        assert quality(post("a", 0, comment=1), **OPTS) == quality(post("b", 0, like=3), **OPTS)
        assert quality(post("a", 0, share=1), **OPTS) == quality(post("b", 0, like=5), **OPTS)


class TestMatchesNaiveReference:
    """The additive log form is algebraically log(A/B).

    Rewriting a division as a subtraction of logs cannot change the order, because
    log is strictly increasing. This is what makes that claim checkable rather
    than asserted.
    """

    def test_agrees_on_a_hundred_pseudo_random_items(self):
        seed = 20260115

        def random() -> float:
            nonlocal seed
            seed = (seed * 1103515245 + 12345) % 2147483648
            return seed / 2147483648

        items = []
        for i in range(100):
            age = random() * 500
            items.append(
                {
                    "id": f"p{i:03d}",
                    "createdAt": hours_ago(age),
                    "age": age,
                    "like": int(random() * 5000),
                    "comment": int(random() * 300),
                    "share": 0,
                }
            )

        preset = PRESETS["social-feed"]

        def naive(item):
            engagement = 1 + item["like"] + 3 * item["comment"]
            return engagement / (item["age"] + preset.grace_hours) ** preset.gravity

        by_log = ranked_ids(items)
        by_naive = [i["id"] for i in sorted(items, key=lambda i: (-naive(i), i["id"]))]
        assert by_log == by_naive


class TestColdStart:
    def test_zero_engagement_is_finite(self):
        assert math.isfinite(score(post("empty", 0), **OPTS))
        assert quality(post("empty", 0), **OPTS) == 0.0

    def test_fresh_empty_outranks_old_empty(self):
        # v1 multiplied the freshness boost by zero, so a new item with no
        # engagement never surfaced and therefore never received engagement.
        assert ranked_ids([post("old", 240), post("fresh", 0)]) == ["fresh", "old"]

    def test_grace_window_is_nearly_flat(self):
        grace = PRESETS["social-feed"].grace_hours
        assert engagement_ratio(grace / 10, "social-feed") < 1.2

    def test_dynamic_range_is_not_front_loaded(self):
        # v1 fell from 5000x to under 10x inside the first 10% of its window.
        consumed = time_penalty(decade_hours("social-feed") / 10, "social-feed") - time_penalty(
            0, "social-feed"
        )
        assert 0.05 < consumed < 0.35


class TestFutureItems:
    def test_negative_age_raises(self):
        with pytest.raises(RankingError, match="future"):
            score(post("future", -1, like=5), **OPTS)

    def test_clamp_treats_future_as_brand_new(self):
        opts = {**OPTS, "on_future_item": "clamp"}
        assert score(post("future", -48, like=5), **opts) == score(post("now", 0, like=5), **opts)


class TestZeroAge:
    def test_does_not_divide_by_zero(self):
        assert math.isfinite(score(post("new", 0, like=1), **OPTS))
        assert math.isfinite(time_penalty(0, "social-feed"))

    def test_rejects_a_grace_window_of_zero(self):
        with pytest.raises(RankingError, match="grace_hours"):
            score(post("new", 0), **{**OPTS, "grace_hours": 0})


class TestDeterministicTieBreak:
    TIED = [post("zulu", 6, like=10), post("alpha", 6, like=10), post("mike", 6, like=10)]

    def test_orders_equal_scores_by_id_ascending(self):
        assert ranked_ids(self.TIED) == ["alpha", "mike", "zulu"]

    def test_same_order_every_time_from_any_input_order(self):
        for _ in range(20):
            assert ranked_ids(list(reversed(self.TIED))) == ["alpha", "mike", "zulu"]

    def test_falls_back_to_input_position_without_an_id(self):
        anonymous = [
            {"createdAt": hours_ago(6), "like": 10, "tag": "first"},
            {"createdAt": hours_ago(6), "like": 10, "tag": "second"},
        ]
        assert [i["tag"] for i in rank(anonymous, **OPTS)] == ["first", "second"]


class TestRank:
    def test_sensible_ordering_with_no_arguments(self):
        now = datetime.now(timezone.utc)
        items = [
            {"id": "old", "createdAt": now - timedelta(hours=72), "like": 10},
            {"id": "new", "createdAt": now - timedelta(minutes=1), "like": 10},
        ]
        assert [i["id"] for i in rank(items)] == ["new", "old"]

    def test_does_not_mutate_the_input(self):
        items = [post("a", 1, like=1), post("b", 1, like=99)]
        rank(items, **OPTS)
        assert [i["id"] for i in items] == ["a", "b"]

    def test_pins_now_once_for_the_batch(self):
        same = {"createdAt": datetime.now(timezone.utc) - timedelta(hours=1), "like": 7}
        scored = rank_with_scores([{"id": "a", **same}, {"id": "b", **same}])
        assert scored[0].score == scored[1].score

    def test_top_is_rank_sliced(self):
        items = [post("a", 1, like=1), post("b", 1, like=99), post("c", 1, like=50)]
        assert [i["id"] for i in top(items, 2, **OPTS)] == ["b", "c"]
        assert top(items, 0, **OPTS) == []

    def test_accepts_objects_as_well_as_dicts(self):
        class Post:
            def __init__(self, id, createdAt, like):  # noqa: N803
                self.id = id
                self.createdAt = createdAt
                self.like = like

        items = [Post("a", hours_ago(1), 1), Post("b", hours_ago(1), 99)]
        assert [i.id for i in rank(items, **OPTS)] == ["b", "a"]


class TestSeparableHalves:
    def test_score_is_quality_minus_penalty(self):
        item = post("x", 17, like=33, comment=4)
        assert score(item, **OPTS) == pytest.approx(
            quality(item, **OPTS) - time_penalty(17, "social-feed"), abs=1e-12
        )

    def test_quality_is_time_independent(self):
        signals = dict(like=33, comment=4)
        old = quality(post("b", 9999, **signals), **OPTS)
        assert quality(post("a", 0, **signals), **OPTS) == old

    def test_reads_a_stored_quality_column(self):
        stored = {"id": "x", "createdAt": hours_ago(10), "hot": 4.2, "like": 999999}
        assert quality(stored, **{**OPTS, "quality_field": "hot"}) == 4.2


class TestExplain:
    ITEM = post("x", 24, like=100, comment=10, share=2)

    def test_parts_add_back_up(self):
        detail = explain(self.ITEM, **OPTS)
        assert detail.quality - detail.time_penalty == pytest.approx(detail.score, abs=1e-12)
        assert detail.score == pytest.approx(score(self.ITEM, **OPTS), abs=1e-12)

    def test_reports_each_contribution_and_share(self):
        detail = explain(self.ITEM, **OPTS)
        by_field = {s.field: s for s in detail.signals}
        assert by_field["comment"].contribution == 30
        assert detail.engagement == 140
        assert sum(s.share for s in detail.signals) == pytest.approx(1.0, abs=1e-12)

    def test_names_the_formula(self):
        detail = explain(self.ITEM, **OPTS)
        assert "log10" in detail.formula
        assert (detail.gravity, detail.grace_hours) == (1.5, 2)

    def test_serialises_to_a_dict(self):
        assert explain(self.ITEM, **OPTS).to_dict()["score"] == pytest.approx(
            score(self.ITEM, **OPTS)
        )


class TestTuningProtocol:
    def test_solve_gravity_inverts_engagement_ratio(self):
        for ratio, after in [(47, 24), (10, 6), (2, 168), (1000, 1)]:
            gravity = solve_gravity(ratio=ratio, after_hours=after, grace_hours=2)
            assert engagement_ratio(after, gravity=gravity, grace_hours=2) == pytest.approx(ratio)

    def test_reproduces_documented_preset_behaviour(self):
        assert engagement_ratio(24, "social-feed") == pytest.approx(46.87, abs=0.05)
        assert engagement_ratio(48, "social-feed") == pytest.approx(125.0, abs=0.05)
        assert engagement_ratio(90 * 24, "ecommerce") == pytest.approx(2.8, abs=0.05)
        assert engagement_ratio(365 * 24, "ecommerce") == pytest.approx(4.23, abs=0.05)

    def test_decade_hours_is_exactly_ten_times(self):
        assert engagement_ratio(decade_hours("social-feed"), "social-feed") == pytest.approx(10)
        assert decade_hours("social-feed", gravity=0) == math.inf


class TestBayesianSmoothing:
    BAYES = Bayesian(
        rating_field="stars", count_field="reviews", prior=3.8, prior_count=25, weight=12
    )
    ONE = {"id": "one", "createdAt": hours_ago(24), "purchase": 10, "stars": 5, "reviews": 1}
    MANY = {"id": "many", "createdAt": hours_ago(24), "purchase": 10, "stars": 4.8, "reviews": 200}

    def test_off_by_default(self):
        assert score(self.ONE, "ecommerce", now=NOW) == score(self.MANY, "ecommerce", now=NOW)

    def test_two_hundred_reviews_beat_one_perfect_review(self):
        ordered = rank([self.ONE, self.MANY], "ecommerce", now=NOW, bayesian=self.BAYES)
        assert [i["id"] for i in ordered] == ["many", "one"]

    def test_unreviewed_product_sits_at_the_prior(self):
        item = {"id": "x", "createdAt": hours_ago(24), "stars": 0, "reviews": 0}
        detail = explain(item, "ecommerce", now=NOW, bayesian=self.BAYES)
        assert detail.bayesian is not None
        assert detail.bayesian.smoothed == 3.8


class TestValidation:
    def test_unknown_preset_lists_the_real_ones(self):
        with pytest.raises(RankingError, match="social-feed"):
            score(post("a", 1), "tiktok")

    def test_unknown_option_is_rejected_rather_than_ignored(self):
        with pytest.raises(RankingError, match="grravity"):
            score(post("a", 1), "social-feed", grravity=2)

    def test_negative_gravity(self):
        with pytest.raises(RankingError, match="gravity"):
            score(post("a", 1), **{**OPTS, "gravity": -1})

    def test_missing_date_field_is_named(self):
        with pytest.raises(RankingError, match="createdAt"):
            score({"id": "a", "like": 1}, **OPTS)

    def test_unparsable_date(self):
        with pytest.raises(RankingError, match="ISO 8601"):
            score({"id": "a", "createdAt": "last tuesday"}, **OPTS)

    def test_non_numeric_signal(self):
        with pytest.raises(RankingError, match="like"):
            score({"id": "a", "createdAt": hours_ago(1), "like": "lots"}, **OPTS)

    def test_missing_signal_is_zero(self):
        assert quality({"id": "a", "createdAt": hours_ago(1)}, **OPTS) == 0.0


class TestDateFormats:
    def test_datetime_iso_string_and_epoch_seconds_agree(self):
        at = hours_ago(5)
        expected = score({"id": "a", "createdAt": at, "like": 9}, **OPTS)
        assert score({"id": "a", "createdAt": at.isoformat(), "like": 9}, **OPTS) == expected
        assert score({"id": "a", "createdAt": at.timestamp(), "like": 9}, **OPTS) == expected

    def test_z_suffix_and_naive_datetimes_are_read_as_utc(self):
        expected = score({"id": "a", "createdAt": hours_ago(5), "like": 9}, **OPTS)
        with_z = score({"id": "a", "createdAt": "2026-01-15T07:00:00Z", "like": 9}, **OPTS)
        naive = score({"id": "a", "createdAt": datetime(2026, 1, 15, 7, 0, 0), "like": 9}, **OPTS)
        assert with_z == expected
        assert naive == expected


class TestCustomEngagement:
    def test_replaces_the_weighted_sum(self):
        items = [
            {"id": "a", "createdAt": hours_ago(1), "likes": 10, "audience": 1000},
            {"id": "b", "createdAt": hours_ago(1), "likes": 400, "audience": 5},
        ]
        ordered = rank(
            items,
            **OPTS,
            engagement=lambda i: i["likes"] / max(1, i["audience"] / 1000),
        )
        assert [i["id"] for i in ordered] == ["b", "a"]
