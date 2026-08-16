"""Deterministic, dependency-free ranking for feeds and catalogues.

::

    score = log10(1 + sum(w_i * p_i)) - g * log10(t + t0)

Ranking you can audit, run inside a SQL query, and explain to a lawyer.

>>> from rankingalgorithm import rank
>>> ordered = rank(posts, "social-feed")            # doctest: +SKIP

One point of score difference equals a factor of ten in engagement. Negative
scores are normal and carry no meaning — only the order matters.
"""

from __future__ import annotations

from .config import (
    DEFAULT_PRESET,
    PRESETS,
    Bayesian,
    Config,
    DateInput,
    Item,
    resolve_config,
)
from .errors import RankingError
from .rank import Scored, rank, rank_with_scores, top
from .score import (
    BayesianBreakdown,
    Explanation,
    SignalBreakdown,
    age_hours,
    engagement,
    explain,
    quality,
    score,
    time_penalty,
    to_timestamp,
)
from .sql import EPOCH_OFFSET_2020, sql_expression, to_sql
from .tuning import decade_hours, engagement_ratio, solve_gravity, tau_seconds
from .version import FORMULA, SPEC_VERSION, VERSION

__all__ = [
    # version
    "VERSION",
    "SPEC_VERSION",
    "FORMULA",
    # errors
    "RankingError",
    # config
    "Config",
    "Bayesian",
    "DateInput",
    "Item",
    "PRESETS",
    "DEFAULT_PRESET",
    "resolve_config",
    # scoring
    "score",
    "quality",
    "time_penalty",
    "age_hours",
    "engagement",
    "explain",
    "to_timestamp",
    "Explanation",
    "SignalBreakdown",
    "BayesianBreakdown",
    # ranking
    "rank",
    "rank_with_scores",
    "top",
    "Scored",
    # tuning
    "solve_gravity",
    "engagement_ratio",
    "decade_hours",
    "tau_seconds",
    # sql
    "to_sql",
    "sql_expression",
    "EPOCH_OFFSET_2020",
]

__version__ = VERSION
