"""Import + validation. Returns clean rows and a list of human-readable issues."""
import io
import csv
import math
import re
import pandas as pd

REQUIRED = ["latitude", "longitude", "acq_date", "acq_time", "confidence", "frp"]


def normalise_confidence(v):
    """VIIRS: l/n/h (or low/nominal/high). MODIS: 0-100. Returns 0-1 or None."""
    s = str(v).strip().lower()
    if s in ("l", "low"):
        return 0.2
    if s in ("n", "nominal"):
        return 0.6
    if s in ("h", "high"):
        return 1.0
    try:
        x = float(s) / 100.0
        return x if 0 <= x <= 1 else None
    except ValueError:
        return None


def validate(df: pd.DataFrame):
    """-> (clean_df, issues). Never raises on bad rows; reports them."""
    df = df.copy()
    df.columns = [c.strip().lower() for c in df.columns]
    if "bright_ti4" not in df.columns and "brightness" in df.columns:
        df["bright_ti4"] = df["brightness"]
    missing = [c for c in REQUIRED + ["bright_ti4"] if c not in df.columns]
    if missing:
        return df.iloc[0:0], [f"Missing columns: {', '.join(missing)}"]

    good, issues, outcomes, seen = [], [], [], {}
    for i, (_, r) in enumerate(df.iterrows()):
        line, errs = int(r.get("_source_line", i + 2)), []
        try:
            lat, lon = float(r["latitude"]), float(r["longitude"])
            if not -90 <= lat <= 90: errs.append("latitude out of range")
            if not -180 <= lon <= 180: errs.append("longitude out of range")
        except (TypeError, ValueError):
            errs.append("latitude/longitude not numeric"); lat = lon = None
        try:
            frp = float(r["frp"])
            if not math.isfinite(frp) or frp < 0: errs.append("FRP must be finite and non-negative")
        except (TypeError, ValueError):
            errs.append("FRP missing"); frp = None
        try:
            bt = float(r["bright_ti4"])
            if not 200 <= bt <= 500: errs.append("brightness implausible")
        except (TypeError, ValueError):
            errs.append("brightness missing"); bt = None
        raw_time = str(r["acq_time"]).strip()
        hhmm = raw_time.split(".")[0].zfill(4)
        t = pd.to_datetime(f"{str(r['acq_date']).strip()} {hhmm[:2]}:{hhmm[2:]}",
                           format="%Y-%m-%d %H:%M", utc=True, errors="coerce")
        if (not re.fullmatch(r"\d{1,4}(?:\.0+)?", raw_time)
                or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(r["acq_date"]).strip())
                or not hhmm.isdigit() or int(hhmm[:2]) > 23 or int(hhmm[2:]) > 59 or pd.isna(t)):
            errs.append("bad date/time (expect YYYY-MM-DD and HHMM, UTC)")
        conf = normalise_confidence(r["confidence"])
        if conf is None: errs.append("confidence not l/n/h or 0-100")
        label = None
        if "label" in df.columns and pd.notna(r["label"]) and str(r["label"]).strip():
            if str(r["label"]).strip() in ("0", "1"):
                label = int(r["label"])
            else:
                errs.append("label must be 0, 1 or blank")
        if errs:
            reason = "; ".join(errs)
            issues.append(f"line {line}: " + reason)
            outcomes.append({"line": line, "status": "rejected", "reason": reason})
            continue
        identity = (lat, lon, t, str(r.get("satellite", "?")), str(r.get("instrument", "")))
        if identity in seen:
            reason = f"duplicate observation of line {seen[identity]} (first valid row retained)"
            issues.append(f"line {line}: {reason}")
            outcomes.append({"line": line, "status": "deduplicated", "reason": reason})
            continue
        seen[identity] = line
        outcomes.append({"line": line, "status": "accepted", "reason": "validated"})
        good.append({"latitude": lat, "longitude": lon, "time": t, "frp": frp,
                     "brightness": bt, "confidence_raw": str(r["confidence"]),
                     "confidence": conf,
                     "satellite": str(r.get("satellite", "?")),
                     "daynight": str(r.get("daynight", "")),
                     "label": label, "source_line": line,
                     "source_fields": {k: (None if pd.isna(v) else str(v)) for k, v in r.items() if k != "_source_line"}})
    clean = pd.DataFrame(good)
    clean.attrs["outcomes"] = outcomes
    return clean, issues


def load_csv_text(text: str):
    """Compatibility wrapper; detailed accounting is attached to DataFrame attrs."""
    clean, issues, report = inspect_csv_text(text)
    clean.attrs["ingestion"] = report
    return clean, issues


def inspect_csv_text(text: str):
    """Parse CSV records with physical start/end lines, including blank records."""
    reader = csv.reader(io.StringIO(text.lstrip("\ufeff"), newline=""), strict=True)
    header, records, outcomes, issues = None, [], [], []
    while True:
        start = reader.line_num + 1
        try:
            values = next(reader)
        except StopIteration:
            break
        except csv.Error:
            reason = "malformed CSV record; consumed physical line span rejected"
            outcomes.append({"line": start, "end_line": reader.line_num, "status": "rejected", "reason": reason})
            issues.append(f"line {start}: {reason}")
            continue
        end = reader.line_num
        normal = [v.strip().lower() for v in values]
        if not values or all(not v.strip() for v in values):
            outcomes.append({"line": start, "end_line": end, "status": "rejected", "reason": "blank record"})
            issues.append(f"line {start}: blank record")
            continue
        if header is None:
            header = normal
            schema_error = None
            missing = [c for c in REQUIRED if c not in header]
            if not ({"bright_ti4", "brightness"} & set(header)):
                missing.append("bright_ti4 or brightness")
            if len(set(header)) != len(header) or "" in header or "_source_line" in header:
                schema_error = "duplicate, empty or reserved column name"
            elif missing:
                schema_error = "Missing columns: " + ", ".join(missing)
            if schema_error:
                issues.append(f"line {start}: {schema_error}")
            continue
        reason = schema_error or ("repeated header" if normal == header else None)
        if len(values) != len(header):
            reason = "column count differs from header"
        if reason:
            outcomes.append({"line": start, "end_line": end, "status": "rejected", "reason": reason})
            issues.append(f"line {start}: {reason}")
        else:
            records.append((start, end, dict(zip(header, values))))
    clean = pd.DataFrame()
    if records:
        df = pd.DataFrame([{**r, "_source_line": line} for line, _, r in records])
        clean, validation_issues = validate(df)
        issues.extend(validation_issues)
        ends = {line: end for line, end, _ in records}
        outcomes.extend({**o, "end_line": ends[o["line"]]} for o in clean.attrs["outcomes"])
    if header is None:
        issues.append("No CSV header found")
    outcomes.sort(key=lambda o: o["line"])
    counts = {s: sum(o["status"] == s for o in outcomes) for s in ("accepted", "rejected", "deduplicated")}
    report = {"total_records": len(outcomes), **counts, "physical_lines": reader.line_num,
              "columns": header or [], "outcomes": outcomes, "data_kind": "user_supplied_unverified"}
    return clean, issues, report
