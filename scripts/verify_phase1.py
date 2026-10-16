"""Offline localhost smoke checks; inline observations are synthetic fixtures."""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time

import requests


def main():
    root = Path(__file__).resolve().parents[1]
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    env = os.environ.copy()
    for name in ('MAP_KEY', 'FIRMS_MAP_KEY'):
        env.pop(name, None)
    session = requests.Session()
    session.trust_env = False
    base = f'http://127.0.0.1:{port}'
    with tempfile.TemporaryFile() as logs:
        process = subprocess.Popen(
            [sys.executable, '-m', 'uvicorn', 'backend.app.main:app',
             '--host', '127.0.0.1', '--port', str(port)],
            cwd=root, env=env, stdout=logs, stderr=logs,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0,
        )
        try:
            deadline = time.monotonic() + 30
            while True:
                try:
                    health = session.get(base + '/api/health', timeout=2)
                    break
                except requests.ConnectionError:
                    if process.poll() is not None or time.monotonic() >= deadline:
                        raise RuntimeError('Local API did not start within 30 seconds') from None
                    time.sleep(.2)
            assert health.status_code == 200 and health.json() == {'ok': True}
            print(json.dumps({'endpoint': '/api/health', 'status': health.status_code, 'body': health.json()}))
            sample = session.get(base + '/api/sample', timeout=15)
            assert sample.status_code == 200
            data = sample.json()
            assert len(data['rows']) == 232 and data['ingestion']['data_kind'] == 'synthetic'
            print(json.dumps({'endpoint': '/api/sample', 'status': sample.status_code,
                              'keys': sorted(data), 'rows': len(data['rows']),
                              'events': len(data['events']), 'labelled': data['evaluation']['n_labelled']}))
            header = 'latitude,longitude,bright_ti4,acq_date,acq_time,satellite,confidence,frp,daynight\n'
            row = '10,20,340,2026-10-10,230,N20,h,5,D\n'
            fixture = header + row + row + row.replace('10,20,', '100,20,')
            upload = session.post(base + '/api/upload', files={'file': ('synthetic_smoke.csv', fixture, 'text/csv')}, timeout=15)
            assert upload.status_code == 200
            result = upload.json()
            report = result['ingestion']
            assert (report['total_records'], report['accepted'], report['rejected'], report['deduplicated']) == (3, 1, 1, 1)
            assert [r['line'] for r in report['outcomes']] == [2, 3, 4]
            assert len(result['rows']) == 1 and result['rows'][0]['repeat_count'] == 0
            print(json.dumps({'endpoint': '/api/upload', 'status': upload.status_code, 'keys': sorted(result), 'ingestion': report}))
            nonfinite = session.post(base + '/api/upload', files={
                'file': ('synthetic_nonfinite.csv', header + row + row.replace(',340,', ',NaN,'), 'text/csv')}, timeout=15)
            nonfinite_data = nonfinite.json()
            assert nonfinite.status_code == 200
            assert nonfinite_data['ingestion']['accepted'] == 1 and nonfinite_data['ingestion']['rejected'] == 1
            assert len(nonfinite_data['rows']) == 1
            json.dumps(nonfinite_data, allow_nan=False)
            print(json.dumps({'case': 'one_nonfinite_brightness_record', 'status': nonfinite.status_code,
                              'accepted': nonfinite_data['ingestion']['accepted'],
                              'rejected': nonfinite_data['ingestion']['rejected']}))
            schema = session.post(base + '/api/upload', files={'file': ('synthetic_bad_schema.csv', 'latitude,latitude\n1,2\n', 'text/csv')}, timeout=15)
            result = schema.json()
            assert schema.status_code == 200 and result['ingestion']['total_records'] == 1
            assert result['ingestion']['rejected'] == 1 and len(result['issues']) == 2
            print(json.dumps({'case': 'schema_error', 'status': schema.status_code, 'issues': result['issues'], 'ingestion': result['ingestion']}))
            encoding = session.post(base + '/api/upload', files={'file': ('synthetic_invalid_utf8.csv', b'\xff', 'text/csv')}, timeout=15)
            assert encoding.status_code == 400
            print(json.dumps({'case': 'invalid_utf8', 'status': encoding.status_code, 'body': encoding.json()}))
        finally:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
            session.close()
            logs.seek(0)
            print('LOCAL_SERVER_LOGS\n' + logs.read().decode('utf-8', errors='replace'))


if __name__ == '__main__':
    main()
