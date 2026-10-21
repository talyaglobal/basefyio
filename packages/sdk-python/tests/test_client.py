import httpx
import pytest

import basefyio
from basefyio import BasefyioError


def make(recorder, **kwargs):
    kwargs.setdefault("transport", httpx.MockTransport(recorder.handler))
    return basefyio.create_client(**kwargs)


def test_api_suffix_is_added_once(recorder):
    assert make(recorder, url="https://x.com", key="k").api_url == "https://x.com/api"
    assert make(recorder, url="https://x.com/", key="k").api_url == "https://x.com/api"
    assert make(recorder, url="https://x.com/api/", key="k").api_url == "https://x.com/api"
    assert make(recorder, url="https://x.com/api", key="k").api_url == "https://x.com/api"


def test_default_url(recorder):
    assert make(recorder, key="k").api_url == "https://api.basefyio.com/api"


def test_env_fallbacks(recorder, monkeypatch):
    monkeypatch.setenv("BASEFYIO_API_URL", "https://env.example.com")
    monkeypatch.setenv("BASEFYIO_ANON_KEY", "env-key")
    monkeypatch.setenv("BASEFYIO_PROJECT_ID", "env-project")
    bf = make(recorder)
    assert bf.api_url == "https://env.example.com/api"
    assert bf.project_id == "env-project"
    bf.from_("t").select().execute()
    assert recorder.last.headers["apikey"] == "env-key"


def test_explicit_arguments_beat_env(recorder, monkeypatch):
    monkeypatch.setenv("BASEFYIO_ANON_KEY", "env-key")
    monkeypatch.setenv("BASEFYIO_PROJECT_ID", "env-project")
    bf = make(recorder, key="arg-key", project_id="arg-project")
    assert bf.project_id == "arg-project"
    bf.from_("t").select().execute()
    assert recorder.last.headers["apikey"] == "arg-key"


def test_missing_key_raises(recorder, monkeypatch):
    monkeypatch.delenv("BASEFYIO_ANON_KEY", raising=False)
    with pytest.raises(BasefyioError) as exc:
        make(recorder, url="https://x.com")
    assert "BASEFYIO_ANON_KEY" in str(exc.value)


def test_storage_requires_project_id(recorder, monkeypatch):
    monkeypatch.delenv("BASEFYIO_PROJECT_ID", raising=False)
    bf = make(recorder, key="k")
    with pytest.raises(BasefyioError) as exc:
        bf.storage
    assert "project_id" in str(exc.value)
    assert recorder.requests == []


def test_sql_requires_project_id(recorder, monkeypatch):
    monkeypatch.delenv("BASEFYIO_PROJECT_ID", raising=False)
    bf = make(recorder, key="k")
    with pytest.raises(BasefyioError):
        bf.sql("select 1")


def test_apikey_header_on_every_request_and_no_bearer_before_sign_in(client, recorder):
    client.from_("todos").select().execute()
    client.rpc("fn")
    client.storage.from_("b").download("x")
    assert len(recorder.requests) == 3
    for req in recorder.requests:
        assert req.headers["apikey"] == "anon-key"
        assert "authorization" not in req.headers


def test_custom_headers_are_merged_and_key_is_not_mirrored(recorder):
    bf = make(recorder, key="k", headers={"X-Client": "tests"})
    bf.from_("t").select().execute()
    assert recorder.last.headers["x-client"] == "tests"
    assert recorder.last.headers["apikey"] == "k"
    assert "authorization" not in recorder.last.headers


def test_json_requests_declare_content_type(client, recorder):
    client.from_("t").insert({"a": 1}).execute()
    assert recorder.last.headers["content-type"] == "application/json"


def test_context_manager_closes(recorder):
    with make(recorder, key="k") as bf:
        assert bf.api_url.endswith("/api")


def test_transport_error_becomes_error_response(client, recorder):
    recorder.fail_next(httpx.ConnectError("boom"))
    resp = client.from_("t").select().execute()
    assert resp.data is None
    assert resp.error is not None
    assert resp.error.status is None
    assert "boom" in resp.error.message


def test_version_is_exposed():
    assert basefyio.__version__ == "0.1.0"
