"""Ordering: the deterministic sort built on top of :func:`score`."""

from __future__ import annotations

import time
from dataclasses import dataclass, replace
from functools import cmp_to_key
from typing import Any, Generic, List, Optional, Sequence, Tuple, TypeVar, Union

from .config import Config, Item, resolve_config
from .score import _age_hours, _get, _quality, _time_penalty

T = TypeVar("T")


@dataclass(frozen=True)
class Scored(Generic[T]):
    """An item paired with its score, as returned by :func:`rank_with_scores`."""

    item: T
    score: float


def _freeze_now(config: Config) -> Config:
    """Pin ``now`` once for the whole batch.

    Without this the clock is read per item, and a long list can be scored across
    a tick — two items with identical inputs would then get different penalties.
    """
    return config if config.now is not None else replace(config, now=time.time())


def _id_of(item: Item, id_field: str) -> Optional[str]:
    raw = _get(item, id_field)
    return None if raw is None else str(raw)


def _compare(a: Tuple[int, float, Optional[str]], b: Tuple[int, float, Optional[str]]) -> int:
    """Score descending, then id ascending, then input position.

    Written as an explicit comparator rather than a sort key because the id
    fallback is conditional: two items only compare by id when *both* carry one.
    The TypeScript, JavaScript and Go SDKs use the same rule.
    """
    _, a_score, a_id = a
    _, b_score, b_id = b
    if a_score != b_score:
        return -1 if a_score > b_score else 1
    if a_id is not None and b_id is not None and a_id != b_id:
        return -1 if a_id < b_id else 1
    return a[0] - b[0]


def rank_with_scores(
    items: Sequence[T], config: Union[str, Config, None] = None, **overrides: Any
) -> List[Scored[T]]:
    """Like :func:`rank`, but keeps each item's score.

    Use it when you need the numbers downstream — a cursor, a debug column, a
    cutoff threshold — instead of recomputing them.
    """
    resolved = _freeze_now(resolve_config(config, **overrides))

    entries = [
        (
            index,
            _quality(item, resolved) - _time_penalty(_age_hours(item, resolved), resolved),
            _id_of(item, resolved.id_field),
        )
        for index, item in enumerate(items)
    ]
    entries.sort(key=cmp_to_key(_compare))
    return [Scored(item=items[index], score=value) for index, value, _ in entries]


def rank(items: Sequence[T], config: Union[str, Config, None] = None, **overrides: Any) -> List[T]:
    """Order items best-first.

    Returns a new list; the input is not mutated. Ties break on the stable id
    (ascending), then on input position, so repeated calls on the same data always
    produce the same order.

    >>> rank(posts, "social-feed")            # doctest: +SKIP
    """
    return [entry.item for entry in rank_with_scores(items, config, **overrides)]


def top(
    items: Sequence[T], n: int, config: Union[str, Config, None] = None, **overrides: Any
) -> List[T]:
    """Top ``n`` items, best-first.

    Still a full sort — this library is the rescoring stage of a funnel, sized for
    a few hundred to a few thousand in-memory candidates, not for a table scan.
    Bound the candidate set in SQL first; see :func:`~rankingalgorithm.to_sql`.
    """
    if not isinstance(n, int) or isinstance(n, bool) or n < 0:
        raise TypeError(f"top() expects a non-negative integer, received {n!r}.")
    return rank(items, config, **overrides)[:n]
