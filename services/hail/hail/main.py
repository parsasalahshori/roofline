"""Hail worker: ticks at :05 and :35 each hour and emails ops after repeated failures."""

import logging
import os
import signal
import tempfile
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
import psycopg

from hail.run import TickFailed, tick
from hail.source import MeshSource

ALERT_THRESHOLD = 3
POSTMARK_URL = "https://api.postmarkapp.com/email"

log = logging.getLogger(__name__)


def next_run_after(now: datetime) -> datetime:
    """Next instant strictly after now at minute 5 or 35, second 0, in UTC."""
    now = now.replace(tzinfo=timezone.utc) if now.tzinfo is None else now.astimezone(timezone.utc)
    base = now.replace(minute=0, second=0, microsecond=0)
    for offset in (5, 35, 65):
        candidate = base + timedelta(minutes=offset)
        if candidate > now:
            return candidate
    return base + timedelta(minutes=65)


def postmark_token(environ) -> str:
    """POSTMARK_TOKEN, falling back to the deprecated POSTMARK_SERVER_TOKEN."""
    token = environ.get("POSTMARK_TOKEN", "")
    if token:
        return token
    old = environ.get("POSTMARK_SERVER_TOKEN", "")
    if old:
        log.warning("POSTMARK_SERVER_TOKEN is deprecated; use POSTMARK_TOKEN")
    return old


def send_alert(client: httpx.Client, token: str, to: str, count: int) -> None:
    response = client.post(
        POSTMARK_URL,
        headers={"X-Postmark-Server-Token": token, "Accept": "application/json"},
        json={
            "From": to,
            "To": to,
            "Subject": "Hail service: " + str(count) + " failed runs in a row",
            "TextBody": "The hail worker failed " + str(count) + " times in a row. Check the Render logs.",
            "MessageStream": "outbound",
        },
    )
    response.raise_for_status()


def run_once(source, conn_factory, client, env, failures_alerted: bool, state: dict | None = None) -> bool:
    if state is None:
        state = {"failures": 0}
    try:
        tick(source, conn_factory, datetime.now(timezone.utc))
    except TickFailed as err:
        state["failures"] = max(state.get("failures", 0) + 1, err.count)
    except Exception:
        log.exception("hail worker error")
        state["failures"] = state.get("failures", 0) + 1
    else:
        state["failures"] = 0
        return False
    count = state["failures"]
    if count < ALERT_THRESHOLD:
        return False
    if failures_alerted:
        return True
    to = env.get("OPS_ALERT_EMAIL")
    token = env.get("POSTMARK_TOKEN")
    if not (to and token):
        log.warning("hail alert threshold reached but OPS_ALERT_EMAIL or POSTMARK_TOKEN is not set")
        return False
    try:
        send_alert(client, token, to, count)
    except httpx.HTTPError:
        log.exception("hail alert email failed")
        return False
    return True


def run_loop(
    source, conn_factory, client, env: dict, stop: threading.Event, clock=lambda: datetime.now(timezone.utc)
) -> None:
    failures_alerted = False
    state = {"failures": 0}
    while not stop.is_set():
        nxt = next_run_after(clock())
        wait = max(0, (nxt - clock()).total_seconds())
        if stop.wait(wait):
            break
        failures_alerted = run_once(source, conn_factory, client, env, failures_alerted, state=state)


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    url = os.environ.get("HAIL_DATABASE_URL")
    if not url:
        raise SystemExit("HAIL_DATABASE_URL is required")
    env = {
        "OPS_ALERT_EMAIL": os.environ.get("OPS_ALERT_EMAIL", ""),
        "POSTMARK_TOKEN": postmark_token(os.environ),
    }

    def conn_factory():
        return psycopg.connect(url)

    client = httpx.Client(timeout=30)
    source = MeshSource(client, Path(tempfile.gettempdir()) / "hail")
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    try:
        run_loop(source, conn_factory, client, env, stop)
    finally:
        client.close()


if __name__ == "__main__":
    main()
