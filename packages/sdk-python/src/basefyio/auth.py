"""End-user authentication for a project (``rest/v1/auth``)."""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Optional

from ._errors import BasefyioError
from ._http import HttpClient
from .query import BasefyioResponse
from .types import AuthTokens, User


@dataclass
class Session:
    access_token: str
    refresh_token: str
    expires_at: float
    token_type: str = "Bearer"
    user_id: Optional[str] = None
    email_verified: Optional[bool] = None
    user: Optional[Dict[str, Any]] = field(default=None)


class AuthClient:
    """Sign users up and in, and keep their session on the client.

    After ``sign_in`` every request carries ``Authorization: Bearer <token>``
    beside the project key, so the data API runs as that user. With
    ``auto_refresh`` (the default) a token about to expire is refreshed
    synchronously right before it is used.
    """

    def __init__(self, http: HttpClient, auto_refresh: bool = True, clock: Callable[[], float] = time.time) -> None:
        self._http = http
        self._auto_refresh = auto_refresh
        self._clock = clock
        self._session: Optional[Session] = None
        self._refreshing = False

    # ── sign up / in / out ─────────────────────────────────────────────────

    def sign_up(
        self,
        email: str,
        password: str,
        first_name: Optional[str] = None,
        last_name: Optional[str] = None,
    ) -> BasefyioResponse[AuthTokens]:
        body: Dict[str, Any] = {"email": email, "password": password}
        if first_name is not None:
            body["firstName"] = first_name
        if last_name is not None:
            body["lastName"] = last_name
        return self._token_call("/rest/v1/auth/signup", body)

    def sign_in(self, email: str, password: str) -> BasefyioResponse[AuthTokens]:
        return self._token_call("/rest/v1/auth/signin", {"email": email, "password": password})

    def sign_out(self) -> None:
        """Forget the session on this client. There is no server-side session to end."""
        self._session = None

    # ── session ────────────────────────────────────────────────────────────

    def get_user(self) -> BasefyioResponse[User]:
        if self._session is None:
            return BasefyioResponse(data=None, error=BasefyioError("Not signed in"))
        try:
            data = self._http.json("GET", "/rest/v1/auth/me")
        except BasefyioError as err:
            return BasefyioResponse(data=None, error=err)
        if self._session is not None and isinstance(data, dict):
            self._session.user = data
        return BasefyioResponse(data=data, error=None)

    def refresh(self) -> BasefyioResponse[AuthTokens]:
        """Exchange the refresh token for new tokens.

        A refusal from the server (4xx) ends the session; a transport failure
        keeps it so the caller can retry.
        """
        session = self._session
        if session is None or not session.refresh_token:
            return BasefyioResponse(data=None, error=BasefyioError("No refresh token available"))
        self._refreshing = True
        try:
            data = self._http.json(
                "POST", "/rest/v1/auth/refresh", json={"refreshToken": session.refresh_token}, auth=False
            )
        except BasefyioError as err:
            if err.status is not None and 400 <= err.status < 500:
                self._session = None
            return BasefyioResponse(data=None, error=err)
        finally:
            self._refreshing = False
        self._set_session(data)
        return BasefyioResponse(data=data, error=None)

    def get_session(self) -> Optional[Session]:
        return self._session

    def get_access_token(self) -> Optional[str]:
        return self._session.access_token if self._session else None

    def set_access_token(self, token: str) -> None:
        """Use an access token obtained elsewhere (for example on a server that
        received it from a browser). No expiry is known, so it is never refreshed."""
        if self._session is None:
            self._session = Session(access_token=token, refresh_token="", expires_at=float("inf"))
        else:
            self._session.access_token = token

    # ── internal ───────────────────────────────────────────────────────────

    def _bearer(self) -> Optional[str]:
        """The token to send with the next request, refreshing it first when it is about to expire."""
        session = self._session
        if session is None:
            return None
        if (
            self._auto_refresh
            and not self._refreshing
            and session.refresh_token
            and session.expires_at - 30 <= self._clock()
        ):
            self.refresh()
            session = self._session
        return session.access_token if session else None

    def _token_call(self, path: str, body: Dict[str, Any]) -> BasefyioResponse[AuthTokens]:
        try:
            data = self._http.json("POST", path, json=body, auth=False)
        except BasefyioError as err:
            return BasefyioResponse(data=None, error=err)
        self._set_session(data)
        return BasefyioResponse(data=data, error=None)

    def _set_session(self, tokens: Any) -> None:
        if not isinstance(tokens, dict) or not tokens.get("accessToken"):
            return
        expires_in = tokens.get("expiresIn")
        try:
            ttl = float(expires_in) if expires_in is not None else 300.0
        except (TypeError, ValueError):
            ttl = 300.0
        self._session = Session(
            access_token=str(tokens["accessToken"]),
            refresh_token=str(tokens.get("refreshToken") or ""),
            expires_at=self._clock() + ttl,
            token_type=str(tokens.get("tokenType") or "Bearer"),
            user_id=tokens.get("userId"),
            email_verified=tokens.get("emailVerified"),
        )
