"""The formula itself: ``log10(1 + sum(w_i * p_i)) - g * log10(t + t0)``."""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Any, Dict, List, Mapping, Optional, Tuple, Union

from .config import Config, DateInput, Item, resolve_config
from .errors import RankingError
from .version import FORMULA

_SECONDS_PER_HOUR = 3600.0


def _get(item: Item, field_name: str) -> Any:
    """Read a field from a mapping or an object, whichever the caller passed."""
    if isinstance(item, Mapping):
        return item.get(field_name)
    return getattr(item, field_name, None)


def _number_at(item: Item, field_name: str) -> float:
    """Read a numeric field, treating a missing field as zero."""
    raw = _get(item, field_name)
    if raw is None:
        return 0.0
    if isinstance(raw, bool):
        raise RankingError(f"Field {field_name!r} must be a number, received a bool.")
    try:
        value = float(raw)
    except (TypeError, ValueError):
        raise RankingError(
            f"Field {field_name!r} must be a finite number, received {raw!r}."
        ) from None
    if not math.isfinite(value):
        raise RankingError(f"Field {field_name!r} must be a finite number, received {raw!r}.")
    return value


def to_timestamp(value: DateInput, label: str) -> float:
    """Normalise a date to epoch seconds.

    Accepts a :class:`~datetime.datetime` (naive values are read as UTC), an ISO
    8601 string, or epoch seconds as a number.
    """
    if isinstance(value, datetime):
        aware = value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)
        return aware.timestamp()
    if isinstance(value, bool):
        raise RankingError(f"{label} must be a datetime, an ISO 8601 string or epoch seconds.")
    if isinstance(value, (int, float)):
        if not math.isfinite(float(value)):
            raise RankingError(f"{label} must be finite epoch seconds, received {value!r}.")
        return float(value)
    if isinstance(value, str):
        text = value.strip()
        # datetime.fromisoformat only learned to parse a trailing "Z" in 3.11.
        if text.endswith(("Z", "z")):
            text = text[:-1] + "+00:00"
        try:
            parsed = datetime.fromisoformat(text)
        except ValueError:
            raise RankingError(f"{label} is not a parsable ISO 8601 date: {value!r}.") from None
        return to_timestamp(parsed, label)
    raise RankingError(
        f"{label} must be a datetime, an ISO 8601 string or epoch seconds, "
        f"received {type(value).__name__}."
    )


@dataclass(frozen=True)
class SignalBreakdown:
    """One signal's contribution to the engagement sum."""

    field: str
    value: float
    weight: float
    contribution: float
    """``weight * value``."""
    share: float
    """Fraction of the engagement sum, in ``[0, 1]``."""


@dataclass(frozen=True)
class BayesianBreakdown:
    """The Bayesian term, when smoothing is enabled."""

    average: float
    count: float
    smoothed: float
    weight: float
    contribution: float


@dataclass(frozen=True)
class Explanation:
    """Full decomposition of a score, as returned by :func:`explain`."""

    id: Optional[str]
    engagement: float
    """``sum(w_i * p_i)`` before the log."""
    signals: Tuple[SignalBreakdown, ...]
    quality: float
    """``log10(1 + engagement)``. Time-independent, storable, indexable."""
    age_hours: float
    time_penalty: float
    """``g * log10(t + t0)``. Subtracted from quality."""
    score: float
    gravity: float
    grace_hours: float
    formula: str = FORMULA
    bayesian: Optional[BayesianBreakdown] = None

    def to_dict(self) -> Dict[str, Any]:
        """A plain dict, for logging or serialising."""
        return asdict(self)


def _bayesian_term(item: Item, config: Config) -> Optional[BayesianBreakdown]:
    """The Bayesian term, or ``None`` when smoothing is disabled.

    Kept separate from the weighted sum so that :func:`explain` can report it on
    its own line — it is an opt-in exception to "no ML, no heuristics", and hiding
    it inside the signal list would misrepresent the score.
    """
    b = config.bayesian
    if b is None:
        return None
    average = _number_at(item, b.rating_field)
    count = _number_at(item, b.count_field)
    denominator = b.prior_count + count
    smoothed = (
        b.prior
        if denominator == 0
        else (b.prior_count * b.prior + count * average) / denominator
    )
    return BayesianBreakdown(average, count, smoothed, b.weight, b.weight * smoothed)


def _engagement(item: Item, config: Config) -> float:
    if config.engagement is not None:
        value = config.engagement(item)
        if not isinstance(value, (int, float)) or not math.isfinite(float(value)):
            raise RankingError(
                f"The engagement callable must return a finite number, received {value!r}."
            )
        return float(value)
    total = 0.0
    for name, weight in config.signals.items():
        total += weight * _number_at(item, name)
    term = _bayesian_term(item, config)
    if term is not None:
        total += term.contribution
    return total


def _quality(item: Item, config: Config) -> float:
    if config.quality_field is not None and _get(item, config.quality_field) is not None:
        return _number_at(item, config.quality_field)
    total = _engagement(item, config)
    if total < -1:
        raise RankingError(
            f"Engagement sum is {total}; log10(1 + sum) is undefined below -1. "
            "Negative weights large enough to push the sum under -1 are not supported — "
            "this library has no moderation logic."
        )
    return math.log10(1 + total)


def _assert_age(age: float, config: Config) -> float:
    if not math.isfinite(age):
        raise RankingError(f"Age must be a finite number of hours, received {age!r}.")
    if age < 0:
        if config.on_future_item == "clamp":
            return 0.0
        raise RankingError(
            f"Age is {age} hours: the item is published in the future relative to `now`. "
            "A negative age silently inverts the ranking, so it is rejected. "
            "Pass on_future_item='clamp' to treat future items as brand new instead."
        )
    return age


def _time_penalty(age: float, config: Config) -> float:
    if config.gravity == 0:
        return 0.0
    return config.gravity * math.log10(age + config.grace_hours)


def _age_hours(item: Item, config: Config) -> float:
    now = (
        datetime.now(timezone.utc).timestamp()
        if config.now is None
        else to_timestamp(config.now, "now")
    )
    raw = config.get_date(item) if config.get_date is not None else _get(item, config.date_field)
    if raw is None:
        raise RankingError(
            f"Item is missing its publication date. Expected field {config.date_field!r}; "
            "set date_field or pass a get_date callable."
        )
    created = to_timestamp(raw, f"Field {config.date_field!r}")
    return _assert_age((now - created) / _SECONDS_PER_HOUR, config)


def _score(item: Item, config: Config) -> float:
    return _quality(item, config) - _time_penalty(_age_hours(item, config), config)


# ------------------------------------------------------------------ public API


def engagement(item: Item, config: Union[str, Config, None] = None, **overrides: Any) -> float:
    """``sum(w_i * p_i)`` — the raw, pre-log engagement of an item."""
    return _engagement(item, resolve_config(config, **overrides))


def quality(item: Item, config: Union[str, Config, None] = None, **overrides: Any) -> float:
    """``log10(1 + sum(w_i * p_i))`` — the time-independent half of the score.

    This is the half you can store in a column and index: it only changes when
    engagement changes, not on every tick of the clock. Point ``quality_field`` at
    a stored value and it is read back instead of recomputed.
    """
    return _quality(item, resolve_config(config, **overrides))


def time_penalty(
    age_hours: float, config: Union[str, Config, None] = None, **overrides: Any
) -> float:
    """``g * log10(t + t0)`` — the time-dependent half, applied at query time.

    It is subtracted, and it is negative while ``t + t0 < 1``. Only differences
    between items matter, so the sign carries no meaning.
    """
    resolved = resolve_config(config, **overrides)
    return _time_penalty(_assert_age(float(age_hours), resolved), resolved)


def age_hours(item: Item, config: Union[str, Config, None] = None, **overrides: Any) -> float:
    """Age of an item in hours at ``now``, validated against the future policy."""
    return _age_hours(item, resolve_config(config, **overrides))


def score(item: Item, config: Union[str, Config, None] = None, **overrides: Any) -> float:
    """The score of a single item: ``quality - time_penalty``. Higher ranks first.

    One point of difference equals a factor of ten in engagement. Negative scores
    are normal and carry no meaning — only the order matters.
    """
    return _score(item, resolve_config(config, **overrides))


def explain(item: Item, config: Union[str, Config, None] = None, **overrides: Any) -> Explanation:
    """Decompose a score: every signal's contribution, the time penalty, the total.

    This is the "not AI" argument made tangible — and the fastest way to find out
    why an item you expected on top is not.
    """
    resolved = resolve_config(config, **overrides)
    total = _engagement(item, resolved)
    term = _bayesian_term(item, resolved)

    breakdowns: List[SignalBreakdown] = []
    if resolved.engagement is None:
        # Signal names are reported in sorted order in every SDK, so the breakdown
        # does not depend on how the signals dict was written (and Go, whose maps
        # have no order at all, can agree).
        for name in sorted(resolved.signals):
            weight = resolved.signals[name]
            value = _number_at(item, name)
            contribution = weight * value
            breakdowns.append(
                SignalBreakdown(
                    field=name,
                    value=value,
                    weight=weight,
                    contribution=contribution,
                    share=0.0 if total == 0 else contribution / total,
                )
            )

    q = _quality(item, resolved)
    age = _age_hours(item, resolved)
    penalty = _time_penalty(age, resolved)
    raw_id = _get(item, resolved.id_field)

    return Explanation(
        id=None if raw_id is None else str(raw_id),
        engagement=total,
        signals=tuple(breakdowns),
        bayesian=term,
        quality=q,
        age_hours=age,
        time_penalty=penalty,
        score=q - penalty,
        gravity=resolved.gravity,
        grace_hours=resolved.grace_hours,
    )
