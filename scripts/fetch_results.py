#!/usr/bin/env python3
"""
fetch_results.py: pull live 2026 House and Senate results and write results.json.

Source: the AP race calls and vote counts published in The New York Times
results feed (static JSON, no key needed). A GitHub Action runs this every ten
minutes on election night; results.html reads results.json and scores the
model's frozen projection (final-forecast.json) against it.

Usage:
    python scripts/fetch_results.py            # writes ./results.json
    python scripts/fetch_results.py --dry-run  # parse and print a summary only

Optional overrides: results-manual.csv in the repo root, one row per race:
    chamber,code,winner,d,r,tv,note
    house,NC-01,R,120000,124000,250000,hand entered from the county canvass
A row replaces the feed's winner and vote counts for that race.
"""
import csv, json, os, sys, datetime
from pathlib import Path

try:
    import requests
except ImportError:  # pragma: no cover
    sys.exit("pip install requests")

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "results.json"
MANUAL = ROOT / "results-manual.csv"
DATE = "2026-11-03"
FEEDS = {
    "house": f"https://static01.nyt.com/elections-assets/pages/data/{DATE}/results-house.json",
    "senate": f"https://static01.nyt.com/elections-assets/pages/data/{DATE}/results-senate.json",
}
AT_LARGE = {"AK", "DE", "ND", "SD", "VT", "WY"}
IND_PARTIES = {"IND", "NPA", "NP", "UNA", "NOL", "NPP", "UNR", "NPD", "CST"}   # treated as the independent line
UA = {"User-Agent": "2026-House-Projections results bot (github.com/markgsheppard/2026-House-Projections)"}


def fetch(url):
    r = requests.get(url, headers=UA, timeout=90)
    r.raise_for_status()
    return r.json()


def race_code(nyt_id, chamber):
    """'AR-G-H-1-2026-11-03' -> 'AR-01'; 'LA-L-H-6-...' -> 'LA-06'; 'FL-S_W-S-...' -> 'FL'."""
    parts = nyt_id.split("-")
    st = parts[0]
    if chamber == "senate":
        return st
    if len(parts) < 4 or not parts[3].isdigit():
        return None
    n = int(parts[3])
    return f"{st}-AL" if st in AT_LARGE else f"{st}-{n:02d}"


def party_of(meta):
    p = ((meta or {}).get("party") or {}).get("nyt_id") or ""
    if p in ("DEM", "DFL", "WFP"):
        return "D"
    if p in ("GOP", "REP", "CON"):
        return "R"
    if p in IND_PARTIES:
        return "I"
    return "O"


def parse_race(race, chamber):
    code = race_code(race.get("nyt_id", ""), chamber)
    if not code:
        return None, None
    tru = race.get("top_reporting_unit") or {}
    cmeta = race.get("candidate_metadata") or {}
    best = {}  # party letter -> (votes, name, nyt_id)
    other = 0
    for c in tru.get("candidates") or []:
        m = cmeta.get(c.get("nyt_id"), {})
        name = " ".join(x for x in (m.get("first_name"), m.get("last_name")) if x) or c.get("nyt_id", "")
        if name.lower().startswith("total write"):
            continue
        v = int(((c.get("votes") or {}).get("total")) or 0)
        p = party_of(m)
        if p in ("D", "R", "I"):
            if p not in best or v > best[p][0]:
                best[p] = (v, name, c.get("nyt_id"))
        else:
            other += v
    tv = int(tru.get("total_votes") or 0)
    won = ((race.get("outcome") or {}).get("won")) or []
    winner = None
    if won:
        wp = party_of(cmeta.get(won[0], {}))
        winner = wp if wp in ("D", "R", "I") else "O"
    called = race.get("race_call_status") == "called" and winner is not None
    status = "called" if called else ("counting" if tv > 0 else "none")
    if not called:
        winner = None
    rec = {"status": status, "winner": winner, "tv": tv,
           "eevp": tru.get("eevp"), "pr": tru.get("precincts_reporting"), "pt": tru.get("precincts_total")}
    for p, key in (("D", "d"), ("R", "r"), ("I", "i")):
        if p in best:
            rec[key] = {"name": best[p][1], "v": best[p][0]}
    est = trend_estimate(tru, cmeta, best)
    if est:
        rec["est"] = est
    if other:
        rec["o"] = other
    # margin in points of the total vote: Democrat minus Republican; the independent
    # stands in for a missing Democrat (Nebraska) so the race still has a margin
    dside = rec.get("d") or (rec.get("i") if "d" not in rec else None)
    if tv > 0 and dside and "r" in rec:
        rec["margin"] = round((dside["v"] - rec["r"]["v"]) / tv * 100, 2)
        if "d" not in rec:
            rec["dside"] = "I"
    else:
        rec["margin"] = None
    return code, rec


def trend_estimate(tru, cmeta, best):
    """The feed's live estimate of where an uncalled race ends up, given the count so far:
    win probability for each side and the median projected final margin (D minus R).
    Used by the results page's Outlook view; the independent stands in for a missing Democrat."""
    win, share = {}, {}
    for c in tru.get("candidates") or []:
        e = c.get("nyt_model_estimates") or {}
        wp, q = e.get("win_probability"), e.get("voteshare_quantile")
        if not isinstance(wp, (int, float)):
            continue
        p = party_of(cmeta.get(c.get("nyt_id"), {}))
        if p not in ("D", "R", "I"):
            continue
        # keep the side's strongest candidate (the one the count puts ahead)
        if p in best and best[p][2] != c.get("nyt_id"):
            continue
        win[p] = wp
        if isinstance(q, list) and len(q) >= 3 and isinstance(q[2], (int, float)):
            share[p] = q[2]
    if not win:
        return None
    dkey = "D" if "D" in win else ("I" if "I" in win else None)
    if dkey is None or "R" not in win:
        return None
    est = {"d": round(win[dkey], 3), "r": round(win["R"], 3)}
    if dkey in share and "R" in share:
        est["m"] = round((share[dkey] - share["R"]) * 100, 2)
    return est


def apply_manual(results):
    if not MANUAL.exists():
        return 0
    n = 0
    with MANUAL.open(newline="") as fh:
        for row in csv.DictReader(fh):
            ch = (row.get("chamber") or "house").strip().lower()
            code = (row.get("code") or "").strip().upper()
            if ch not in results or not code:
                continue
            rec = results[ch].setdefault(code, {"status": "none", "winner": None, "tv": 0, "margin": None})
            w = (row.get("winner") or "").strip().upper()
            if w in ("D", "R", "I"):
                rec["winner"] = w
                rec["status"] = "called"
            try:
                d, r = int(row.get("d") or 0), int(row.get("r") or 0)
                tv = int(row.get("tv") or (d + r))
                if tv > 0:
                    rec.setdefault("d", {"name": "Democrat", "v": d})["v"] = d
                    rec.setdefault("r", {"name": "Republican", "v": r})["v"] = r
                    rec["tv"] = tv
                    rec["margin"] = round((d - r) / tv * 100, 2)
                    if rec["status"] == "none":
                        rec["status"] = "counting"
            except ValueError:
                pass
            if row.get("note"):
                rec["note"] = row["note"].strip()
            rec["manual"] = True
            n += 1
    return n


def main():
    dry = "--dry-run" in sys.argv
    results = {"house": {}, "senate": {}}
    updated = None
    for chamber, url in FEEDS.items():
        try:
            feed = fetch(url)
        except Exception as e:  # keep the last good file rather than publish a blank one
            print(f"{chamber}: fetch failed ({e})", file=sys.stderr)
            continue
        for race in feed.get("races") or []:
            if race.get("nyt_id", "").startswith("US-"):
                continue
            code, rec = parse_race(race, chamber)
            if code:
                results[chamber][code] = rec
        ts = ((feed.get("resultsMeta") or {}).get("resultsUpdatedAt"))
        if ts and (updated is None or ts > updated):
            updated = ts

    if len(results["house"]) < 400 or len(results["senate"]) < 30:
        print(f"incomplete feed: {len(results['house'])} House, {len(results['senate'])} Senate races; keeping the previous results.json", file=sys.stderr)
        sys.exit(0)

    n_manual = apply_manual(results)
    out = {
        "updated": updated or datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "fetched": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "source": "AP race calls and vote counts via The New York Times results feed",
        "house": dict(sorted(results["house"].items())),
        "senate": dict(sorted(results["senate"].items())),
    }
    hc = sum(1 for r in out["house"].values() if r["status"] == "called")
    sc = sum(1 for r in out["senate"].values() if r["status"] == "called")
    print(f"House: {len(out['house'])} races, {hc} called. Senate: {len(out['senate'])} races, {sc} called. "
          f"Manual overrides: {n_manual}. Feed updated {out['updated']}.")
    if dry:
        return
    OUT.write_text(json.dumps(out, separators=(",", ":")) + "\n")
    print(f"wrote {OUT.name}")


if __name__ == "__main__":
    main()
