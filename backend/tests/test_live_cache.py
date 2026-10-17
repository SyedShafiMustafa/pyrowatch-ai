from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

from app.live_cache import LiveAreaCache, LiveFetchBusy


def test_cache_expiry_eviction_and_original_fetch_time():
    now = [0]
    cache = LiveAreaCache(ttl=10, capacity=1, clock=lambda: now[0])
    loader = Mock(return_value="csv")
    first = cache.fetch("a", loader)
    assert first[2] is False
    assert cache.fetch("a", loader) == ("csv", first[1], True)
    loader.assert_called_once()
    now[0] = 10
    assert cache.fetch("a", loader)[2] is False
    cache.fetch("b", loader)
    assert list(cache.entries) == ["b"]


def test_rate_limit_failures_and_busy_requests():
    now = [0]
    cache = LiveAreaCache(requests_per_minute=1, clock=lambda: now[0])
    with pytest.raises(ValueError):
        cache.fetch("a", Mock(side_effect=ValueError("failed")))
    assert not cache.entries
    with pytest.raises(LiveFetchBusy, match="limit"):
        cache.fetch("a", lambda: "csv")
    now[0] = 60
    assert cache.fetch("a", lambda: "csv")[0] == "csv"
    assert cache.fetch("a", lambda: "unused")[2] is True
    cache.lock.acquire()
    try:
        with pytest.raises(LiveFetchBusy, match="running"):
            cache.fetch("a", lambda: "unused")
    finally:
        cache.lock.release()


def test_cached_route_still_requires_auth_and_bounds(monkeypatch):
    from app import main
    monkeypatch.setattr(main, "live_area_cache", LiveAreaCache())
    monkeypatch.setenv("PYROWATCH_LIVE_FETCH_TOKEN", "synthetic-access-token")
    monkeypatch.setenv("NASA_FIRMS_MAP_KEY", "synthetic-cache-key")
    loader = Mock(return_value="latitude,longitude,bright_ti4,acq_date,acq_time,confidence,frp\n")
    monkeypatch.setattr(main, "fetch_area_csv", loader)
    params = dict(west=10, south=20, east=30, north=40)
    auth = {"Authorization": "Bearer synthetic-access-token"}
    with TestClient(main.app) as client:
        first = client.get("/api/firms/area", params=params, headers=auth)
        second = client.get("/api/firms/area", params=params, headers=auth)
        assert first.status_code == second.status_code == 200
        assert second.json()["live_fetch"]["cached"] is True
        assert second.json()["live_fetch"]["fetched_at"] == first.json()["live_fetch"]["fetched_at"]
        assert client.get("/api/firms/area", params=params).status_code == 401
        assert client.get("/api/firms/area", params={**params, "east": 31}, headers=auth).status_code == 422
        loader.assert_called_once()
        monkeypatch.setenv("NASA_FIRMS_MAP_KEY", "synthetic-rotated-key")
        assert client.get("/api/firms/area", params=params, headers=auth).status_code == 200
        assert loader.call_count == 2


def test_large_live_result_does_not_enter_pipeline(monkeypatch):
    from app import main
    monkeypatch.setattr(main, "live_area_cache", LiveAreaCache())
    monkeypatch.setenv("PYROWATCH_LIVE_FETCH_TOKEN", "synthetic-access-token")
    monkeypatch.setattr(main, "fetch_area_csv", lambda *args: "row\n" * 5002)
    pipeline = Mock()
    monkeypatch.setattr(main, "_pipeline", pipeline)
    with TestClient(main.app) as client:
        result = client.get("/api/firms/area", params=dict(west=0, south=0, east=1, north=1),
                            headers={"Authorization": "Bearer synthetic-access-token"})
    assert result.status_code == 413
    pipeline.assert_not_called()
