"""Translate a configuration into the SQL that reproduces it.

**The question that decides everything: does ``now`` cancel when comparing two
rows?** Under the power law time sits inside a log, so it does not cancel — the
order genuinely changes as the clock moves, and no static index can hold it.
Under the exponential family time enters linearly and ``now`` cancels completely:
only the difference of publication dates matters, and that never changes. This is
why Reddit's formula is linear in time, and it was not an accident.
"""

from __future__ import annotations

import math
import re
from typing import Any, Mapping, Optional, Union

from .config import Config, resolve_config
from .errors import RankingError
from .tuning import tau_seconds

EPOCH_OFFSET_2020 = 1577836800
"""2020-01-01T00:00:00Z. Counting from here rather than 1970 preserves float precision."""

_IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_$]*$")


def _identifier(name: str, label: str) -> str:
    """Validate a name and return it bare. Anything needing escaping is rejected."""
    if not isinstance(name, str) or not _IDENTIFIER.match(name):
        raise RankingError(
            f"{label} {name!r} is not a plain SQL identifier. Pass a bare name matching "
            "[A-Za-z_][A-Za-z0-9_$]*, or write the SQL by hand."
        )
    return name


def _quoted(name: str, label: str, dialect: str) -> str:
    """Quote an identifier for the target dialect.

    Everything is quoted, always. ``like`` — the default weight name in the
    ``social-feed`` preset — is a reserved word in Postgres, so bare emission
    produces a syntax error on the default path. Quoting also preserves the case
    of camelCase columns, which is what ORM-created schemas usually have.
    """
    bare = _identifier(name, label)
    return f"`{bare}`" if dialect == "mysql" else f'"{bare}"'


def _num(value: float) -> str:
    """Format a number the way every SDK formats it, so the output is byte-identical."""
    rounded = float(f"{float(value):.12g}")
    if rounded.is_integer() and abs(rounded) < 1e15:
        return f"{int(rounded)}.0"
    return repr(rounded)


def _log_fn(dialect: str) -> str:
    # Postgres `log(x)` is already base 10; MySQL needs log10() since log() is natural.
    return "log" if dialect == "postgres" else "log10"


def _engagement_sql(config: Config, columns: Mapping[str, str], dialect: str) -> str:
    if config.engagement is not None:
        raise RankingError(
            "A custom engagement callable cannot be translated to SQL. Express the same "
            "thing as signal weights, or write the expression by hand."
        )
    terms = []
    # Sorted, so the emitted SQL does not depend on how the signals dict was
    # written — and so Go, whose maps have no iteration order, can match it.
    for field_name in sorted(config.signals):
        weight = config.signals[field_name]
        if weight == 0:
            continue
        column = _quoted(columns.get(field_name, field_name), "Column", dialect)
        terms.append(column if weight == 1 else f"{_num(weight)} * {column}")

    if config.bayesian is not None:
        b = config.bayesian
        rating = _quoted(columns.get(b.rating_field, b.rating_field), "Column", dialect)
        count = _quoted(columns.get(b.count_field, b.count_field), "Column", dialect)
        terms.append(
            f"{_num(b.weight)} * (({_num(b.prior_count)} * {_num(b.prior)} + {count} * {rating}) "
            f"/ nullif({_num(b.prior_count)} + {count}, 0))"
        )

    return " + ".join(terms) if terms else "0"


def sql_expression(
    config: Union[str, Config, None] = None,
    strategy: str = "B",
    *,
    columns: Optional[Mapping[str, str]] = None,
    date_column: str = "created_at",
    epoch_column: str = "created_epoch",
    tau: Optional[float] = None,
    epoch_offset: int = EPOCH_OFFSET_2020,
    dialect: str = "postgres",
    **overrides: Any,
) -> str:
    """Just the score expression, without the surrounding statement."""
    resolved = resolve_config(config, **overrides)
    log = _log_fn(dialect)
    total = _engagement_sql(resolved, columns or {}, dialect)

    if strategy == "A":
        epoch = _quoted(epoch_column, "Column", dialect)
        constant = tau_seconds(resolved) if tau is None else tau
        if not math.isfinite(constant) or constant <= 0:
            raise RankingError(
                "Strategy A needs a finite, positive tau. With gravity = 0 time is ignored "
                "entirely, so there is nothing to index on — rank by engagement alone."
            )
        return f"{log}(1 + {total}) + ({epoch} - {_num(epoch_offset)}) / {_num(constant)}"

    date = _quoted(date_column, "Column", dialect)
    age = (
        f"extract(epoch from now() - {date}) / 3600.0"
        if dialect == "postgres"
        else f"timestampdiff(second, {date}, now()) / 3600.0"
    )
    return (
        f"{log}(1 + {total}) - {_num(resolved.gravity)} * "
        f"{log}(({age}) + {_num(resolved.grace_hours)})"
    )


def to_sql(
    config: Union[str, Config, None] = None,
    strategy: str = "B",
    *,
    table: str = "posts",
    columns: Optional[Mapping[str, str]] = None,
    date_column: str = "created_at",
    epoch_column: str = "created_epoch",
    score_column: str = "hot",
    window_days: int = 7,
    limit: int = 20,
    tau: Optional[float] = None,
    epoch_offset: int = EPOCH_OFFSET_2020,
    dialect: str = "postgres",
    **overrides: Any,
) -> str:
    """Emit the SQL equivalent of a configuration.

    - **Strategy A** (high volume): an indexed generated column. The exponential
      form, frozen order, constant-cost index scan, recomputed on a vote rather
      than every second. Recommended for ``social-feed``.
    - **Strategy B** (power law, bounded window): the exact formula, over a
      candidate set the ``WHERE`` clause has already cut to a few thousand rows.
      Valid whenever the relevance window is bounded — true of a feed, never of a
      catalogue. Recommended for ``ecommerce`` with a nightly batch recompute.
    """
    if dialect not in ("postgres", "mysql"):
        raise RankingError(f"Unsupported dialect {dialect!r}. Supported: postgres, mysql.")
    table_name = _identifier(table, "Table")
    table = _quoted(table_name, "Table", dialect)
    expression = sql_expression(
        config,
        strategy,
        columns=columns,
        date_column=date_column,
        epoch_column=epoch_column,
        tau=tau,
        epoch_offset=epoch_offset,
        dialect=dialect,
        **overrides,
    )

    if strategy == "A":
        score_name = _identifier(score_column, "Column")
        score_col = _quoted(score_name, "Column", dialect)
        index = _quoted(f"{table_name}_{score_name}_idx", "Index", dialect)
        epoch_col = _identifier(epoch_column, "Column")
        column_type = "double precision" if dialect == "postgres" else "double"
        extractor = (
            "extract(epoch from created_at)"
            if dialect == "postgres"
            else "unix_timestamp(created_at)"
        )
        return "\n".join(
            [
                "-- Strategy A: indexed generated column. Order is frozen, so the index stays"
                " valid.",
                f"-- {epoch_col} must be a plain bigint written at insert time:",
                f"--   {extractor} is not immutable on a timestamp",
                "--   with time zone, and generated columns must be immutable.",
                f"ALTER TABLE {table} ADD COLUMN {score_col} {column_type}",
                "  GENERATED ALWAYS AS (",
                f"    {expression}",
                "  ) STORED;",
                "",
                f"CREATE INDEX {index} ON {table} ({score_col} DESC);",
                "",
                f"SELECT * FROM {table} ORDER BY {score_col} DESC LIMIT {limit};",
            ]
        )

    if not isinstance(window_days, int) or isinstance(window_days, bool) or window_days <= 0:
        raise RankingError(f"window_days must be a positive integer, received {window_days!r}.")
    date_col = _quoted(date_column, "Column", dialect)
    window = (
        f"now() - interval '{window_days} days'"
        if dialect == "postgres"
        else f"now() - interval {window_days} day"
    )
    return "\n".join(
        [
            "-- Strategy B: exact power law over a bounded candidate set.",
            f"-- The WHERE clause uses an ordinary index on {date_col} and cuts the set to a few",
            "-- thousand rows; sorting that handful is free.",
            "SELECT *,",
            f"       {expression} AS score",
            f"FROM {table}",
            f"WHERE {date_col} > {window}",
            "ORDER BY score DESC",
            f"LIMIT {limit};",
        ]
    )
