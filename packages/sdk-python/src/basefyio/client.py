"""The entry point: :func:`create_client` and :class:`BasefyioClient`."""

from __future__ import annotations

import os
from typing import Any, Dict, List, Mapping, Optional, Sequence
from urllib.parse import quote

import httpx

from ._errors import BasefyioError
from ._http import DEFAULT_API_URL, HttpClient
from .auth import AuthClient
from .query import BasefyioResponse, QueryBuilder
from .storage import StorageClient

Row = Dict[str, Any]


class BasefyioClient:
    """A client for one project.

    ::

        import basefyio

        bf = basefyio.create_client(
            url="https://api.basefyio.com",
            key="<anon or service key>",
            project_id="<project id>",   # needed for storage and sql()
        )
        todos = bf.from_("todos").select("*").eq("done", False).execute()

    ``url``, ``key`` and ``project_id`` fall back to the environment variables
    ``BASEFYIO_API_URL``, ``BASEFYIO_ANON_KEY`` and ``BASEFYIO_PROJECT_ID``.
    The ``rest/v1`` data and auth routes identify the project from the key, so
    ``project_id`` is only required for :attr:`storage` and :meth:`sql`.
    """

    def __init__(
        self,
        url: Optional[str] = None,
        key: Optional[str] = None,
        project_id: Optional[str] = None,
        *,
        headers: Optional[Mapping[str, str]] = None,
        timeout: float = 30.0,
        auto_refresh: bool = True,
        transport: Optional[httpx.BaseTransport] = None,
    ) -> None:
        api_url = url or os.environ.get("BASEFYIO_API_URL") or DEFAULT_API_URL
        api_key = key or os.environ.get("BASEFYIO_ANON_KEY")
        if not api_key:
            raise BasefyioError("Missing key. Pass key= to create_client() or set BASEFYIO_ANON_KEY.")
        self.project_id: Optional[str] = project_id or os.environ.get("BASEFYIO_PROJECT_ID") or None

        self._http = HttpClient(
            api_url,
            api_key,
            headers,
            lambda: self.auth._bearer(),
            timeout,
            transport,
        )
        self.auth = AuthClient(self._http, auto_refresh=auto_refresh)
        self._storage: Optional[StorageClient] = None

    # ── data ───────────────────────────────────────────────────────────────

    def from_(self, table: str) -> QueryBuilder:
        """Start a query on ``table``."""
        return QueryBuilder(self._http, table)

    def rpc(self, fn: str, args: Optional[Mapping[str, Any]] = None) -> List[Row]:
        """Call a database function by name with named arguments. Raises
        :class:`BasefyioError` when the call fails."""
        body = dict(args or {})
        data = self._http.json("POST", f"/rest/v1/rpc/{quote(fn, safe='')}", json=body)
        return data if isinstance(data, list) else []

    def sql(self, query: str, params: Optional[Sequence[Any]] = None) -> BasefyioResponse[List[Row]]:
        """Run a SQL statement with bound values.

        Pass values in ``params`` (``$1``, ``$2`` …), never inside the query
        string. Needs ``project_id``.
        """
        project_id = self._require_project_id("sql()")
        body: Dict[str, Any] = {"projectId": project_id, "query": query}
        if params:
            body["params"] = list(params)
        try:
            result = self._http.json("POST", "/sql/execute", json=body)
        except BasefyioError as err:
            return BasefyioResponse(data=None, error=err)
        rows = result.get("rows") if isinstance(result, dict) else None
        return BasefyioResponse(data=list(rows or []), error=None)

    # ── storage ────────────────────────────────────────────────────────────

    @property
    def storage(self) -> StorageClient:
        if self._storage is None:
            self._storage = StorageClient(self._http, self._require_project_id("storage"))
        return self._storage

    # ── lifecycle ──────────────────────────────────────────────────────────

    @property
    def api_url(self) -> str:
        return self._http.base_url

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> "BasefyioClient":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    def _require_project_id(self, what: str) -> str:
        if not self.project_id:
            raise BasefyioError(
                f"project_id is required for {what}; pass project_id= to create_client() or set BASEFYIO_PROJECT_ID."
            )
        return self.project_id


def create_client(
    url: Optional[str] = None,
    key: Optional[str] = None,
    project_id: Optional[str] = None,
    *,
    headers: Optional[Mapping[str, str]] = None,
    timeout: float = 30.0,
    auto_refresh: bool = True,
    transport: Optional[httpx.BaseTransport] = None,
) -> BasefyioClient:
    """Create a :class:`BasefyioClient`. See the class for the arguments."""
    return BasefyioClient(
        url,
        key,
        project_id,
        headers=headers,
        timeout=timeout,
        auto_refresh=auto_refresh,
        transport=transport,
    )
