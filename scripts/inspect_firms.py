"""Offline CSV inspection. Does not modify the input file or fetch observations."""
import argparse
import json
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from app.validation import inspect_csv_text

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('csv', type=Path)
    parser.add_argument('--synthetic', action='store_true', help='Explicitly identify generated test data')
    args = parser.parse_args()
    _, issues, report = inspect_csv_text(args.csv.read_text(encoding='utf-8-sig'))
    if args.synthetic:
        report['data_kind'] = 'synthetic'
    print(json.dumps({'ingestion': report, 'issues': issues}, indent=2))
