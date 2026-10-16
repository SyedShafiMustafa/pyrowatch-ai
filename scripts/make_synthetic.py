"""Generate a LABELLED SYNTHETIC sample (label 1 = planted fire, 0 = noise / static heat source).
Labels come from this generator, so they test the pipeline only, not real-world accuracy."""
import random
from datetime import datetime, timedelta, timezone
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / "data" / "sample" / "synthetic_sample.csv"
r = random.Random(11)
base = datetime(2026, 10, 10, tzinfo=timezone.utc)
rows = ["latitude,longitude,bright_ti4,acq_date,acq_time,satellite,confidence,frp,daynight,label"]


def add(la, lo, bt, t, sat, conf, frp, label):
    dn = "N" if 10 <= t.hour < 22 else "D"
    rows.append(f"{la:.4f},{lo:.4f},{bt:.1f},{t:%Y-%m-%d},{t:%H%M},{sat},{conf},{frp:.1f},{dn},{label}")


for la, lo, k in [(-33.0, 150.2, 3), (-33.6, 150.9, 2), (-32.4, 149.7, 1.5)]:   # real fires
    for d in range(4):
        for h in (2, 13):
            for _ in range(int(3 * k) + 1):
                t = base + timedelta(days=d, hours=h, minutes=r.random() * 60)
                add(la + d * .012 + (r.random() - .5) * .03, lo + d * .01 + (r.random() - .5) * .03,
                    335 + r.random() * 50, t, r.choice(["N20", "N21"]), r.choice(["h", "n"]), 8 + r.random() * 55 * k, 1)
for _ in range(40):                                                                # scattered noise
    add(-34 + r.random() * 2, 149.5 + r.random() * 1.5, 300 + r.random() * 25,
        base + timedelta(days=r.random() * 4), "Suomi NPP", r.choice(["l", "l", "n"]), .5 + r.random() * 3.5, 0)
for la, lo in [(-33.3, 150.55), (-32.8, 150.1)]:                                   # static heat sources
    for i in range(8):
        add(la + (r.random() - .5) * .004, lo + (r.random() - .5) * .004, 328 + r.random() * 6,
            base + timedelta(days=i % 4, hours=2 if i < 4 else 13), "N20", "n", 3 + r.random() * 3, 0)
OUT.write_text("\n".join(rows) + "\n")
print(f"wrote {len(rows)-1} rows -> {OUT}")
