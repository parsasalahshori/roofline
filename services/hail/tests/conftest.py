"""Shared fixtures.

Task 2 has no database tests and nothing in it may request owner_dsn or hail_dsn. The app_hail role is created by
Task 1's migration; these lazy fixtures exist for later tasks (Task 3). psycopg is imported inside the fixture so test
collection never needs the database or the role.
"""

import os
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

import pytest


@pytest.fixture(scope="session")
def fixtures_dir() -> Path:
    return Path(__file__).parent / "fixtures"


@pytest.fixture(scope="session")
def owner_dsn() -> str:
    dsn = os.environ.get("HAIL_TEST_DATABASE_URL")
    if not dsn:
        pytest.skip("HAIL_TEST_DATABASE_URL not set")
    return dsn


@pytest.fixture(scope="session")
def hail_dsn(owner_dsn: str) -> str:
    import psycopg

    with psycopg.connect(owner_dsn, autocommit=True) as conn:
        conn.execute("ALTER ROLE app_hail LOGIN PASSWORD 'test'")
    parts = urlsplit(owner_dsn)
    port = f":{parts.port}" if parts.port else ""
    return urlunsplit(parts._replace(netloc=f"app_hail:test@{parts.hostname}{port}"))
