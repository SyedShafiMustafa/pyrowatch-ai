import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.validation import load_csv_text, normalise_confidence
from app.scoring import score
from app.clustering import cluster_events

HEAD = "latitude,longitude,bright_ti4,acq_date,acq_time,satellite,confidence,frp,daynight\n"


def test_confidence_scales():
    assert normalise_confidence("h") == 1.0 and normalise_confidence("85") == 0.85
    assert normalise_confidence("zzz") is None


def test_validation_rejects_bad_rows():
    csv = HEAD + "10,20,340,2026-10-10,230,N20,h,5,D\n123,20,340,2026-10-10,230,N20,h,5,D\n10,20,340,10/10/2026,230,N20,h,-1,D\n"
    clean, issues = load_csv_text(csv)
    assert len(clean) == 1 and len(issues) == 2


def test_score_orders_and_bounds():
    csv = HEAD + "10,20,380,2026-10-10,1200,N20,h,60,D\n11,21,305,2026-10-08,1200,N20,l,1,D\n"
    s = score(load_csv_text(csv)[0])
    assert s.iloc[0]["frp"] == 60 and 0 <= s["score"].min() <= s["score"].max() <= 100


def test_clustering_merges_neighbours():
    csv = HEAD + "10,20,380,2026-10-10,1200,N20,h,60,D\n10.001,20.001,380,2026-10-10,1200,N20,h,50,D\n40,40,380,2026-10-10,1200,N20,h,10,D\n"
    _, ev = cluster_events(score(load_csv_text(csv)[0]))
    assert len(ev) == 2
