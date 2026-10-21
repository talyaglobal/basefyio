"""Table queries against the ``rest/v1`` data API.

The builder collects columns, filters, ordering and paging and renders them as
the query string the data API parses (``select=``, ``column=op.value``,
``or=(…)``, ``order=``, ``limit=``, ``offset=``). Values travel in the URL and
are bound as parameters on the server; nothing here is ever turned into SQL.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any, Dict, Generic, Iterable, List, Mapping, Optional, Sequence, Tuple, TypeVar, Union
from urllib.parse import quote

from ._errors import BasefyioError
from ._http import HttpClient

T = TypeVar("T")

Row = Dict[str, Any]


@dataclass
class BasefyioResponse(Generic[T]):
    """What every data, auth and storage call returns.

    Exactly one of ``data`` and ``error`` is meaningful. ``count`` is set on
    table reads (the total number of matching rows, before ``limit``) and on
    writes made with ``returning="minimal"``.
    """

    data: Optional[T]
    error: Optional[BasefyioError]
    count: Optional[int] = None

    @property
    def ok(self) -> bool:
        return self.error is None

    def raise_for_error(self) -> "BasefyioResponse[T]":
        """Raise the carried :class:`BasefyioError`, if any; otherwise return ``self``."""
        if self.error is not None:
            raise self.error
        return self


# Operators the data API understands (see its FILTER_OPS list).
FILTER_OPERATORS = frozenset(
    {
        "eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike", "match", "imatch",
        "in", "is", "isdistinct", "fts", "plfts", "phfts", "wfts",
        "cs", "cd", "ov", "sl", "sr", "nxl", "nxr", "adj",
    }
)

_TEXT_SEARCH = re.compile(r"^(fts|plfts|phfts|wfts)\([A-Za-z_][A-Za-z0-9_]*\)$")
_NEEDS_QUOTES = set(",()'\" \t\r\n")


def format_value(value: Any) -> str:
    """Render one operand the way the data API reads it."""
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    return str(value)


def format_list_item(value: Any) -> str:
    """Render one ``in_()`` item, quoting it when the server would otherwise split or strip it.

    The server splits the list on commas outside quotes and strips a surrounding
    ``"`` or ``'`` pair, so an item containing a comma, a parenthesis, a quote or
    whitespace is wrapped in the quote character it does not itself contain.
    """
    text = format_value(value)
    if not any(ch in _NEEDS_QUOTES for ch in text):
        return text
    if '"' not in text:
        return f'"{text}"'
    if "'" not in text:
        return f"'{text}'"
    raise ValueError(
        f"in_() cannot send {text!r}: it contains both quote characters. Use sql() for this value."
    )


def _check_operator(operator: str) -> str:
    if operator in FILTER_OPERATORS or _TEXT_SEARCH.match(operator):
        return operator
    raise ValueError(f"Unknown filter operator {operator!r}")


def _check_count(value: Any, what: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{what} must be a non-negative integer")
    return value


class QueryBuilder:
    """One table operation, built fluently and sent with :meth:`execute`.

    ::

        rows = bf.from_("todos").select("id,title").eq("done", False).order("id").limit(20).execute()
        bf.from_("todos").insert({"title": "write docs"}).execute()
        bf.from_("todos").update({"done": True}).eq("id", 7).execute()
        bf.from_("todos").delete().eq("id", 7).execute()

    Reads return ``data`` as a list of rows and ``count`` as the total number of
    rows that match the filters. The server caps ``limit`` at 1000 rows per
    request; page with ``range()`` or ``offset()``.
    """

    def __init__(self, http: HttpClient, table: str) -> None:
        if not isinstance(table, str) or not table:
            raise ValueError("table name must be a non-empty string")
        self._http = http
        self._table = table
        self._op = "select"
        self._select = "*"
        self._filters: List[Tuple[str, str]] = []
        self._order: List[str] = []
        self._limit: Optional[int] = None
        self._offset: Optional[int] = None
        self._single = False
        self._body: Any = None
        self._prefer: Optional[str] = None

    # ── operations ─────────────────────────────────────────────────────────

    def select(self, columns: str = "*") -> "QueryBuilder":
        """Read rows. ``columns`` is passed through verbatim, so embedded
        relations such as ``"id,author:users(name)"`` work as the data API defines them."""
        self._op = "select"
        self._select = columns.strip() or "*"
        return self

    def insert(
        self,
        rows: Union[Row, Sequence[Row]],
        *,
        returning: str = "representation",
    ) -> "QueryBuilder":
        """Insert one row (a dict) or several (a list of dicts).

        With the default ``returning="representation"`` the inserted rows come
        back in ``data``; with ``"minimal"`` only ``count`` is set.
        """
        self._op = "insert"
        self._body = rows
        self._prefer = _prefer_for(returning)
        return self

    def update(self, values: Row, *, returning: str = "representation") -> "QueryBuilder":
        """Update the rows selected by the filters. The data API refuses an update without a filter."""
        self._op = "update"
        self._body = values
        self._prefer = _prefer_for(returning)
        return self

    def delete(self, *, returning: str = "representation") -> "QueryBuilder":
        """Delete the rows selected by the filters. The data API refuses a delete without a filter."""
        self._op = "delete"
        self._prefer = _prefer_for(returning)
        return self

    # ── filters ────────────────────────────────────────────────────────────

    def filter(self, column: str, operator: str, value: Any) -> "QueryBuilder":
        """Add ``column=operator.value``; the named operators below are shorthands for this."""
        self._filters.append((column, f"{_check_operator(operator)}.{format_value(value)}"))
        return self

    def eq(self, column: str, value: Any) -> "QueryBuilder":
        return self.filter(column, "eq", value)

    def neq(self, column: str, value: Any) -> "QueryBuilder":
        return self.filter(column, "neq", value)

    def gt(self, column: str, value: Any) -> "QueryBuilder":
        return self.filter(column, "gt", value)

    def gte(self, column: str, value: Any) -> "QueryBuilder":
        return self.filter(column, "gte", value)

    def lt(self, column: str, value: Any) -> "QueryBuilder":
        return self.filter(column, "lt", value)

    def lte(self, column: str, value: Any) -> "QueryBuilder":
        return self.filter(column, "lte", value)

    def like(self, column: str, pattern: str) -> "QueryBuilder":
        """``LIKE``; ``*`` in the pattern is a wildcard (``%`` works too)."""
        return self.filter(column, "like", pattern)

    def ilike(self, column: str, pattern: str) -> "QueryBuilder":
        """Case-insensitive ``LIKE``; ``*`` in the pattern is a wildcard."""
        return self.filter(column, "ilike", pattern)

    def match(self, column: str, regex: str) -> "QueryBuilder":
        return self.filter(column, "match", regex)

    def imatch(self, column: str, regex: str) -> "QueryBuilder":
        return self.filter(column, "imatch", regex)

    def contains(self, column: str, value: str) -> "QueryBuilder":
        """Array/JSON containment (``@>``); pass the Postgres literal, e.g. ``"{a,b}"``."""
        return self.filter(column, "cs", value)

    def contained_by(self, column: str, value: str) -> "QueryBuilder":
        return self.filter(column, "cd", value)

    def overlaps(self, column: str, value: str) -> "QueryBuilder":
        return self.filter(column, "ov", value)

    def is_(self, column: str, value: Union[None, bool, str]) -> "QueryBuilder":
        """``IS NULL`` / ``IS TRUE`` / ``IS FALSE`` / ``IS UNKNOWN``."""
        if value is None:
            operand = "null"
        elif value is True:
            operand = "true"
        elif value is False:
            operand = "false"
        elif isinstance(value, str) and value.lower() in ("null", "true", "false", "unknown"):
            operand = value.lower()
        else:
            raise ValueError("is_() expects None, True, False or 'unknown'")
        self._filters.append((column, f"is.{operand}"))
        return self

    def in_(self, column: str, values: Iterable[Any]) -> "QueryBuilder":
        """``column IN (…)``. An empty list matches no rows."""
        items = ",".join(format_list_item(v) for v in values)
        self._filters.append((column, f"in.({items})"))
        return self

    def not_(self, column: str, operator: str, value: Any) -> "QueryBuilder":
        """Negate one condition: ``column=not.operator.value``."""
        self._filters.append((column, f"not.{_check_operator(operator)}.{format_value(value)}"))
        return self

    def or_(self, conditions: str) -> "QueryBuilder":
        """OR a group of conditions written in the data API's own syntax, e.g.
        ``"status.eq.active,role.eq.admin"``. The group is AND-ed with the other filters."""
        self._filters.append(("or", _group(conditions)))
        return self

    def and_(self, conditions: str) -> "QueryBuilder":
        self._filters.append(("and", _group(conditions)))
        return self

    def text_search(
        self,
        column: str,
        query: str,
        *,
        type: str = "fts",
        config: Optional[str] = None,
    ) -> "QueryBuilder":
        """Full-text search: ``type`` is ``fts`` (to_tsquery), ``plfts`` (plainto),
        ``phfts`` (phraseto) or ``wfts`` (websearch); ``config`` names the text
        search configuration, e.g. ``"english"``."""
        if type not in ("fts", "plfts", "phfts", "wfts"):
            raise ValueError("text_search type must be fts, plfts, phfts or wfts")
        operator = f"{type}({config})" if config else type
        self._filters.append((column, f"{operator}.{query}"))
        return self

    # ── modifiers ──────────────────────────────────────────────────────────

    def order(self, column: str, *, desc: bool = False, nullsfirst: Optional[bool] = None) -> "QueryBuilder":
        term = f"{column}.{'desc' if desc else 'asc'}"
        if nullsfirst is True:
            term += ".nullsfirst"
        elif nullsfirst is False:
            term += ".nullslast"
        self._order.append(term)
        return self

    def limit(self, count: int) -> "QueryBuilder":
        self._limit = _check_count(count, "limit")
        return self

    def offset(self, count: int) -> "QueryBuilder":
        self._offset = _check_count(count, "offset")
        return self

    def range(self, start: int, end: int) -> "QueryBuilder":
        """Rows ``start`` to ``end`` inclusive, zero-based."""
        _check_count(start, "range start")
        _check_count(end, "range end")
        if end < start:
            raise ValueError("range end must not be before range start")
        self._offset = start
        self._limit = end - start + 1
        return self

    def single(self) -> "QueryBuilder":
        """Return the first row as ``data`` (or ``None`` when nothing matches) instead of a list."""
        self._single = True
        self._limit = 1
        return self

    def maybe_single(self) -> "QueryBuilder":
        return self.single()

    # ── rendering ──────────────────────────────────────────────────────────

    def to_params(self) -> List[Tuple[str, str]]:
        """The query string as (key, value) pairs, in the order they are sent."""
        params: List[Tuple[str, str]] = []
        if self._op == "select":
            params.append(("select", self._select))
        params.extend(self._filters)
        if self._op == "select":
            if self._order:
                params.append(("order", ",".join(self._order)))
            if self._limit is not None:
                params.append(("limit", str(self._limit)))
            if self._offset is not None:
                params.append(("offset", str(self._offset)))
        return params

    @property
    def path(self) -> str:
        return f"/rest/v1/{quote(self._table, safe='')}"

    # ── execution ──────────────────────────────────────────────────────────

    def execute(self) -> BasefyioResponse[Any]:
        """Send the request. HTTP failures are returned in ``error``, never raised."""
        try:
            if self._op == "select":
                body = self._http.json("GET", self.path, params=self.to_params())
                if isinstance(body, dict):
                    return self._rows(body.get("data") or [], body.get("count"))
                return self._rows(body or [], None)

            headers = {"Prefer": self._prefer} if self._prefer else None
            if self._op == "insert":
                body = self._http.json("POST", self.path, json=self._body, headers=headers)
            elif self._op == "update":
                body = self._http.json(
                    "PATCH", self.path, params=self.to_params(), json=self._body, headers=headers
                )
            else:
                body = self._http.json("DELETE", self.path, params=self.to_params(), headers=headers)

            if isinstance(body, list):
                return self._rows(body, None)
            if isinstance(body, dict) and "count" in body:
                return BasefyioResponse(data=None, error=None, count=body.get("count"))
            return BasefyioResponse(data=body, error=None)
        except BasefyioError as err:
            return BasefyioResponse(data=None, error=err)

    def _rows(self, rows: List[Row], count: Optional[int]) -> BasefyioResponse[Any]:
        if self._single:
            return BasefyioResponse(data=rows[0] if rows else None, error=None, count=count)
        return BasefyioResponse(data=rows, error=None, count=count)


def _prefer_for(returning: str) -> Optional[str]:
    if returning == "representation":
        return "return=representation"
    if returning == "minimal":
        return None
    raise ValueError("returning must be 'representation' or 'minimal'")


def _group(conditions: str) -> str:
    inner = conditions.strip()
    if inner.startswith("(") and inner.endswith(")"):
        inner = inner[1:-1]
    return f"({inner})"
