import io

BASE = "/api/projects/proj-1/storage"


def test_upload_sends_multipart_file_part(client, recorder):
    recorder.queue(json_body={"name": "a/b.png", "size": 3, "contentType": "image/png"})
    resp = client.storage.from_("avatars").upload("a/b.png", b"\x89PN")
    req = recorder.last
    assert req.method == "POST"
    assert req.url.path == f"{BASE}/buckets/avatars/objects"
    assert recorder.params() == [("path", "a/b.png")]
    assert req.headers["content-type"].startswith("multipart/form-data")
    assert req.headers["apikey"] == "anon-key"
    assert b'name="file"; filename="b.png"' in req.content
    assert b"Content-Type: image/png" in req.content
    assert b"\x89PN" in req.content
    assert resp.data["name"] == "a/b.png"


def test_upload_accepts_explicit_content_type_file_objects_and_paths(client, recorder, tmp_path):
    client.storage.from_("docs").upload("notes.bin", io.BytesIO(b"abc"), content_type="application/x-notes")
    assert b"Content-Type: application/x-notes" in recorder.last.content
    assert b"abc" in recorder.last.content

    file_path = tmp_path / "report.txt"
    file_path.write_text("hello")
    client.storage.from_("docs").upload("reports/report.txt", file_path)
    assert b'filename="report.txt"' in recorder.last.content
    assert b"Content-Type: text/plain" in recorder.last.content
    assert b"hello" in recorder.last.content


def test_upload_falls_back_to_octet_stream(client, recorder):
    client.storage.from_("docs").upload("blob.unknownext", b"x")
    assert b"Content-Type: application/octet-stream" in recorder.last.content


def test_download_returns_bytes(client, recorder):
    recorder.queue(content=b"binary", headers={"content-type": "application/octet-stream"})
    resp = client.storage.from_("avatars").download("a/b.png")
    assert recorder.last.method == "GET"
    assert recorder.last.url.path == f"{BASE}/buckets/avatars/objects/download"
    assert recorder.params() == [("path", "a/b.png")]
    assert resp.data == b"binary"


def test_list_with_and_without_prefix(client, recorder):
    recorder.queue(json_body=[{"name": "a.png", "size": 1}])
    resp = client.storage.from_("avatars").list("a/")
    assert recorder.last.url.path == f"{BASE}/buckets/avatars/objects"
    assert recorder.params() == [("prefix", "a/")]
    assert resp.data == [{"name": "a.png", "size": 1}]

    client.storage.from_("avatars").list()
    assert recorder.params() == []


def test_remove_sends_delete_with_json_paths(client, recorder):
    recorder.queue(json_body={"message": "deleted"})
    resp = client.storage.from_("avatars").remove(["a.png", "b.png"])
    assert recorder.last.method == "DELETE"
    assert recorder.last.url.path == f"{BASE}/buckets/avatars/objects"
    assert recorder.body() == {"paths": ["a.png", "b.png"]}
    assert resp.data == {"message": "deleted"}


def test_create_signed_url(client, recorder):
    recorder.queue(json_body={"url": "https://signed", "expiresIn": 600})
    resp = client.storage.from_("avatars").create_signed_url("a.png", expires_in=600)
    assert recorder.last.url.path == f"{BASE}/buckets/avatars/objects/url"
    assert recorder.params() == [("path", "a.png"), ("expiry", "600")]
    assert resp.data == {"url": "https://signed", "expiresIn": 600}


def test_get_public_url_for_public_and_private_buckets(client, recorder):
    recorder.queue(json_body={"public": True, "url": "https://files.example.com/avatars/a.png"})
    assert client.storage.from_("avatars").get_public_url("a.png") == "https://files.example.com/avatars/a.png"
    assert recorder.last.url.path == f"{BASE}/buckets/avatars/public-url"
    assert recorder.params() == [("path", "a.png")]

    recorder.queue(json_body={"public": False, "url": None})
    assert client.storage.from_("private").get_public_url("a.png") is None


def test_get_download_url_is_built_locally(client, recorder):
    url = client.storage.from_("my bucket").get_download_url("dir/a b.png")
    assert url == "https://api.example.com/api/projects/proj-1/storage/buckets/my%20bucket/objects/download?path=dir%2Fa%20b.png"
    assert recorder.requests == []


def test_bucket_management(client, recorder):
    recorder.queue(json_body=[{"name": "avatars", "public": True}])
    assert client.storage.list_buckets().data == [{"name": "avatars", "public": True}]
    assert recorder.last.url.path == f"{BASE}/buckets"

    recorder.queue(json_body={"name": "docs", "public": False})
    client.storage.create_bucket("docs")
    assert recorder.last.method == "POST"
    assert recorder.body() == {"name": "docs", "public": False}

    recorder.queue(json_body={"name": "docs", "public": True})
    client.storage.update_bucket("docs", public=True)
    assert recorder.last.method == "PATCH"
    assert recorder.last.url.path == f"{BASE}/buckets/docs"
    assert recorder.body() == {"public": True}

    recorder.queue(json_body={"message": "deleted"})
    client.storage.delete_bucket("docs")
    assert recorder.last.method == "DELETE"
    assert recorder.last.url.path == f"{BASE}/buckets/docs"


def test_unauthorized_maps_to_error_status(client, recorder):
    recorder.queue(401, json_body={"statusCode": 401, "message": "Valid JWT or API key required"})
    resp = client.storage.from_("avatars").list()
    assert resp.data is None
    assert resp.error.status == 401
    assert resp.error.message == "Valid JWT or API key required"
