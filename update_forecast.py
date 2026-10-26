#!/usr/bin/env python3
"""
update_forecast.py  —  refresh the 2026 House forecast from house-polling.xlsx

Usage:
    python update_forecast.py            # reads ./house-polling.xlsx
    python update_forecast.py my.xlsx

What it does:
  * reads the Inputs sheet (generic ballot, redistricting shift, source, date)
  * reads the Districts sheet (optional per-district margin overrides)
  * rewrites data.js and rebuilds 2026-house-forecast.html (the shareable file)
  * stamps "Data updated" with the sheet's date, or today's date if blank
No internet or build tools required — just Python + openpyxl.
"""
import json, re, sys, math, datetime
from pathlib import Path
from openpyxl import load_workbook

HERE = Path(__file__).resolve().parent
xlsx = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / "house-polling.xlsx"

def load_data():
    raw = (HERE / "data.js").read_text()
    body = re.sub(r";\s*$", "", raw[len("window.HOUSE_DATA = "):])
    return json.loads(body)

def fmt_date(v):
    if v in (None, ""):
        v = datetime.date.today()
    if isinstance(v, (datetime.datetime, datetime.date)):
        return v.strftime("%B %-d, %Y")
    return str(v).strip()

def read_inputs(ws):
    out = {}
    for row in ws.iter_rows(values_only=True):
        if not row or row[0] is None:
            continue
        label = str(row[0]).lower()
        val = row[1] if len(row) > 1 else None
        if val in (None, ""):
            continue
        if "generic ballot" in label and "source" not in label:
            try: out["genericBallot"] = max(0.0, min(10.0, float(val)))
            except ValueError: pass
        elif "source" in label:
            out["gbSource"] = str(val)
        elif "updated" in label or "date" in label:
            out["dataUpdated"] = fmt_date(val)
    return out

def read_districts(ws, code_to_id):
    overrides = {}
    for row in ws.iter_rows(values_only=True):
        if not row or row[0] is None:
            continue
        code = str(row[0]).strip().upper()
        if code not in code_to_id:
            continue
        try:
            overrides[code_to_id[code]] = round(float(row[1]), 2)
        except (TypeError, ValueError):
            pass
    return overrides

def read_polls(ws):
    """Polls sheet: header row, then Pollster | Start date | End date | Dem % | Rep %."""
    def iso(v):
        if isinstance(v, (datetime.datetime, datetime.date)):
            return v.strftime("%Y-%m-%d")
        try:
            return datetime.date.fromisoformat(str(v).strip()[:10]).isoformat()
        except ValueError:
            return None
    polls = []
    for row in ws.iter_rows(values_only=True):
        if not row or len(row) < 5 or row[0] is None:
            continue
        s0, e0 = iso(row[1]), iso(row[2])
        try:
            d, r = float(row[3]), float(row[4])
        except (TypeError, ValueError):
            continue
        if s0 and e0:
            rec = [str(row[0]), s0, e0, d, r]
            pop = str(row[5]).strip().upper() if len(row) > 5 and row[5] else ""
            if pop in ("LV", "RV", "A"): rec.append(pop)
            polls.append(rec)
    return sorted(polls, key=lambda p: p[2])

def main():
    if not xlsx.exists():
        sys.exit(f"Spreadsheet not found: {xlsx}")
    data = load_data()
    fc, meta = data["forecast"], data["meta"]
    code_to_id = {f["code"].upper(): i for i, f in fc.items()}

    wb = load_workbook(xlsx, data_only=True)
    inputs = read_inputs(wb["Inputs"] if "Inputs" in wb.sheetnames else wb[wb.sheetnames[0]])
    meta.update(inputs)
    if "dataUpdated" not in inputs:
        meta["dataUpdated"] = fmt_date(None)  # today

    n_over = 0
    if "Districts" in wb.sheetnames:
        ov = read_districts(wb["Districts"], code_to_id)
        for did, m in ov.items():
            fc[did]["margin"] = m
        n_over = len(ov)

    if "Pollsters" in wb.sheetnames:
        pst = {}
        for row in wb["Pollsters"].iter_rows(values_only=True):
            if row and row[0] and len(row) >= 4 and isinstance(row[2], (int, float)):
                pst[str(row[0]).strip()] = {"grade": str(row[1]), "w": float(row[2]), "pop": str(row[3]).strip().upper()}
        if pst: meta["pollsters"] = pst

    if "Polls" in wb.sheetnames:
        polls = read_polls(wb["Polls"])
        if len(polls) >= 3:
            data["polls"] = polls

    # recompute baseline seat tally at the chosen generic ballot (for meta tidiness)
    anchor, gb = meta.get("anchor", 0), meta.get("genericBallot", 6.6)
    swing = gb - anchor
    margins = sorted((f["margin"] + (f.get("elast", 1) or 1) * swing + (f.get("fund", {}).get("adj", 0) or 0) for f in fc.values()), reverse=True)
    dem = sum(1 for m in margins if m >= 0)
    meta["demSeats"], meta["gopSeats"] = dem, len(margins) - dem
    meta["leader"] = "D" if dem >= meta["gopSeats"] else "R"

    # write data.js
    (HERE / "data.js").write_text("window.HOUSE_DATA = " + json.dumps(data, separators=(",", ":")) + ";\n")

    # calibration log: one row per run, so the forecast can be scored after the election
    import csv
    def eff_margin(f):
        e = f.get("elast", 1) or 1
        return f["margin"] + e * swing + (f.get("fund", {}).get("adj", 0) or 0)
    comp = sorted(fc.values(), key=lambda f: abs(eff_margin(f)))[:40]
    sen = meta.get("senate", [])
    sen_up_d = sum(1 for rc in sen if rc.get("p", 0) >= 0.5)
    notup_d = meta.get("senateNotUpD", 34)
    row = {
        "run_date": datetime.date.today().isoformat(),
        "data_updated": meta["dataUpdated"],
        "generic_ballot": gb,
        "house_dem": dem, "house_gop": meta["gopSeats"],
        "senate_dem": notup_d + sen_up_d, "senate_gop": 100 - notup_d - sen_up_d,
        "n_polls": len(data.get("polls", [])),
        "house_battlegrounds": json.dumps({f["code"]: round(eff_margin(f), 2) for f in comp}, separators=(",", ":")),
        "senate_probs": json.dumps({rc["st"]: rc.get("p") for rc in sen}, separators=(",", ":")),
    }
    log = HERE / "forecast-log.csv"
    new_file = not log.exists()
    with log.open("a", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(row.keys()))
        if new_file: w.writeheader()
        w.writerow(row)

    # rebuild the standalone, shareable HTML
    html = (HERE / "index.html").read_text()
    css = (HERE / "styles.css").read_text()
    djs = (HERE / "data.js").read_text()
    ajs = (HERE / "app.js").read_text()
    html = html.replace('  <link rel="stylesheet" href="styles.css" />', "  <style>\n" + css + "\n  </style>")
    html = html.replace('  <script src="data.js"></script>', "  <script>\n" + djs + "\n  </script>")
    html = html.replace('  <script src="app.js"></script>', "  <script>\n" + ajs + "\n  </script>")
    (HERE / "2026-house-forecast.html").write_text(html)

    print("Updated 2026-house-forecast.html")
    print(f"  generic ballot   : D +{gb}")
    print(f"  redistrict shift : {meta.get('redistrictShift')}")
    print(f"  data updated     : {meta['dataUpdated']}")
    print(f"  district edits   : {n_over}")
    print(f"  baseline tally   : D {dem} / R {meta['gopSeats']}")

if __name__ == "__main__":
    main()
