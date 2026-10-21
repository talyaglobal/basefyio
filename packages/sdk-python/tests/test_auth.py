import httpx

TOKENS = {
    "accessToken": "tok-1",
    "refreshToken": "ref-1",
    "expiresIn": 300,
    "tokenType": "Bearer",
    "userId": "u-1",
    "emailVerified": True,
}


def test_sign_up_body_uses_api_field_names(client, recorder):
    recorder.queue(json_body=TOKENS)
    resp = client.auth.sign_up("a@example.com", "pw", first_name="Ada", last_name="L")
    assert recorder.last.method == "POST"
    assert recorder.last.url.path == "/api/rest/v1/auth/signup"
    assert recorder.body() == {"email": "a@example.com", "password": "pw", "firstName": "Ada", "lastName": "L"}
    assert "authorization" not in recorder.last.headers
    assert resp.data == TOKENS
    assert client.auth.get_access_token() == "tok-1"


def test_sign_up_omits_absent_names(client, recorder):
    recorder.queue(json_body=TOKENS)
    client.auth.sign_up("a@example.com", "pw")
    assert recorder.body() == {"email": "a@example.com", "password": "pw"}


def test_sign_in_stores_session_and_following_requests_carry_bearer(client, recorder):
    recorder.queue(json_body=TOKENS)
    resp = client.auth.sign_in("a@example.com", "pw")
    assert recorder.last.url.path == "/api/rest/v1/auth/signin"
    assert recorder.body() == {"email": "a@example.com", "password": "pw"}
    assert resp.error is None
    session = client.auth.get_session()
    assert session is not None and session.user_id == "u-1" and session.email_verified is True

    client.from_("todos").select().execute()
    assert recorder.last.headers["authorization"] == "Bearer tok-1"
    assert recorder.last.headers["apikey"] == "anon-key"


def test_sign_in_failure_leaves_no_session(client, recorder):
    recorder.queue(401, json_body={"statusCode": 401, "message": "Invalid credentials"})
    resp = client.auth.sign_in("a@example.com", "bad")
    assert resp.data is None
    assert resp.error.status == 401
    assert client.auth.get_session() is None


def test_sign_out_clears_locally_without_a_request(client, recorder):
    recorder.queue(json_body=TOKENS)
    client.auth.sign_in("a@example.com", "pw")
    client.auth.sign_out()
    assert len(recorder.requests) == 1
    assert client.auth.get_session() is None
    client.from_("t").select().execute()
    assert "authorization" not in recorder.last.headers


def test_get_user_without_session_makes_no_request(client, recorder):
    resp = client.auth.get_user()
    assert resp.data is None
    assert resp.error is not None
    assert recorder.requests == []


def test_get_user_calls_me_with_bearer(client, recorder):
    recorder.queue(json_body=TOKENS)
    client.auth.sign_in("a@example.com", "pw")
    recorder.queue(json_body={"sub": "u-1", "email": "a@example.com", "preferred_username": "a"})
    resp = client.auth.get_user()
    assert recorder.last.method == "GET"
    assert recorder.last.url.path == "/api/rest/v1/auth/me"
    assert recorder.last.headers["authorization"] == "Bearer tok-1"
    assert resp.data["sub"] == "u-1"
    assert client.auth.get_session().user["email"] == "a@example.com"


def test_refresh_posts_refresh_token_and_replaces_session(client, recorder):
    recorder.queue(json_body=TOKENS)
    client.auth.sign_in("a@example.com", "pw")
    recorder.queue(json_body={**TOKENS, "accessToken": "tok-2", "refreshToken": "ref-2"})
    resp = client.auth.refresh()
    assert recorder.last.url.path == "/api/rest/v1/auth/refresh"
    assert recorder.body() == {"refreshToken": "ref-1"}
    assert "authorization" not in recorder.last.headers
    assert resp.data["accessToken"] == "tok-2"
    assert client.auth.get_access_token() == "tok-2"
    assert client.auth.get_session().refresh_token == "ref-2"


def test_refresh_rejection_clears_session_but_transport_error_keeps_it(client, recorder):
    recorder.queue(json_body=TOKENS)
    client.auth.sign_in("a@example.com", "pw")

    recorder.fail_next(httpx.ConnectError("offline"))
    resp = client.auth.refresh()
    assert resp.error is not None and resp.error.status is None
    assert client.auth.get_session() is not None

    recorder.queue(401, json_body={"statusCode": 401, "message": "Token is not active"})
    resp = client.auth.refresh()
    assert resp.error.status == 401
    assert client.auth.get_session() is None


def test_refresh_without_session(client, recorder):
    resp = client.auth.refresh()
    assert resp.error is not None
    assert recorder.requests == []


def test_auto_refresh_runs_before_a_request_when_the_token_is_about_to_expire(client, recorder):
    now = {"t": 1000.0}
    client.auth._clock = lambda: now["t"]
    recorder.queue(json_body={**TOKENS, "expiresIn": 100})
    client.auth.sign_in("a@example.com", "pw")  # expires at 1100

    now["t"] = 1050.0
    recorder.queue(json_body={"data": [], "count": 0})
    client.from_("t").select().execute()
    assert [r.url.path for r in recorder.requests] == ["/api/rest/v1/auth/signin", "/api/rest/v1/t"]

    now["t"] = 1075.0  # within 30 s of expiry
    recorder.queue(json_body={**TOKENS, "accessToken": "tok-2", "refreshToken": "ref-2", "expiresIn": 100})
    recorder.queue(json_body={"data": [], "count": 0})
    client.from_("t").select().execute()
    assert [r.url.path for r in recorder.requests[-2:]] == ["/api/rest/v1/auth/refresh", "/api/rest/v1/t"]
    assert recorder.last.headers["authorization"] == "Bearer tok-2"


def test_auto_refresh_can_be_disabled(recorder):
    import basefyio

    bf = basefyio.create_client(
        url="https://api.example.com", key="k", auto_refresh=False, transport=httpx.MockTransport(recorder.handler)
    )
    now = {"t": 1000.0}
    bf.auth._clock = lambda: now["t"]
    recorder.queue(json_body={**TOKENS, "expiresIn": 10})
    bf.auth.sign_in("a@example.com", "pw")
    now["t"] = 1009.0
    recorder.queue(json_body={"data": [], "count": 0})
    bf.from_("t").select().execute()
    assert [r.url.path for r in recorder.requests] == ["/api/rest/v1/auth/signin", "/api/rest/v1/t"]
    assert recorder.last.headers["authorization"] == "Bearer tok-1"


def test_set_access_token_attaches_bearer_without_sign_in(client, recorder):
    client.auth.set_access_token("external-token")
    client.from_("t").select().execute()
    assert recorder.last.headers["authorization"] == "Bearer external-token"
    assert len(recorder.requests) == 1  # no refresh attempted: no refresh token, no expiry
