"""File storage: buckets and objects under ``/projects/<id>/storage``.

What a key may do here depends on how much authority it carries. With the anon
key alone only ``download`` is open; a signed-in user (anon key plus the user's
token) may list, upload, remove and sign URLs; bucket management needs the
service key.
"""

from __future__ import annotations

import mimetypes
import os
from pathlib import Path
from typing import Any, BinaryIO, Dict, List, Optional, Sequence, Union
from urllib.parse import quote

from ._errors import BasefyioError
from ._http import HttpClient
from .query import BasefyioResponse
from .types import SignedUrl, StorageBucket, StorageObject

FileData = Union[bytes, bytearray, memoryview, BinaryIO, os.PathLike, str]


class StorageBucketApi:
    """Operations on the objects of one bucket: ``bf.storage.from_("avatars")``."""

    def __init__(self, http: HttpClient, project_id: str, bucket: str) -> None:
        self._http = http
        self._project_id = project_id
        self._bucket = bucket

    def _base(self) -> str:
        return f"/projects/{self._project_id}/storage/buckets/{quote(self._bucket, safe='')}"

    def list(self, prefix: str = "") -> BasefyioResponse[List[StorageObject]]:
        params = {"prefix": prefix} if prefix else None
        return _call(lambda: self._http.json("GET", f"{self._base()}/objects", params=params))

    def upload(
        self,
        path: str,
        data: FileData,
        content_type: Optional[str] = None,
    ) -> BasefyioResponse[StorageObject]:
        """Upload ``data`` (bytes, an open binary file, or a filesystem path) as ``path``.

        The content type is taken from the argument, else guessed from the file
        name, else ``application/octet-stream``. The platform caps a single
        upload at 50 MB.
        """
        filename = path.rsplit("/", 1)[-1] or "file"
        content = _as_file(data)
        mime = content_type or mimetypes.guess_type(filename)[0] or "application/octet-stream"
        files = {"file": (filename, content, mime)}
        return _call(
            lambda: self._http.json("POST", f"{self._base()}/objects", params={"path": path}, files=files)
        )

    def download(self, path: str) -> BasefyioResponse[bytes]:
        return _call(lambda: self._http.bytes("GET", f"{self._base()}/objects/download", params={"path": path}))

    def remove(self, paths: Sequence[str]) -> BasefyioResponse[Dict[str, Any]]:
        return _call(lambda: self._http.json("DELETE", f"{self._base()}/objects", json={"paths": list(paths)}))

    def create_signed_url(self, path: str, expires_in: int = 3600) -> BasefyioResponse[SignedUrl]:
        """A time-limited URL for one object; ``expires_in`` is in seconds."""
        return _call(
            lambda: self._http.json(
                "GET", f"{self._base()}/objects/url", params={"path": path, "expiry": str(int(expires_in))}
            )
        )

    def get_public_url(self, path: str) -> Optional[str]:
        """The permanent URL of an object in a public bucket, or ``None`` when
        the bucket is private. Raises :class:`BasefyioError` on an HTTP failure."""
        data = self._http.json("GET", f"{self._base()}/public-url", params={"path": path})
        if isinstance(data, dict) and data.get("public"):
            url = data.get("url")
            return str(url) if url else None
        return None

    def get_download_url(self, path: str) -> str:
        """The API download URL for an object. Fetching it needs the ``apikey``
        header (or a signed-in user), so it is for code, not for an ``<img>`` tag;
        use :meth:`get_public_url` or :meth:`create_signed_url` for those."""
        return f"{self._http.base_url}{self._base()}/objects/download?path={quote(path, safe='')}"


class StorageClient:
    """Buckets of one project: ``bf.storage``."""

    def __init__(self, http: HttpClient, project_id: str) -> None:
        self._http = http
        self._project_id = project_id

    def _base(self) -> str:
        return f"/projects/{self._project_id}/storage"

    def from_(self, bucket: str) -> StorageBucketApi:
        return StorageBucketApi(self._http, self._project_id, bucket)

    def list_buckets(self) -> BasefyioResponse[List[StorageBucket]]:
        return _call(lambda: self._http.json("GET", f"{self._base()}/buckets"))

    def create_bucket(self, name: str, public: bool = False) -> BasefyioResponse[StorageBucket]:
        return _call(lambda: self._http.json("POST", f"{self._base()}/buckets", json={"name": name, "public": public}))

    def delete_bucket(self, name: str) -> BasefyioResponse[Dict[str, Any]]:
        return _call(lambda: self._http.json("DELETE", f"{self._base()}/buckets/{quote(name, safe='')}"))

    def update_bucket(self, name: str, public: bool) -> BasefyioResponse[StorageBucket]:
        return _call(
            lambda: self._http.json("PATCH", f"{self._base()}/buckets/{quote(name, safe='')}", json={"public": public})
        )


def _as_file(data: FileData) -> Any:
    """Turn the accepted inputs into something httpx can send as a file part."""
    if isinstance(data, (bytes, bytearray, memoryview)):
        return bytes(data)
    if isinstance(data, (str, os.PathLike)):
        return Path(data).read_bytes()
    if hasattr(data, "read"):
        return data
    raise BasefyioError("upload() expects bytes, a binary file object or a filesystem path")


def _call(fn: Any) -> BasefyioResponse[Any]:
    try:
        return BasefyioResponse(data=fn(), error=None)
    except BasefyioError as err:
        return BasefyioResponse(data=None, error=err)


__all__ = ["StorageBucketApi", "StorageClient", "FileData"]
