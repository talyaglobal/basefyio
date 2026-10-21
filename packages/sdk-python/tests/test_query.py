from datetime import datetime, timezone

import pytest

from basefyio import BasefyioError
from basefyio.query import format_list_item


def test_select_filters_order_and_paging_render_in_order(client, recorder):
    qb = (
        client.from_("todos")
        .select("id,name")
        .eq("status", "active")
        .order("created_at", desc=True)
        .limit(10)
        .offset(20)
    )
    assert qb.to_params() == [
        ("select", "id,name"),
        ("status", "eq.active"),
        ("order", "created_at.desc"),
        ("limit", "10"),
        ("offset", "20"),
    ]
    recorder.queue(json_body={"data": [{"id": 1, "name": "a"}], "count": 42})
    resp = qb.execute()
    assert recorder.last.method == "GET"
    assert recorder.last.url.path == "/api/rest/v1/todos"
    assert recorder.params() == qb.to_params()
    assert resp.data == [{"id": 1, "name": "a"}]
    assert resp.count == 42
    assert resp.error is None
    assert resp.ok


def test_default_select_is_star(client):
    assert client.from_("t").select().to_params() == [("select", "*")]


def test_range_maps_to_offset_and_limit(client):
    params = dict(client.from_("t").select().range(10, 19).to_params())
    assert params["offset"] == "10"
    assert params["limit"] == "10"
    with pytest.raises(ValueError):
        client.from_("t").select().range(5, 2)


def test_in_quotes_items_the_server_would_split_or_strip(client):
    params = dict(client.from_("t").select().in_("id", [1, "a,b", "x y", "O'Brien"]).to_params())
    assert params["id"] == 'in.(1,"a,b","x y","O\'Brien")'
    assert format_list_item('say "hi"') == "'say \"hi\"'"
    with pytest.raises(ValueError):
        format_list_item("both ' and \"")


def test_in_with_empty_list(client):
    assert dict(client.from_("t").select().in_("id", []).to_params())["id"] == "in.()"


def test_is_operator(client):
    qb = client.from_("t").select().is_("a", None).is_("b", True).is_("c", False).is_("d", "unknown")
    assert qb.to_params()[1:] == [("a", "is.null"), ("b", "is.true"), ("c", "is.false"), ("d", "is.unknown")]
    with pytest.raises(ValueError):
        client.from_("t").select().is_("a", 5)


def test_not_or_and_groups(client):
    qb = client.from_("t").select().not_("x", "eq", 1).or_("a.eq.1,b.eq.2").and_("(c.gt.3,d.lt.4)")
    assert qb.to_params()[1:] == [
        ("x", "not.eq.1"),
        ("or", "(a.eq.1,b.eq.2)"),
        ("and", "(c.gt.3,d.lt.4)"),
    ]


def test_two_filters_on_one_column_repeat_the_key(client, recorder):
    client.from_("t").select().gte("age", 18).lt("age", 65).execute()
    assert recorder.params() == [("select", "*"), ("age", "gte.18"), ("age", "lt.65")]


def test_like_passes_wildcards_through(client):
    params = client.from_("t").select().like("name", "*foo*").ilike("name", "%bar%").to_params()
    assert params[1:] == [("name", "like.*foo*"), ("name", "ilike.%bar%")]


def test_value_formatting(client):
    when = datetime(2026, 10, 20, 15, 0, tzinfo=timezone.utc)
    params = client.from_("t").select().gt("at", when).eq("flag", True).eq("gone", None).eq("n", 2.5).to_params()
    assert params[1:] == [
        ("at", "gt.2026-10-20T15:00:00+00:00"),
        ("flag", "eq.true"),
        ("gone", "eq.null"),
        ("n", "eq.2.5"),
    ]


def test_unknown_operator_is_rejected(client):
    with pytest.raises(ValueError):
        client.from_("t").select().filter("a", "bogus", 1)


def test_text_search(client):
    params = client.from_("t").select().text_search("body", "cat & dog", type="wfts", config="english").to_params()
    assert params[1] == ("body", "wfts(english).cat & dog")


def test_order_modifiers(client):
    params = dict(client.from_("t").select().order("a").order("b", desc=True, nullsfirst=True).order("c", nullsfirst=False).to_params())
    assert params["order"] == "a.asc,b.desc.nullsfirst,c.asc.nullslast"


def test_single_returns_first_row_or_none(client, recorder):
    recorder.queue(json_body={"data": [{"id": 7}, {"id": 8}], "count": 2})
    resp = client.from_("t").select().eq("id", 7).single().execute()
    assert dict(recorder.params())["limit"] == "1"
    assert resp.data == {"id": 7}

    recorder.queue(json_body={"data": [], "count": 0})
    resp = client.from_("t").select().eq("id", 99).maybe_single().execute()
    assert resp.data is None
    assert resp.error is None


def test_insert_sends_representation_prefer_and_returns_rows(client, recorder):
    recorder.queue(json_body=[{"id": 1, "title": "a"}, {"id": 2, "title": "b"}])
    resp = client.from_("todos").insert([{"title": "a"}, {"title": "b"}]).execute()
    assert recorder.last.method == "POST"
    assert recorder.last.url.path == "/api/rest/v1/todos"
    assert recorder.params() == []
    assert recorder.last.headers["prefer"] == "return=representation"
    assert recorder.body() == [{"title": "a"}, {"title": "b"}]
    assert resp.data == [{"id": 1, "title": "a"}, {"id": 2, "title": "b"}]


def test_insert_single_dict_body(client, recorder):
    recorder.queue(json_body=[{"id": 1}])
    client.from_("todos").insert({"title": "a"}).execute()
    assert recorder.body() == {"title": "a"}


def test_insert_minimal_maps_count(client, recorder):
    recorder.queue(json_body={"count": 2})
    resp = client.from_("todos").insert([{"title": "a"}, {"title": "b"}], returning="minimal").execute()
    assert "prefer" not in recorder.last.headers
    assert resp.data is None
    assert resp.count == 2
    assert resp.error is None


def test_update_is_patch_with_filters_in_url(client, recorder):
    recorder.queue(json_body=[{"id": 7, "done": True}])
    resp = client.from_("todos").update({"done": True}).eq("id", 7).execute()
    assert recorder.last.method == "PATCH"
    assert recorder.params() == [("id", "eq.7")]
    assert recorder.body() == {"done": True}
    assert resp.data == [{"id": 7, "done": True}]


def test_delete_with_filters(client, recorder):
    recorder.queue(json_body=[{"id": 7}])
    resp = client.from_("todos").delete().eq("id", 7).execute()
    assert recorder.last.method == "DELETE"
    assert recorder.params() == [("id", "eq.7")]
    assert resp.data == [{"id": 7}]


def test_server_400_is_surfaced_as_error(client, recorder):
    recorder.queue(400, json_body={"statusCode": 400, "message": "Update needs a filter", "code": "PGRST100"})
    resp = client.from_("todos").update({"done": True}).execute()
    assert resp.data is None
    assert resp.error is not None
    assert resp.error.status == 400
    assert resp.error.code == "PGRST100"
    assert resp.error.message == "Update needs a filter"
    with pytest.raises(BasefyioError):
        resp.raise_for_error()


def test_validation_message_lists_are_joined(client, recorder):
    recorder.queue(400, json_body={"statusCode": 400, "message": ["a is required", "b is required"], "error": "Bad Request"})
    resp = client.from_("t").select().execute()
    assert resp.error.message == "a is required; b is required"


def test_rpc_posts_args_and_returns_rows(client, recorder):
    recorder.queue(json_body=[{"greeting": "hello world"}])
    rows = client.rpc("hello", {"name": "world"})
    assert recorder.last.method == "POST"
    assert recorder.last.url.path == "/api/rest/v1/rpc/hello"
    assert recorder.body() == {"name": "world"}
    assert rows == [{"greeting": "hello world"}]


def test_rpc_without_args_sends_empty_object_and_raises_on_failure(client, recorder):
    recorder.queue(json_body=[])
    assert client.rpc("fn") == []
    assert recorder.body() == {}
    recorder.queue(400, json_body={"statusCode": 400, "message": 'Function "nope" not found'})
    with pytest.raises(BasefyioError) as exc:
        client.rpc("nope")
    assert exc.value.status == 400


def test_sql_binds_params_and_omits_them_when_empty(client, recorder):
    recorder.queue(json_body={"rows": [{"n": 1}], "rowCount": 1})
    resp = client.sql("select $1::int as n", [1])
    assert recorder.last.url.path == "/api/sql/execute"
    assert recorder.body() == {"projectId": "proj-1", "query": "select $1::int as n", "params": [1]}
    assert resp.data == [{"n": 1}]

    recorder.queue(json_body={"rows": [], "rowCount": 0})
    client.sql("select 1")
    assert recorder.body() == {"projectId": "proj-1", "query": "select 1"}


def test_table_name_is_url_encoded(client, recorder):
    client.from_("odd/name").select().execute()
    assert recorder.last.url.raw_path.startswith(b"/api/rest/v1/odd%2Fname")
