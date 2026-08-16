"""The shared cross-SDK fixture.

The TypeScript, JavaScript and Go suites read the same file and assert the same
numbers, so a change that shifts one implementation's output fails in all four.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from rankingalgorithm import SPEC_VERSION, Bayesian, explain, rank_with_scores, sql_expression

FIXTURE = json.loads(
    (Path(__file__).resolve().parents[3] / "conformance" / "cases.json").read_text()
)
TOLERANCE = FIXTURE["tolerance"]


def _options(case: dict) -> dict:
    """Translate the fixture's camelCase config into this SDK's keyword arguments."""
    config = dict(case["config"])
    preset = config.pop("preset", None)
    mapping = {
        "graceHours": "grace_hours",
        "dateField": "date_field",
        "idField": "id_field",
        "qualityField": "quality_field",
        "onFutureItem": "on_future_item",
    }
    options = {mapping.get(key, key): value for key, value in config.items()}
    if "bayesian" in options:
        b = options["bayesian"]
        options["bayesian"] = Bayesian(
            rating_field=b["ratingField"],
            count_field=b["countField"],
            prior=b["prior"],
            prior_count=b["priorCount"],
            weight=b["weight"],
        )
    return {"config": preset, "now": case["now"], **options}


def test_fixture_targets_this_spec_version():
    assert FIXTURE["specVersion"] == SPEC_VERSION


@pytest.mark.parametrize("case", FIXTURE["cases"], ids=lambda c: c["name"])
def test_case_produces_expected_order_and_numbers(case):
    options = _options(case)
    id_field = case["config"].get("idField", "id")
    ranked = rank_with_scores(case["items"], **options)

    assert [str(entry.item[id_field]) for entry in ranked] == [e["id"] for e in case["expected"]]

    for entry, want in zip(ranked, case["expected"]):
        detail = explain(entry.item, **options)
        assert entry.score == pytest.approx(want["score"], abs=TOLERANCE)
        assert detail.engagement == pytest.approx(want["engagement"], abs=TOLERANCE)
        assert detail.quality == pytest.approx(want["quality"], abs=TOLERANCE)
        assert detail.age_hours == pytest.approx(want["ageHours"], abs=TOLERANCE)
        assert detail.time_penalty == pytest.approx(want["timePenalty"], abs=TOLERANCE)


@pytest.mark.parametrize("key", sorted(FIXTURE["sqlExpressions"]))
def test_sql_expression_is_byte_identical_across_sdks(key):
    preset, dialect, strategy = key.split("/")
    assert sql_expression(preset, strategy, dialect=dialect) == FIXTURE["sqlExpressions"][key]
