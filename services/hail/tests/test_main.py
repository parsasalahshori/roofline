import threading
from datetime import datetime, timezone

import httpx

from hail import main
from hail.main import POSTMARK_URL, next_run_after, run_loop, run_once, send_alert
from hail.run import TickFailed

ENV = {"OPS_ALERT_EMAIL": "ops@example.com", "POSTMARK_SERVER_TOKEN": "tok"}


def at(day: int, hour: int, minute: int, second: int = 0) -> datetime:
    return datetime(2002, 6, day, hour, minute, second, tzinfo=timezone.utc)


def test_next_run_after_boundaries():
    assert next_run_after(at(5, 10, 0)) == at(5, 10, 5)
    assert next_run_after(at(5, 10, 5)) == at(5, 10, 35)
    assert next_run_after(at(5, 10, 34, 59)) == at(5, 10, 35)
    assert next_run_after(at(5, 10, 35)) == at(5, 11, 5)
    assert next_run_after(at(5, 23, 40)) == at(6, 0, 5)


def make_client(status: int = 200):
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(status, json={})

    return httpx.Client(transport=httpx.MockTransport(handler)), seen


def test_send_alert_posts_to_postmark():
    client, seen = make_client()
    send_alert(client, "tok", "ops@example.com", 3)
    assert len(seen) == 1
    assert seen[0].method == "POST"
    assert str(seen[0].url) == POSTMARK_URL
    assert seen[0].headers["x-postmark-server-token"] == "tok"
    assert b'"To":"ops@example.com"' in seen[0].content.replace(b" ", b"")


def failing_tick(counts):
    calls = []

    def fake(source, conn_factory, now):
        calls.append(1)
        raise TickFailed(counts[len(calls) - 1])

    return fake


def test_alert_sent_once_at_third_consecutive_failure(monkeypatch):
    monkeypatch.setattr(main, "tick", failing_tick([1, 2, 3, 4]))
    client, seen = make_client()
    flag = False
    sent_after = []
    for _ in range(4):
        flag = run_once(None, None, client, ENV, flag)
        sent_after.append(len(seen))
    assert sent_after == [0, 0, 1, 1]
    assert flag is True


def test_success_resets_alert_flag(monkeypatch):
    monkeypatch.setattr(main, "tick", lambda source, conn_factory, now: None)
    client, seen = make_client()
    assert run_once(None, None, client, ENV, True) is False
    assert seen == []


def test_alert_failure_does_not_raise(monkeypatch):
    monkeypatch.setattr(main, "tick", failing_tick([3]))
    client, seen = make_client(500)
    flag = run_once(None, None, client, ENV, False)
    assert flag is False
    assert len(seen) == 1


def test_alert_retried_after_postmark_failure(monkeypatch):
    monkeypatch.setattr(main, "tick", failing_tick([3, 4]))
    bad, bad_seen = make_client(500)
    good, good_seen = make_client(200)
    assert run_once(None, None, bad, ENV, False) is False
    assert run_once(None, None, good, ENV, False) is True
    assert len(bad_seen) == 1 and len(good_seen) == 1


def test_alert_skipped_when_unconfigured(monkeypatch):
    monkeypatch.setattr(main, "tick", failing_tick([3]))
    client, seen = make_client()
    env = {"OPS_ALERT_EMAIL": "", "POSTMARK_SERVER_TOKEN": ""}
    assert run_once(None, None, client, env, False) is False
    assert seen == []


def test_run_loop_exits_when_stop_set():
    stop = threading.Event()
    stop.set()
    run_loop(None, None, None, ENV, stop)
