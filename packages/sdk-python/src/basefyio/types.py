"""Shapes of what the API returns, as TypedDicts.

These mirror the JSON the platform sends; keys keep the API's camelCase so a
response can be compared with the HTTP documentation field for field.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, TypedDict


class AuthTokens(TypedDict, total=False):
    accessToken: str
    refreshToken: str
    expiresIn: int
    tokenType: str
    userId: Optional[str]
    emailVerified: Optional[bool]


class User(TypedDict, total=False):
    sub: str
    email: str
    preferred_username: str
    email_verified: bool


class StorageBucket(TypedDict, total=False):
    id: str
    name: str
    public: bool
    createdAt: str
    objectCount: int
    totalSize: int


class StorageObject(TypedDict, total=False):
    name: str
    prefix: Optional[str]
    size: int
    contentType: Optional[str]
    lastModified: str
    etag: Optional[str]


class SignedUrl(TypedDict):
    url: str
    expiresIn: int


class PublicUrl(TypedDict):
    public: bool
    url: Optional[str]


class SqlResult(TypedDict, total=False):
    rows: List[Dict[str, Any]]
    rowCount: int
