"""The tuning protocol: derive gravity from a product question, not from guesses."""

from __future__ import annotations

import math
from typing import Any, Union

from .config import Config, resolve_config
from .errors import RankingError


def solve_gravity(ratio: float, after_hours: float, grace_hours: float) -> float:
    """Derive ``gravity`` from one product question.

    Do not tune by trial and error. Ask: *an item X hours old, how many times more
    engagement must it have to beat a brand-new one?* Then invert::

        g = log(ratio) / log((X + t0) / t0)

    Set ``grace_hours`` first ("how long does content get to start?"), then solve
    for gravity. The two interact strongly: raising ``grace_hours`` flattens the
    entire time penalty, not just the early window, so re-solve gravity whenever
    you change it.

    >>> round(solve_gravity(ratio=47, after_hours=24, grace_hours=2), 3)
    1.501
    """
    if not ratio > 0:
        raise RankingError(f"ratio must be > 0, received {ratio!r}.")
    if not after_hours > 0:
        raise RankingError(f"after_hours must be > 0, received {after_hours!r}.")
    if not grace_hours > 0:
        raise RankingError(f"grace_hours must be > 0, received {grace_hours!r}.")
    return math.log(ratio) / math.log((after_hours + grace_hours) / grace_hours)


def engagement_ratio(
    after_hours: float, config: Union[str, Config, None] = None, **overrides: Any
) -> float:
    """The forward direction of :func:`solve_gravity`.

    How much more engagement an item ``after_hours`` old needs to tie with a
    brand-new one. Use it to sanity-check a configuration you did not derive
    yourself — including the presets.

    >>> round(engagement_ratio(24, "social-feed"), 1)
    46.9
    """
    resolved = resolve_config(config, **overrides)
    if not after_hours >= 0:
        raise RankingError(f"after_hours must be >= 0, received {after_hours!r}.")
    return float(((after_hours + resolved.grace_hours) / resolved.grace_hours) ** resolved.gravity)


def decade_hours(config: Union[str, Config, None] = None, **overrides: Any) -> float:
    """Hours until the time penalty is worth exactly one factor of ten.

    The most legible number about a configuration: "after this long, you need 10x
    the engagement to hold your place".
    """
    resolved = resolve_config(config, **overrides)
    if resolved.gravity == 0:
        return math.inf
    return float(resolved.grace_hours * (10 ** (1 / resolved.gravity) - 1))


def tau_seconds(config: Union[str, Config, None] = None, **overrides: Any) -> float:
    """The exponential-family time constant matching this configuration, in seconds.

    This is the ``tau`` used by SQL strategy A. The power law and the exponential
    family are different curves; they are matched here at the point both parameter
    families are defined by — one factor of ten in engagement. Strategy A trades
    exactness for a static index, and this is the conversion that trade goes
    through.
    """
    return decade_hours(config, **overrides) * 3600
