"""The HTTP layer every module shares.

One place decides the base URL, the headers each request carries and how a
failure is reported, so the query builder, auth and storage modules only say
*what* they send.
"""

from __future__ import annotations

from typing import Any, Callable, Dict, Mapping, Optional

import httpx

from ._errors import BasefyioError

DEFAULT_API_URL = "https://api.basefyio.com"

TokenProvider = Callable[[], Optional[str]]


def normalize_base_url(url: str) -> str:
    """Strip trailing slashes and add the ``/api`` prefix when it is missing.

    ``https://api.basefyio.com`` and ``https://api.basefyio.com/api/`` both
    become ``https://api.basefyio.com/api``.
    """
    base = (url or "").strip().rstrip("/")
    if not base:
        raise BasefyioError("url must not be empty")
    if not base.endswith("/api"):
        base = f"{base}/api"
    return base


class HttpClient:
    """A thin wrapper over :class:`httpx.Client`.

    Every request carries the project key in the ``apikey`` header. When the
    token provider returns an access token (a signed-in user) it is added as
    ``Authorization: Bearer …``; the key itself is never mirrored into that
    header.
    """

    def __init__(
        self,
        base_url: str,
        api_key: str,
        headers: Optional[Mapping[str, str]],
        token_provider: TokenProvider,
        timeout: float,
        transport: Optional[httpx.BaseTransport] = None,
    ) -> None:
        self._base_url = normalize_base_url(base_url)
        self._api_key = api_key
        self._global_headers: Dict[str, str] = dict(headers or {})
        self._token_provider = token_provider
        self._client = httpx.Client(timeout=timeout, transport=transport)

    @property
    def base_url(self) -> str:
        return self._base_url

    def headers(
        self,
        extra: Optional[Mapping[str, str]] = None,
        *,
        json_body: bool = False,
        auth: bool = True,
    ) -> Dict[str, str]:
        headers: Dict[str, str] = {"apikey": self._api_key}
        headers.update(self._global_headers)
        if json_body:
            headers["Content-Type"] = "application/json"
        if extra:
            headers.update(extra)
        if auth:
            token = self._token_provider()
            if token:
                headers["Authorization"] = f"Bearer {token}"
        return headers

    def request(
        self,
        method: str,
        path: str,
        *,
        params: Any = None,
        json: Any = None,
        files: Any = None,
        data: Any = None,
        headers: Optional[Mapping[str, str]] = None,
        auth: bool = True,
    ) -> httpx.Response:
        """Send one request and return the response, or raise :class:`BasefyioError`."""
        url = f"{self._base_url}{path}"
        request_headers = self.headers(headers, json_body=json is not None, auth=auth)
        try:
            response = self._client.request(
                method,
                url,
                params=params,
                json=json,
                files=files,
                data=data,
                headers=request_headers,
            )
        except httpx.HTTPError as exc:
            raise BasefyioError(str(exc) or exc.__class__.__name__) from exc
        if response.is_success:
            return response
        raise self.error_from_response(response)

    def json(self, method: str, path: str, **kwargs: Any) -> Any:
        """Send a request and return the decoded JSON body (``None`` when there is none)."""
        response = self.request(method, path, **kwargs)
        content_type = response.headers.get("content-type", "")
        if "application/json" in content_type:
            return response.json()
        return None

    def bytes(self, method: str, path: str, **kwargs: Any) -> bytes:
        return self.request(method, path, **kwargs).content

    @staticmethod
    def error_from_response(response: httpx.Response) -> BasefyioError:
        message = f"Request failed with status {response.status_code}"
        code: Optional[str] = None
        details: Optional[str] = None
        try:
            body = response.json()
        except ValueError:
            body = None
        if isinstance(body, dict):
            raw_message = body.get("message") or body.get("error")
            if isinstance(raw_message, list):
                message = "; ".join(str(m) for m in raw_message) or message
            elif raw_message:
                message = str(raw_message)
            if body.get("code"):
                code = str(body["code"])
            if body.get("details"):
                details = str(body["details"])
        return BasefyioError(message, status=response.status_code, code=code, details=details, response=response)

    def close(self) -> None:
        self._client.close()
