"""Version metadata.

``VERSION`` is the release of this SDK. ``SPEC_VERSION`` is the major revision of
the ranking specification it implements — every SDK (TypeScript, JavaScript,
Python, Go) reporting the same ``SPEC_VERSION`` produces identical orderings for
identical input. Both values are kept in sync by ``scripts/sync-version.mjs`` and
verified in CI; do not edit them by hand.
"""

from __future__ import annotations

VERSION = "2.0.0"
"""Release of this SDK."""

SPEC_VERSION = 2
"""Major revision of the ranking specification implemented here."""

FORMULA = "score = log10(1 + sum(w_i * p_i)) - g * log10(t + t0)"
"""The scoring formula, for logs, docs and :func:`explain` output."""
