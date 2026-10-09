# 2026 House Forecast — Mark G. Sheppard

Now built on REAL district geometry: the 2026 enacted congressional maps (Dave’s Redistricting) for the ten redrawn states (AL, CA, FL, LA, MO, NC, OH, TN, TX, UT) and the latest Census/UCLA boundaries for the other 40. District partisan margins are real (DRA two-party margin for the redrawn states; FiveThirtyEight district lean elsewhere). The slider is the national Democratic vote margin (anchor 0); there is no separate redistricting toggle because the redraws are already in the map. Missouri’s map is subject to a November referendum.

An interactive U.S. House forecast map. Two ways to update it from a spreadsheet.

## The files
- **2026-house-forecast.html** — the standalone page (open in any browser; double-click works).
- **house-polling.xlsx** — your input spreadsheet (edit this to update the forecast).
- **update_forecast.py** — bakes spreadsheet changes into the standalone file.
- **index.html / styles.css / app.js / data.js** — the same page as separate source files.
- **make_template.py** — regenerates a fresh `house-polling.xlsx` from `data.js` (rarely needed).

## What you can edit in house-polling.xlsx
**Inputs** sheet (the blue/yellow cells):
- **Generic ballot (Dem margin, points)** — the national environment; sets where the slider opens. 0–10.
- **Generic ballot source** — text shown in the small-print note under the slider.
- **Data updated (date)** — stamps the "Model run · …" line. Leave blank to use the file's save date.

**Districts** sheet (optional) — one row per district. Edit any `Margin (Dem +)` to drop in a
district-level poll. Margin is the projected Democratic two-party margin at the D+6.5 baseline
(negative = Republican); the slider then swings the whole map around it.

## Method 1 — no terminal (fastest)
1. Edit and save **house-polling.xlsx**.
2. Open **2026-house-forecast.html**.
3. Below the map there's a small **update · download** control. Click **update** and pick your file —
   the map, seat counts, slider, notes, and the "Model last run on …" line all refresh instantly.
   Click **download** anytime to export the data currently driving the map as a fresh
   `house-polling.xlsx` (same layout), so you can tweak it and re-upload.

(This updates what you're viewing. To save a shareable copy with the new numbers baked in, use Method 2.)

## Method 2 — bake it into the file (shareable)
From this folder, run:

    python update_forecast.py

This reads `house-polling.xlsx`, rewrites `data.js`, and rebuilds `2026-house-forecast.html`
with the new numbers and an auto-stamped date. Requires Python with `openpyxl`
(`pip install openpyxl`).

## Notes
- Internet is needed the first time you open the page (it loads D3, TopoJSON and SheetJS from a CDN).
- Forecast figures are illustrative, calibrated to the generic-ballot environment you set.
- Boundaries are the most recent complete national base available (2016 lines + PA-2018 / NC-2020 /
  NJ-2022 court maps); the 2025–26 mid-decade redraws are reflected in the projections, not the lines.


## Mail-In Access
The **Mail-In Access** slider models mail-voting restrictions as a *non-uniform* Democratic turnout drag:

`shock(state) = severity x 2024 mail share x mail Dem-skew`

- **2024 mail share** — real, from the U.S. Election Assistance Commission (some smaller states estimated).
- **mail Dem-skew** — how much more Democratic the marginal mail voter is; largest where mail is optional (voters self-select and Democrats mail more), ~0 where everyone already votes by mail.
- **severity** — the page slider (0 = full access). The readout shows the national Democratic margin it costs.

Effect concentrates in moderate-mail swing states (PA, MI, NV, WI, AZ); universal-mail states (CA, CO, WA, OR, UT) barely move because there is no partisan differential to lose. The per-state assumptions live in the **Mail-In** sheet of house-polling.xlsx for transparency. Grounded in the real 2025-26 USPS Federal Ballot Mail Portal rule (blocked, pending Supreme Court). **Illustrative** — the direction is well-grounded; the magnitudes are assumptions.


## Simulated outcomes (Monte Carlo)
Below the battlegrounds, a 40,000-run Monte Carlo draws a national vote around an expected margin (with an uncertainty slider) and applies it across all 435 real district margins, adding seat-level noise, to produce a distribution of Democratic seat totals. Bars are blue at/above 218 (majority) and red below; readouts show the majority probability, median seats, and the 80% interval. Runs entirely in-browser (~3 ms/run) on the same data as the map. Illustrative.


## Controls row (top)
Generic ballot · Mail-In Access · Fundamentals (formerly "Economic Parameter") · Historical polling bias · polling sparkline.
- **Historical polling bias** is an Off/On toggle (it replaces Standard/Plus). On applies a uniform 2.9-point shift toward
  Republicans to every race, the average recent polling error in Democrats' favor (`pollBias` in data.js). Also in the simulator.
- **Polling sparkline** smooths the individual generic-ballot polls in the **Polls** sheet (Pollster, Start date, End date, Dem %, Rep %)
  with a two-week kernel; the light band is ±1 SD. **Undecided** = average share choosing neither party in polls from the last
  three weeks, excluding forced-choice polls (D + R ≥ 98). Hover the sparkline for the average, spread and recent polls on any date.
  Add new polls to the Polls sheet and use update or update_forecast.py.

## Tooltip trend lines
Each district/state tooltip shows the presidential margin (Dem % − Rep %) for 2008–2024, then a dashed segment to this race's
2026 projected margin (a hollow dot), which moves with the polling and every control. Blue above zero, red below.
Districts: The Downballot's calculations on the 2026 lines for 2024 (and 2020 where available; otherwise 2020 is spliced from the
2024-line figures); 2008–2016 come from each district's geographic predecessor, shifted to match the 2020 figure on current lines,
so they show the area's trend rather than exact results on today's boundaries. States: FiveThirtyEight election-results data.

## Data refresh — Oct. 9, 2026
- Generic ballot D +8.9 (Silver Bulletin, Oct. 8); 79 generic-ballot polls, July 9 – Oct. 5 (RealClearPolling).
- Senate win probabilities and ratings: Decision Desk HQ / The Hill forecast, Oct. 9.
- Fundamentals: BLS state unemployment, Aug. 2026, plus CPI-U 12-month inflation, Aug. 2026 (3.4%).
