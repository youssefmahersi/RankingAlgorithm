"""The v1 API, for reference and for testing the migration.

There was never a Python v1 — this is a faithful transcription of the JavaScript
one, so that a team porting a v1 service to Python can compare old and new
orderings on real data before committing to the switch. It emits a deprecation
warning on construction.

Nothing here is maintained. The v1 formula saturates (as ``t`` grows the
denominator tends to ``1 + start_value``, so time stops discriminating entirely),
burns 99.8% of its dynamic range in the first 10% of the tuning window, couples
its two parameters, and multiplies a zero engagement sum by the freshness boost —
so a new item with no engagement scores zero forever and never surfaces.

See MIGRATION.md. This module is removed in 3.0.0.
"""

from __future__ import annotations

import math
import warnings
from typing import Any, Dict, List, Sequence

_NOTICE = (
    "rankingalgorithm.legacy.RankingAlgorithm reproduces the v1 formula and is "
    "removed in 3.0.0. The v1 formula saturates: past a few multiples of `stretch`, "
    "two items with equal engagement score the same whether they are a day or a "
    "year old, and an item with no engagement scores zero regardless of age. "
    "Use rankingalgorithm.rank() instead. "
    "See https://github.com/youssefmahersi/RankingAlgorithm/blob/main/MIGRATION.md"
)


class RankingAlgorithm:
    """The v1 class, preserved bug-for-bug.

    .. deprecated:: 2.0.0
       Use :func:`rankingalgorithm.rank` instead.
    """

    def __init__(self, stretch: float, start_value: float, config: Sequence[Dict[str, Any]]):
        warnings.warn(_NOTICE, DeprecationWarning, stacklevel=2)
        self.stretch = stretch
        self.start_value = start_value
        self.config: List[Dict[str, Any]] = list(config)

    def time(self, t: float) -> float:
        return 1 - math.exp(-(t / self.stretch)) + self.start_value

    def calc(self, *sum_props: float) -> float:
        total = 0.0
        for i, entry in enumerate(self.config):
            if entry.get("valuable") is True:
                ref_index = next(
                    (
                        j
                        for j, arg in enumerate(self.config)
                        if arg.get("ref") == self.config[i]["field"]
                    ),
                    -1,
                )
                if ref_index != -1:
                    if entry.get("typeOfAdd") == "Sum":
                        total += sum_props[i] + sum_props[ref_index]
                    elif entry.get("typeOfAdd") == "Multiplication":
                        total += sum_props[i] * sum_props[ref_index]
                else:
                    total += sum_props[i]
            else:
                total += sum_props[i]
        return total / self.time(sum_props[-1])
