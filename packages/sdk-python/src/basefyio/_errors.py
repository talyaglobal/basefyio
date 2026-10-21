"""The one exception type this client raises or carries."""

from __future__ import annotations

from typing import Any, Optional


class BasefyioError(Exception):
    """An HTTP or transport failure, with what the API said about it.

    ``message`` is the API's ``message`` field when there is one (the platform
    returns either a string or a list of validation messages, which are joined
    with ``"; "``), otherwise ``"Request failed with status N"``. ``status`` is
    the HTTP status, or ``None`` for a transport failure. ``code`` carries the
    API's error code when present, for example ``PGRST100`` for a query the
    data API could not parse.
    """

    def __init__(
        self,
        message: str,
        status: Optional[int] = None,
        code: Optional[str] = None,
        details: Optional[str] = None,
        response: Any = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.status = status
        self.code = code
        self.details = details
        self.response = response

    def __repr__(self) -> str:
        parts = [repr(self.message)]
        if self.status is not None:
            parts.append(f"status={self.status}")
        if self.code:
            parts.append(f"code={self.code!r}")
        return f"BasefyioError({', '.join(parts)})"
