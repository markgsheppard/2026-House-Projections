#!/usr/bin/env python3
"""
fetch_counties.py: county-level margins for the Shift view, written to county-shift.json.

For every Senate race (and, with --house, every House race) this pulls the race's
own New York Times results file, which carries the AP count by county together with
the county's 2024 presidential margin, and reduces it to one row per county:

    [margin 2026 so far, margin 2024 presidential, share of expected vote in, votes counted]

Margins are Democrat minus Republican in points. House rows aggregate a county's
district parts into one county total. States reported below the county level
(Massachusetts and the other New England states) are rolled up by county; Alaska,
reported by state house district, is skipped and the page falls back to a state arrow.

Usage:
    python scripts/fetch_counties.py --senate               # Senate races only (35 files)
    python scripts/fetch_counties.py --senate --governor    # plus the 36 governor races
    python scripts/fetch_counties.py --house                # every House race (435 files)

Counties a pull does not return (a failed file, an uncontested or same-party race)
keep their previous row, so coverage only ever grows during the count.
"""
import json, sys, datetime
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

try:
    import requests
except ImportError:  # pragma: no cover
    sys.exit("pip install requests")

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "county-shift.json"
DATE = "2026-11-03"
BASE = f"https://static01.nyt.com/elections-assets/pages/data/{DATE}/"
FEEDS = {"senate": BASE + "results-senate.json", "house": BASE + "results-house.json", "governor": BASE + "results-governor.json"}
UA = {"User-Agent": "2026-House-Projections results bot (github.com/markgsheppard/2026-House-Projections)"}
IND = {"IND", "NPA", "NP", "UNA", "NOL", "NPP", "UNR", "NPD", "CST"}


def fetch(url, timeout=90):
    r = requests.get(url, headers=UA, timeout=timeout)
    r.raise_for_status()
    return r.json()


def party_of(meta):
    p = ((meta or {}).get("party") or {}).get("nyt_id") or ""
    if p in ("DEM", "DFL", "WFP"):
        return "D"
    if p in ("GOP", "REP", "CON"):
        return "R"
    if p in IND:
        return "I"
    return "O"


def unit_sides(unit, cmeta):
    """Best D-side and R-side vote totals in a reporting unit (an independent stands in for a missing Democrat)."""
    best = {}
    for c in unit.get("candidates") or []:
        m = cmeta.get(c.get("nyt_id"), {})
        p = party_of(m)
        if p not in ("D", "R", "I"):
            continue
        v = int(((c.get("votes") or {}).get("total")) or 0)
        if p not in best or v > best[p]:
            best[p] = v
    d = best.get("D", best.get("I")) if "D" in best or "I" in best else None
    r = best.get("R")
    return d, r


def pres_2024(unit, st):
    h = unit.get("historical_comparison_race_data") or {}
    rec = h.get(f"{st}-G-P-2024-11-05")
    if not rec or not isinstance(rec.get("margin"), (int, float)):
        return None, 0
    w = rec.get("votes")
    if not isinstance(w, (int, float)) or w <= 0:
        w = unit.get("total_expected_vote") or unit.get("total_votes") or 0
    return float(rec["margin"]), float(w)


def county_rows(race):
    """{fips5: [d, r, tv, eevp*tv, m24*w, w]} accumulators for one race file."""
    st = race.get("nyt_id", "").split("-")[0]
    cmeta = race.get("candidate_metadata") or {}
    units = [u for u in race.get("reporting_units") or [] if u.get("level") != "state"]
    counties = [u for u in units if u.get("level") == "county"]
    if not counties:  # New England towns and the like: roll everything with a county fips up by county
        counties = [u for u in units if u.get("fips_county")]
    acc = {}
    for u in counties:
        fs, fc = u.get("fips_state"), u.get("fips_county")
        if not fs or not fc:
            continue
        key = f"{int(fs):02d}{int(fc):03d}"
        d, r = unit_sides(u, cmeta)
        if d is None or r is None:
            continue
        tv = int(u.get("total_votes") or 0)
        eevp = u.get("eevp")
        eevp = float(eevp) if isinstance(eevp, (int, float)) else 0.0
        m24, w = pres_2024(u, st)
        a = acc.setdefault(key, [0, 0, 0, 0.0, 0.0, 0.0])
        a[0] += d; a[1] += r; a[2] += tv; a[3] += eevp * max(tv, 1)
        if m24 is not None and w > 0:
            a[4] += m24 * w; a[5] += w
    return acc


def reduce_rows(acc_list):
    """Merge accumulators from several races (House districts in one state) and finish the rows."""
    merged = {}
    for acc in acc_list:
        for k, a in acc.items():
            m = merged.setdefault(k, [0, 0, 0, 0.0, 0.0, 0.0])
            for i in range(6):
                m[i] += a[i]
    rows = {}
    for k, a in merged.items():
        d, r, tv = a[0], a[1], a[2]
        if tv <= 0 or a[5] <= 0:
            continue
        m26 = round((d - r) / tv * 100, 2)
        m24 = round(a[4] / a[5], 2)
        eevp = round(a[3] / max(tv, 1), 1)
        rows[k] = [m26, m24, eevp, tv]
    return rows


def race_file(race):
    url = race.get("url") or ""
    name = url.rsplit("/", 1)[-1]
    if not name.endswith(".html"):
        return None
    return BASE + name[:-5] + ".json"


def pull(chamber):
    feed = fetch(FEEDS[chamber])
    jobs = []
    for race in feed.get("races") or []:
        if race.get("nyt_id", "").startswith("US-"):
            continue
        u = race_file(race)
        if u:
            jobs.append((race["nyt_id"].split("-")[0], u))

    def one(job):
        st, url = job
        try:
            j = fetch(url)
            race = (j.get("races") or [None])[0]
            return st, county_rows(race) if race else None
        except Exception as e:
            print(f"{chamber} {st}: {e}", file=sys.stderr)
            return st, None

    by_state = {}
    with ThreadPoolExecutor(max_workers=8) as ex:
        for st, acc in ex.map(one, jobs):
            if acc is None:
                continue
            by_state.setdefault(st, []).append(acc)
    return {st: reduce_rows(accs) for st, accs in by_state.items()}, len(jobs)


def main():
    want = [c for c in ("senate", "house", "governor") if f"--{c}" in sys.argv] or ["senate"]
    out = {"senate": {}, "house": {}, "governor": {}}
    if OUT.exists():
        try:
            out.update(json.loads(OUT.read_text()))
        except Exception:
            pass
    for chamber in want:
        try:
            rows, n = pull(chamber)
        except Exception as e:
            print(f"{chamber}: feed failed ({e})", file=sys.stderr)
            continue
        if not rows:
            print(f"{chamber}: no county rows; keeping the previous data", file=sys.stderr)
            continue
        # keep every county we already had: a district file that failed this pass, or a county
        # with no two-party race, should not blank out what an earlier pass found
        prev = out.get(chamber) or {}
        for st, old in prev.items():
            merged = dict(old)
            merged.update(rows.get(st, {}))
            rows[st] = merged
        out[chamber] = dict(sorted(rows.items()))
        out[f"{chamber}Updated"] = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
        print(f"{chamber}: {n} race files, {len(rows)} states, {sum(len(v) for v in rows.values())} county rows")
    out["updated"] = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    OUT.write_text(json.dumps(out, separators=(",", ":")) + "\n")
    print(f"wrote {OUT.name}")


if __name__ == "__main__":
    main()
