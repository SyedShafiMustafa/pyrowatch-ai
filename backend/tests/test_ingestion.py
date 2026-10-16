"""Offline tests. All inline records are synthetic, not NASA observations."""
import json
from unittest.mock import Mock
import pytest
import requests
from fastapi.testclient import TestClient
from app.validation import inspect_csv_text, load_csv_text, normalise_confidence
from app.firms_client import fetch_area_csv

HEAD = 'latitude,longitude,bright_ti4,acq_date,acq_time,satellite,confidence,frp,daynight\n'
ROW = '10,20,340,2026-10-10,230,N20,h,5,D\n'


@pytest.mark.parametrize('value', ['NaN', 'inf', '-inf', '-1', ''])
def test_nonfinite_or_missing_frp(value):
    clean, issues = load_csv_text(HEAD + ROW.replace(',5,D', f',{value},D'))
    assert clean.empty and len(issues) == 1


@pytest.mark.parametrize('value', ['NaN', 'inf', '-inf'])
def test_nonfinite_brightness_is_rejected(value):
    clean, issues = load_csv_text(HEAD + ROW.replace(',340,', f',{value},'))
    assert clean.empty and len(issues) == 1


@pytest.mark.parametrize('value', ['2360', '2400', '12.5', '-1', '12345', 'nan', ''])
def test_invalid_clock(value):
    assert load_csv_text(HEAD + ROW.replace(',230,', f',{value},'))[0].empty


@pytest.mark.parametrize('value', ['230', '0230', '230.0'])
def test_clock_normalisation(value):
    clean, issues = load_csv_text(HEAD + ROW.replace(',230,', f',{value},'))
    assert not issues and str(clean.iloc[0].time) == '2026-10-10 02:30:00+00:00'


def test_accounting_and_physical_lines():
    clean, issues, report = inspect_csv_text('\ufeff' + HEAD + ROW + '\n' + HEAD + ROW + 'bad,row\n')
    assert len(clean) == 1
    assert (report['accepted'], report['rejected'], report['deduplicated'], report['total_records']) == (1, 3, 1, 5)
    assert [o['line'] for o in report['outcomes']] == [2, 3, 4, 5, 6]
    assert 'line 2' in report['outcomes'][3]['reason']


def test_raw_fields_and_multiline():
    header = HEAD.rstrip() + ',type,instrument,comment\n'
    row = ROW.rstrip() + ',2,VIIRS,"synthetic\nrecord"\n'
    clean, _, report = inspect_csv_text(header + row)
    assert clean.iloc[0].source_fields['type'] == '2'
    assert clean.iloc[0].instrument == 'VIIRS'
    assert report['outcomes'][0]['end_line'] == 3


def test_confidence_and_modis():
    assert normalise_confidence('hello') is None
    clean, issues = load_csv_text(HEAD.replace('bright_ti4', 'brightness') + ROW.replace(',h,', ',85,'))
    assert not issues and clean.iloc[0].confidence == .85
    assert clean.iloc[0].instrument is None


@pytest.mark.parametrize('text', ['', 'latitude,latitude\n1,2\n', HEAD + '"unterminated\n', HEAD + ROW.rstrip() + ',extra\n'])
def test_malformed_files_do_not_crash(text):
    clean, issues, report = inspect_csv_text(text)
    assert clean.empty and issues
    assert report['total_records'] == sum(report[s] for s in ('accepted', 'rejected', 'deduplicated'))


def test_bad_label_and_missing_label():
    assert load_csv_text(HEAD.rstrip() + ',label\n' + ROW.rstrip() + ',oops\n')[0].empty
    assert load_csv_text(HEAD.rstrip() + ',label\n' + ROW.rstrip() + ',\n')[0].iloc[0].label is None


def test_upload_and_sample_contract():
    from app.main import app
    with TestClient(app) as client:
        result = client.post('/api/upload', files={'file': ('synthetic.csv', HEAD + ROW + ROW, 'text/csv')})
        assert result.status_code == 200
        data = result.json()
        assert {'issues', 'weights', 'rows', 'events', 'evaluation', 'ingestion'} <= data.keys()
        assert data['ingestion']['deduplicated'] == 1
        assert data['rows'][0]['repeat_count'] == 0
        assert data['rows'][0]['label'] is None
        assert data['rows'][0]['score_missing_factors'] == []
        assert data['rows'][0]['score'] == pytest.approx(sum(data['rows'][0][f'c_{name}'] for name in ('recency', 'confidence', 'frp', 'repeats', 'brightness')))
        json.dumps(data, allow_nan=False)
        mixed = client.post('/api/upload', files={'file': ('synthetic_mixed.csv', HEAD + ROW + ROW.replace(',340,', ',NaN,'), 'text/csv')})
        assert mixed.status_code == 200
        mixed_data = mixed.json()
        assert mixed_data['ingestion']['accepted'] == 1 and mixed_data['ingestion']['rejected'] == 1
        assert len(mixed_data['rows']) == 1
        json.dumps(mixed_data, allow_nan=False)
        sample = client.get('/api/sample')
        assert sample.status_code == 200 and sample.json()['ingestion']['data_kind'] == 'synthetic'
        assert sample.json()['evaluation']['n_labelled'] >= 20
        assert client.post('/api/upload', files={'file': ('bad.csv', b'\xff')}).status_code == 400


def _multipart_file_body(payload, boundary='pyrowatch-boundary'):
    return (f'--{boundary}\r\n'
            'Content-Disposition: form-data; name="file"; filename="synthetic.csv"\r\n'
            'Content-Type: text/csv\r\n\r\n').encode() + payload + (
                f'\r\n--{boundary}--\r\n'.encode())


def _installed_upload_limiter(app, limiter_type):
    layer = app.middleware_stack
    while not isinstance(layer, limiter_type):
        layer = getattr(layer, 'app', None)
        if layer is None:
            raise AssertionError('upload limiter is missing from the FastAPI middleware stack')
    return layer


def test_upload_limit_accepts_exact_request_body_boundary():
    from app.main import UploadSizeLimitMiddleware, app

    body = _multipart_file_body((HEAD + ROW).encode())
    with TestClient(app) as client:
        limiter = _installed_upload_limiter(app, UploadSizeLimitMiddleware)
        original_limit = limiter.max_bytes
        limiter.max_bytes = len(body)
        try:
            response = client.post('/api/upload', content=body, headers={
                'Content-Type': 'multipart/form-data; boundary=pyrowatch-boundary'})
        finally:
            limiter.max_bytes = original_limit
    assert response.status_code == 200
    assert response.json()['ingestion']['accepted'] == 1


def test_upload_limit_rejects_request_one_byte_over_boundary():
    from app.main import UploadSizeLimitMiddleware, app

    body = _multipart_file_body((HEAD + ROW).encode())
    with TestClient(app) as client:
        limiter = _installed_upload_limiter(app, UploadSizeLimitMiddleware)
        original_limit = limiter.max_bytes
        limiter.max_bytes = len(body) - 1
        try:
            response = client.post('/api/upload', content=body, headers={
                'Content-Type': 'multipart/form-data; boundary=pyrowatch-boundary',
                'Origin': 'http://127.0.0.1:5500'})
        finally:
            limiter.max_bytes = original_limit
    assert response.status_code == 413
    assert response.json() == {
        'detail': f'Upload request exceeds the {len(body) - 1}-byte limit'}
    assert response.headers['access-control-allow-origin'] == 'http://127.0.0.1:5500'


def test_upload_limit_bounds_streamed_body_without_content_length():
    import asyncio
    from app.main import UploadSizeLimitMiddleware

    received_by_app = []

    async def downstream(scope, receive, send):
        received_by_app.append(await receive())

    messages = iter([{"type": "http.request", "body": b"123456", "more_body": False}])
    responses = []

    async def receive():
        return next(messages)

    async def send(message):
        responses.append(message)

    scope = {"type": "http", "method": "POST", "path": "/api/upload", "headers": []}
    asyncio.run(UploadSizeLimitMiddleware(downstream, max_bytes=5)(scope, receive, send))

    assert received_by_app == []
    assert responses[0]["status"] == 413


def test_firms_http_mock_and_secret_redaction(monkeypatch):
    monkeypatch.setenv('MAP_KEY', 'synthetic-test-key')
    get = Mock(return_value=Mock(status_code=200, text=HEAD + ROW))
    monkeypatch.setattr('app.firms_client.requests.get', get)
    assert fetch_area_csv(10, 20, 30, 40) == HEAD + ROW
    assert get.call_args.kwargs == {'timeout': 30, 'allow_redirects': False}
    get.side_effect = requests.RequestException('URL contains synthetic-test-key')
    with pytest.raises(RuntimeError) as exc:
        fetch_area_csv(10, 20, 30, 40)
    assert 'synthetic-test-key' not in str(exc.value)
    assert exc.value.__suppress_context__
    get.side_effect = None
    get.return_value = Mock(status_code=200, text='Invalid key')
    with pytest.raises(RuntimeError, match='schema'):
        fetch_area_csv(10, 20, 30, 40)
    get.reset_mock()
    with pytest.raises(ValueError):
        fetch_area_csv(10, 20, 30, 40, days=6)
    get.assert_not_called()
