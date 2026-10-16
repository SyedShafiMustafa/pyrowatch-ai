"""Train a local event anomaly model from an explicitly identified CSV reference."""
import argparse
import hashlib
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.app.anomaly import MODEL_PATH, train_model  # noqa: E402
from backend.app.clustering import cluster_events  # noqa: E402
from backend.app.event_features import extract_event_features  # noqa: E402
from backend.app.scoring import score  # noqa: E402
from backend.app.validation import load_csv_text  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("csv", type=Path, help="validated reference CSV, with documented provenance")
    parser.add_argument("--output", type=Path, default=MODEL_PATH)
    parser.add_argument("--synthetic", action="store_true", help="explicitly mark generated test data")
    args = parser.parse_args()
    source_bytes = args.csv.read_bytes()
    clean, issues = load_csv_text(source_bytes.decode("utf-8-sig"))
    if issues:
        parser.error(f"reference contains {len(issues)} ingestion issue(s); fix before training")
    if clean.empty:
        parser.error("reference has no validated observations")
    grouped, _ = cluster_events(score(clean))
    records = extract_event_features(grouped)
    reference = ("SYNTHETIC software reference: " if args.synthetic else "User-supplied unverified: ") + str(args.csv)
    dataset = {"source": str(args.csv), "kind": "synthetic" if args.synthetic else "unknown",
               "sha256": hashlib.sha256(source_bytes).hexdigest(),
               "row_count": int(len(clean)),
               "time_range_utc": [clean["time"].min().isoformat(), clean["time"].max().isoformat()]}
    metadata = train_model(records, args.output, reference=reference, dataset=dataset)
    print(f"saved {metadata['version']} with {metadata['training_events']} event groups to {args.output}")
    print("Anomaly detection is uncalibrated; this is not wildfire accuracy validation.")


if __name__ == "__main__":
    main()
