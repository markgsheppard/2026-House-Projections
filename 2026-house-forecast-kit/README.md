# 2026 House Forecast — Mark G. Sheppard

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
- **Redistricting shift — Plus (points)** — the Plus model's baseline shift (negative = toward Republicans).
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
