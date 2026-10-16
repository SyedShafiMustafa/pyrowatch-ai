from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_dashboard_origins_can_read_health_and_sample():
    for origin in ("http://127.0.0.1:5500", "http://localhost:5500"):
        health = client.get("/api/health", headers={"Origin": origin})
        assert health.status_code == 200
        assert health.json() == {"ok": True}
        assert health.headers["access-control-allow-origin"] == origin

        sample = client.get("/api/sample", headers={"Origin": origin})
        assert sample.status_code == 200
        assert sample.headers["access-control-allow-origin"] == origin


def test_upload_preflight_allows_required_origin_method_and_header():
    response = client.options(
        "/api/upload",
        headers={
            "Origin": "http://127.0.0.1:5500",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
    )
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://127.0.0.1:5500"
    assert "POST" in response.headers["access-control-allow-methods"]
    assert "content-type" in response.headers["access-control-allow-headers"].lower()


def test_unapproved_origin_is_not_granted_cors_access():
    response = client.get("/api/health", headers={"Origin": "https://example.invalid"})
    assert response.status_code == 200
    assert "access-control-allow-origin" not in response.headers


def test_upload_response_allows_dashboard_origin_and_preserves_unverified_provenance():
    csv_text = (
        "latitude,longitude,bright_ti4,acq_date,acq_time,satellite,confidence,frp,daynight\n"
        "10,20,340,2026-10-10,0230,N20,h,5,D\n"
    )
    response = client.post(
        "/api/upload",
        files={"file": ("synthetic.csv", csv_text, "text/csv")},
        headers={"Origin": "http://127.0.0.1:5500"},
    )
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://127.0.0.1:5500"
    assert response.json()["ingestion"]["data_kind"] == "user_supplied_unverified"