"""Error type. Everything this package raises is a :class:`RankingError`."""

from __future__ import annotations


class RankingError(ValueError):
    """Raised for any invalid configuration, item or argument.

    It subclasses :class:`ValueError` so that existing ``except ValueError``
    handlers keep working, while callers who want to be specific can catch this.
    """
