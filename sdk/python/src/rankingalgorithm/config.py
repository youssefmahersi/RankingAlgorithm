"""Configuration, presets, and the resolution rules that merge the two."""

from __future__ import annotations

import math
from dataclasses import dataclass, field, replace
from datetime import datetime
from typing import Any, Callable, Dict, Mapping, Optional, Union

from .errors import RankingError

DateInput = Union[datetime, str, int, float]
"""Anything accepted as a publication date.

A :class:`~datetime.datetime` (naive values are read as UTC), an ISO 8601 string,
or **epoch seconds** as an int/float — the convention of :func:`time.time`. Note
that the JavaScript and TypeScript SDKs take epoch *milliseconds* instead, each
following its own language's convention; every SDK agrees on datetimes and on ISO
strings, which is what the conformance fixture uses.
"""

Item = Any
"""An item to rank: a mapping, or any object with the fields as attributes."""


@dataclass(frozen=True)
class Bayesian:
    """Bayesian smoothing for star ratings. Opt-in, never on the default path.

    Without it a product with a single 5-star review outranks one with 200 reviews
    averaging 4.8. The smoothed rating pulls low-count averages towards ``prior``::

        smoothed = (prior_count * prior + count * average) / (prior_count + count)

    The result enters the engagement sum as one more additive term, weighted by
    ``weight``.
    """

    rating_field: str
    """Field holding the average rating, e.g. ``"stars"``."""

    count_field: str
    """Field holding the number of ratings, e.g. ``"reviews"``."""

    prior: float
    """Rating a product is assumed to have before any review arrives."""

    prior_count: float
    """Strength of the prior, expressed in reviews."""

    weight: float
    """Weight of the smoothed rating inside the engagement sum."""


@dataclass(frozen=True)
class Config:
    """A fully resolved configuration.

    Build one with :func:`resolve_config` rather than by hand; that is what applies
    the preset defaults and the validation.
    """

    gravity: float
    """Decay speed ``g``. ``0`` ignores time entirely."""

    grace_hours: float
    """Grace window ``t0``, in hours. Must be > 0."""

    signals: Mapping[str, float] = field(default_factory=dict)
    """Additive signal weights, by field name."""

    engagement: Optional[Callable[[Item], float]] = None
    """Replaces the weighted sum entirely when provided."""

    date_field: str = "created_at"
    """Field holding the publication date."""

    get_date: Optional[Callable[[Item], DateInput]] = None
    """Escape hatch when the date is not a plain field."""

    id_field: str = "id"
    """Field holding a stable id, used for the deterministic tie-break."""

    quality_field: Optional[str] = None
    """Field holding a precomputed ``log10(1 + sum)``, if you store it."""

    now: Optional[DateInput] = None
    """Reference instant. Injectable for tests, SQL parity and pagination."""

    on_future_item: str = "error"
    """``"error"`` or ``"clamp"``: what to do with an item published in the future."""

    bayesian: Optional[Bayesian] = None
    """Opt-in Bayesian smoothing of star ratings."""


PRESETS: Dict[str, Config] = {
    "social-feed": Config(
        gravity=1.5,
        grace_hours=2,
        signals={"like": 1, "comment": 3, "share": 5},
        date_field="createdAt",
    ),
    "ecommerce": Config(
        gravity=0.3,
        grace_hours=72,
        signals={"view": 0.05, "cart": 1, "purchase": 10},
        date_field="createdAt",
    ),
}
"""Presets are the product; configuration is the advanced option.

``social-feed``: a 24 h old item needs ~47x the engagement of a fresh one to tie,
~125x at 48 h. Content is effectively dead in two days.

``ecommerce``: a 90-day-old product needs only ~2.8x the sales of a new one, and
over a full year the penalty reaches only ~4.2x — a genuine best-seller stays on
top for years while remaining separable by age.

.. note::
   ``date_field`` defaults to ``"createdAt"`` for cross-SDK consistency, since the
   shared conformance fixture is JSON. Pass ``date_field="created_at"`` for the
   Python-native spelling.
"""

DEFAULT_PRESET = "social-feed"
"""The preset used when none is named."""

_FIELDS = frozenset(f.name for f in Config.__dataclass_fields__.values())


def resolve_config(config: Union[str, Config, None] = None, **overrides: Any) -> Config:
    """Merge a preset with keyword overrides and validate the result.

    ``config`` is a preset name, an existing :class:`Config`, or ``None`` for the
    default preset. Keyword arguments override individual fields::

        resolve_config()                                  # social-feed
        resolve_config("ecommerce")
        resolve_config("social-feed", gravity=2.0)
        resolve_config(gravity=0.8, grace_hours=6, signals={"upvote": 1})
    """
    if isinstance(config, Config):
        base = config
    else:
        name = DEFAULT_PRESET if config is None else config
        if name not in PRESETS:
            raise RankingError(
                f"Unknown preset {name!r}. Available: {', '.join(sorted(PRESETS))}."
            )
        base = PRESETS[name]

    unknown = set(overrides) - _FIELDS
    if unknown:
        raise RankingError(
            f"Unknown option(s) {', '.join(sorted(repr(u) for u in unknown))}. "
            f"Valid options: {', '.join(sorted(_FIELDS))}."
        )

    resolved = replace(base, **{k: v for k, v in overrides.items() if v is not None})
    _validate(resolved)
    return resolved


def _validate(config: Config) -> None:
    if not isinstance(config.gravity, (int, float)) or not math.isfinite(config.gravity):
        raise RankingError(f"gravity must be a finite number, received {config.gravity!r}.")
    if config.gravity < 0:
        raise RankingError(
            f"gravity must be >= 0, received {config.gravity}. "
            "A negative gravity ranks old items first."
        )
    if (
        not isinstance(config.grace_hours, (int, float))
        or not math.isfinite(config.grace_hours)
        or config.grace_hours <= 0
    ):
        raise RankingError(
            f"grace_hours must be a finite number > 0, received {config.grace_hours!r}. "
            "It is what keeps log10(t + t0) finite at t = 0."
        )
    for name, weight in config.signals.items():
        if not isinstance(weight, (int, float)) or not math.isfinite(weight):
            raise RankingError(
                f"Weight for signal {name!r} must be a finite number, received {weight!r}."
            )
    if config.on_future_item not in ("error", "clamp"):
        raise RankingError(
            f"on_future_item must be 'error' or 'clamp', received {config.on_future_item!r}."
        )
    if config.bayesian is not None:
        b = config.bayesian
        checks = (("prior", b.prior), ("prior_count", b.prior_count), ("weight", b.weight))
        for label, value in checks:
            if not isinstance(value, (int, float)) or not math.isfinite(value):
                raise RankingError(f"bayesian.{label} must be a finite number, received {value!r}.")
        if b.prior_count < 0:
            raise RankingError(f"bayesian.prior_count must be >= 0, received {b.prior_count}.")
