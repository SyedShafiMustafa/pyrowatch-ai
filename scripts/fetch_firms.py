"""Usage: python scripts/fetch_firms.py WEST SOUTH EAST NORTH DAYS out.csv (needs MAP_KEY in environment)."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from app.firms_client import fetch_area_csv

if __name__ == "__main__":
    import argparse
    from app.validation import inspect_csv_text
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("west", "south", "east", "north"):
        parser.add_argument(name, type=float)
    parser.add_argument("days", type=int)
    parser.add_argument("out", type=Path)
    args = parser.parse_args()
    if args.out.exists():
        parser.error("Output exists; choose a new filename to preserve existing data")
    text = fetch_area_csv(args.west, args.south, args.east, args.north, args.days)
    _, _, report = inspect_csv_text(text)
    with args.out.open("x", encoding="utf-8", newline="") as output:
        output.write(text)
    print(f"saved {args.out}: {report['accepted']} accepted, {report['rejected']} rejected, {report['deduplicated']} duplicates; raw CSV retained")
