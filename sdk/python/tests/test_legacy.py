"""The v1 shim must keep working, and must keep announcing that it is going away."""

from __future__ import annotations

import math

import pytest

from rankingalgorithm.legacy import RankingAlgorithm


def build(**_):
    config = [
        {"field": "nLikes", "valuable": True, "typeOfAdd": "Multiplication", "ref": ""},
        {"field": "audience", "valuable": False, "typeOfAdd": "", "ref": "nLikes"},
        {"field": "nComments", "valuable": False, "typeOfAdd": "", "ref": ""},
    ]
    with pytest.deprecated_call():
        return RankingAlgorithm(8, 0.0002, config)


def test_warns_on_construction():
    with pytest.warns(DeprecationWarning, match="removed in 3.0.0"):
        RankingAlgorithm(8, 0.0002, [])


def test_reproduces_the_v1_numbers():
    algo = build()
    # nLikes * audience + audience + nComments, over the v1 denominator.
    assert algo.calc(10, 100, 5, 0.0) == pytest.approx((10 * 100 + 100 + 5) / algo.time(0.0))


def test_saturates_which_is_why_it_was_replaced():
    algo = build()
    # As t grows the denominator tends to 1 + start_value, so time stops
    # discriminating entirely. Past a few multiples of `stretch` the scores are
    # identical to within floating-point noise however far apart the items are.
    assert math.isclose(algo.calc(10, 100, 5, 200.0), algo.calc(10, 100, 5, 20000.0), rel_tol=1e-9)
    # Even at t = 50 — barely six multiples of stretch — a hundredfold difference
    # in age is worth only 0.2%.
    assert math.isclose(algo.calc(10, 100, 5, 50.0), algo.calc(10, 100, 5, 5000.0), rel_tol=5e-3)


def test_zero_engagement_scores_zero_regardless_of_age():
    algo = build()
    assert algo.calc(0, 0, 0, 0.0) == 0.0
    assert algo.calc(0, 0, 0, 100.0) == 0.0
