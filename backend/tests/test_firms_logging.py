"""Offline regression checks: credentials and network connections are synthetic."""
import io
import logging
import traceback
from unittest.mock import Mock

import pytest
import requests
from urllib3.connection import HTTPConnection
from urllib3.connectionpool import HTTPConnectionPool
from urllib3.util.retry import Retry

from app import firms_client

CSV = 'latitude,longitude,bright_ti4,acq_date,acq_time,confidence,frp\n'


@pytest.mark.parametrize('outcome', ['success', 'status', 'transport'])
def test_http_logs_redact_success_retry_and_errors(monkeypatch, caplog, outcome):
    key = 'SYNTHETIC_SENTINEL_CREDENTIAL'
    monkeypatch.setenv('MAP_KEY', key)
    caplog.set_level(logging.DEBUG)
    local_output = io.StringIO()
    emitter = logging.getLogger('urllib3.connectionpool')
    handler = logging.StreamHandler(local_output)
    emitter.addHandler(handler)

    def fake_get(url, **kwargs):
        # Actual urllib3 success logging, with no socket or live network.
        conn = Mock(spec=HTTPConnection)
        conn.is_closed = False
        conn.is_connected = True
        conn.getresponse.return_value = Mock(
            version_string='HTTP/1.1', status=200, length_remaining=0)
        pool = HTTPConnectionPool('example.invalid')
        pool._make_request(conn, 'GET', url)
        Retry(total=1).increment(method='GET', url=url, error=OSError(key))
        # urllib3's retry-warning shape includes both exception repr and URL.
        emitter.warning("Retrying (%r) after connection broken by '%r': %s",
                        Retry(total=0), OSError(key), url)
        try:
            raise requests.ConnectionError('synthetic failure: ' + key)
        except requests.ConnectionError:
            emitter.exception('request failed for %s', url)
            if outcome == 'transport':
                raise
        return Mock(status_code=503 if outcome == 'status' else 200, text=CSV)

    monkeypatch.setattr(firms_client.requests, 'get', fake_get)
    try:
        if outcome == 'success':
            assert firms_client.fetch_area_csv(0, 0, 1, 1) == CSV
        else:
            with pytest.raises(RuntimeError) as exc:
                firms_client.fetch_area_csv(0, 0, 1, 1)
            assert key not in ''.join(traceback.format_exception(exc.value))
        assert key not in caplog.text
        assert key not in local_output.getvalue()
        assert '[REDACTED]' in caplog.text
        assert 'Retrying' in caplog.text and 'request failed' in caplog.text
        assert any('GET' in r.getMessage() for r in caplog.records)
        for record in caplog.records:
            assert key not in repr(record.msg)
            assert key not in repr(record.args)
            assert key not in (record.exc_text or '')
        assert firms_client._request_key.get() is None
    finally:
        emitter.removeHandler(handler)


def test_filter_is_idempotent_and_keeps_unrelated_logs(monkeypatch, caplog):
    monkeypatch.setenv('MAP_KEY', 'SYNTHETIC_SENTINEL_TWO')
    monkeypatch.setattr(firms_client.requests, 'get', Mock(return_value=Mock(status_code=200, text=CSV)))
    for _ in range(2):
        firms_client.fetch_area_csv(0, 0, 1, 1)
    emitter = logging.getLogger('urllib3.connectionpool')
    assert emitter.filters.count(firms_client._credential_filter) == 1
    with caplog.at_level(logging.DEBUG):
        emitter.debug('unrelated request %s', '/public/data')
    assert 'unrelated request /public/data' in caplog.text
