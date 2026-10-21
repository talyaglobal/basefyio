"""Shared fixtures: a client whose transport records every request and replays
canned responses, so each test asserts the exact HTTP the client sends."""

from __future__ import annotations

import json
from typing import Any, List, Optional, Union

import httpx
import pytest

import basefyio

Queued = Union[httpx.Response, Exception]


class Recorder:
    def __init__(self) -> None:
        self.requests: List[httpx.Request] = []
        self._queue: List[Queued] = []

    def queue(
        self,
        status: int = 200,
        json_body: Any = None,
        content: Optional[bytes] = None,
        headers: Optional[dict] = None,
    ) -> None:
        if json_body is not None:
            self._queue.append(httpx.Response(status, json=json_body, headers=headers))
        else:
            self._queue.append(httpx.Response(status, content=content or b"", headers=headers))

    def fail_next(self, exc: Exception) -> None:
        self._queue.append(exc)

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self._queue:
            item = self._queue.pop(0)
            if isinstance(item, Exception):
                raise item
            return item
        return httpx.Response(200, json={})

    @property
    def last(self) -> httpx.Request:
        return self.requests[-1]

    def body(self, index: int = -1) -> Any:
        return json.loads(self.requests[index].content)

    def params(self, index: int = -1) -> list:
        return list(self.requests[index].url.params.multi_items())


@pytest.fixture
def recorder() -> Recorder:
    return Recorder()


@pytest.fixture
def client(recorder: Recorder):
    bf = basefyio.create_client(
        url="https://api.example.com",
        key="anon-key",
        project_id="proj-1",
        transport=httpx.MockTransport(recorder.handler),
    )
    yield bf
    bf.close()
