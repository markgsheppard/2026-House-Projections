/* =========================================================================
   2026 House Forecast — rendering & interaction
   Depends on: d3 v7, topojson v3, window.HOUSE_DATA (data.js)
   ========================================================================= */
(function () {
  "use strict";

  const DATA = window.HOUSE_DATA;
  if (!DATA) { console.error("HOUSE_DATA missing"); return; }

  const { districts, states, forecast, meta } = DATA;

  /* ---- model -----------------------------------------------------------
     National environment is a uniform swing on every district's margin,
     anchored at the slider's Democratic generic-ballot margin (default 6.5).
     'plus' adds the 2025-26 redistricting as a baseline shift: the whole
     seats-votes curve is translated toward Republicans (~3.3 pts), which at
     the default environment converts the most marginal Democratic seats and
     moves the chamber by ~10 seats. */
  let mode = "standard";
  const ANCHOR = 6.5;                 // base map is calibrated to D+6.5
  let genericBallot = (typeof meta.genericBallot === "number") ? meta.genericBallot : 6.5;
  let REDISTRICT_SHIFT = (typeof meta.redistrictShift === "number") ? meta.redistrictShift : -3.3;
  const SIGMA = 3.5;
  const logistic = (m, s) => 1 / (1 + Math.exp(-m / s));

  // effective per-district numbers for the active environment + mode
  function effective(d) {
    const swing = (genericBallot - ANCHOR) + (mode === "plus" ? REDISTRICT_SHIFT : 0);
    const margin = d.margin + swing;
    return {
      margin,
      demProb: Math.max(0.002, Math.min(0.998, logistic(margin, SIGMA))),
      party: margin >= 0 ? "D" : "R"
    };
  }

  // tipping-point district for the active environment (recomputed on change)
  function computeTipping() {
    const ranked = Object.values(forecast)
      .map(f => ({ code: f.code, ...effective(f) }))
      .sort((a, b) => b.margin - a.margin);     // most D -> most R
    let d = 0; ranked.forEach(e => { if (e.party === "D") d++; });
    return d >= ranked.length - d
      ? ranked[217]?.code
      : ranked[ranked.length - 218]?.code;
  }
  let currentTip = computeTipping();

  /* ---- diverging color scale (matches the legend gradient) ------------- */
  // domain in margin points: R-deep .. neutral .. D-deep
  const css = getComputedStyle(document.documentElement);
  const C = (n) => css.getPropertyValue(n).trim();
  const colorStops = [
    [-32, C("--gop-deep") || "#cf3115"],
    [-9,  C("--gop")      || "#f2553c"],
    [-1.5,"#f9cdc2"],
    [0,   "#f1efec"],
    [1.5, "#c8ddfa"],
    [9,   C("--dem")      || "#2f80ed"],
    [32,  C("--dem-deep") || "#1657c9"]
  ];
  const colorScale = d3.scaleLinear()
    .domain(colorStops.map(s => s[0]))
    .range(colorStops.map(s => s[1]))
    .interpolate(d3.interpolateRgb)
    .clamp(true);

  /* ---- build geographies ----------------------------------------------- */
  const allDistricts = topojson.feature(districts, districts.objects.districts).features
    .filter(f => forecast[f.id]);                 // 50 states + DC only

  const fc = { type: "FeatureCollection", features: allDistricts };

  const W = 960, H = 600;
  const projection = d3.geoAlbersUsa().fitSize([W, H], fc);
  const path = d3.geoPath(projection);

  const svg = d3.select("#map");
  const gDist = svg.append("g").attr("class", "districts");
  const gState = svg.append("g").attr("class", "states");
  const gHi = svg.append("g").attr("class", "highlight"); // lifted hover copy

  const paths = gDist.selectAll("path")
    .data(allDistricts, d => d.id)
    .join("path")
    .attr("class", d => "district" + (forecast[d.id].code === currentTip ? " tipping" : ""))
    .attr("d", path)
    .attr("fill", d => colorScale(effective(forecast[d.id]).margin));

  // state border mesh on top (its own topology)
  const stateMesh = topojson.mesh(states, states.objects.states, (a, b) => a !== b);
  const stateOuter = topojson.mesh(states, states.objects.states, (a, b) => a === b);
  gState.append("path").attr("class", "state-border").attr("d", path(stateMesh));
  gState.append("path").attr("class", "state-border").attr("d", path(stateOuter));

  /* ---- tooltip --------------------------------------------------------- */
  const tooltip = document.getElementById("tooltip");
  const stage = document.getElementById("stage");

  function fmtMargin(m) {
    const party = m >= 0 ? "D" : "R";
    const v = Math.abs(m);
    return `${party}+${v < 0.05 ? "0.0" : v.toFixed(1)}`;
  }

  function showTip(evt, d) {
    const f = forecast[d.id];
    const e = effective(f);
    const dp = Math.round(e.demProb * 100);
    const rp = 100 - dp;
    const isTip = f.code === currentTip;
    tooltip.innerHTML =
      `<div class="t-code">${f.code}</div>
       <div class="t-row"><span>Projected margin</span><b>${fmtMargin(e.margin)}</b></div>
       <div class="t-bar"><i style="width:${rp}%;background:var(--gop)"></i><i style="width:${dp}%;background:var(--dem)"></i></div>
       <div class="t-row"><span style="color:#f7a99b">GOP hold</span><b>${rp}%</b></div>
       <div class="t-row"><span style="color:#a6c8f6">DEM hold</span><b>${dp}%</b></div>
       ${isTip ? `<div class="t-tip">Tipping-point district</div>` : ``}`;
    tooltip.classList.add("on");
    tooltip.setAttribute("aria-hidden", "false");
    moveTip(evt);
    stage.classList.add("dim");
    // draw a white-outlined copy on top of the state borders (no black edge)
    gHi.selectAll("*").remove();
    gHi.append("path")
      .attr("d", path(d))
      .attr("fill", colorScale(e.margin))
      .attr("class", "district hot");
  }
  function moveTip(evt) {
    const pad = 16, tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
    let x = evt.clientX + pad, y = evt.clientY + pad;
    if (x + tw > window.innerWidth - 8) x = evt.clientX - tw - pad;
    if (y + th > window.innerHeight - 8) y = evt.clientY - th - pad;
    tooltip.style.left = x + "px";
    tooltip.style.top = y + "px";
  }
  function hideTip() {
    tooltip.classList.remove("on");
    tooltip.setAttribute("aria-hidden", "true");
    stage.classList.remove("dim");
    gHi.selectAll("*").remove();
  }
  paths.on("mouseenter", showTip).on("mousemove", moveTip).on("mouseleave", hideTip);

  /* ---- topline + gauge + verdict --------------------------------------- */
  const elDem = document.getElementById("dem-seats");
  const elGop = document.getElementById("gop-seats");
  const elGD = document.getElementById("gauge-d");
  const elGR = document.getElementById("gauge-r");
  const elVerdict = document.getElementById("verdict");

  function tally() {
    let d = 0, r = 0;
    for (const id in forecast) (effective(forecast[id]).party === "D") ? d++ : r++;
    return { d, r, total: d + r };
  }

  function tweenNumber(el, to) {
    const from = +el.textContent || 0;
    const t0 = performance.now(), dur = 650;
    (function step(now) {
      const k = Math.min(1, (now - t0) / dur);
      const e = 1 - Math.pow(1 - k, 3);
      el.textContent = Math.round(from + (to - from) * e);
      if (k < 1) requestAnimationFrame(step);
    })(performance.now());
  }

  function renderTopline(animate = true) {
    const { d, r, total } = tally();
    if (animate) { tweenNumber(elDem, d); tweenNumber(elGop, r); }
    else { elDem.textContent = d; elGop.textContent = r; }
    elGD.style.width = (100 * d / total) + "%";
    elGR.style.width = (100 * r / total) + "%";
    const leadParty = d >= r ? "Democrats" : "Republicans";
    const cls = d >= r ? "lead-d" : "lead-r";
    const verb = (d === r) ? "are tied for" : "are favored to win";
    elVerdict.innerHTML =
      `<span class="${cls}">${leadParty}</span> ${verb} the House`;
  }

  /* ---- battlegrounds --------------------------------------------------- */
  const bgWrap = document.getElementById("battlegrounds");
  function renderBattlegrounds() {
    const rows = Object.keys(forecast).map(id => {
      const f = forecast[id]; const e = effective(f);
      return { code: f.code, margin: e.margin, demProb: e.demProb };
    }).sort((a, b) => Math.abs(a.margin) - Math.abs(b.margin)).slice(0, 24);

    bgWrap.innerHTML = rows.map(r => {
      const dp = Math.round(r.demProb * 100), rp = 100 - dp;
      const partyCls = r.margin >= 0 ? "d" : "r";
      const leadProb = Math.max(dp, rp);
      const isTip = r.code === currentTip;
      return `<div class="bg-cell${isTip ? " tipping" : ""}">
        <div class="bg-code">${r.code}</div>
        <div class="bg-margin ${partyCls}">${fmtMargin(r.margin)}</div>
        <div class="bg-prob">${leadProb}% to hold</div>
        <div class="bg-meter"><i style="width:${rp}%;background:var(--gop)"></i><i style="width:${dp}%;background:var(--dem)"></i></div>
      </div>`;
    }).join("");
  }

  /* ---- recolor map ----------------------------------------------------- */
  function recolor(animate = true) {
    const sel = animate ? paths.transition().duration(450) : paths;
    sel.attr("fill", d => colorScale(effective(forecast[d.id]).margin));
    paths.attr("class", d =>
      "district" + (forecast[d.id].code === currentTip ? " tipping" : ""));
  }

  const gbVal = document.getElementById("gb-val");
  function fmtGB(v) {
    if (v <= 0.05) return "Even";
    return "D +" + (Math.abs(v - Math.round(v)) < 0.05 ? Math.round(v) : v.toFixed(1));
  }
  function render(animate = true) {
    currentTip = computeTipping();
    if (gbVal) gbVal.textContent = fmtGB(genericBallot);
    recolor(animate);
    renderTopline(animate);
    renderBattlegrounds();
  }

  /* ---- generic-ballot slider ------------------------------------------ */
  const gbSlider = document.getElementById("gb-slider");
  if (gbSlider) {
    gbSlider.min = "0"; gbSlider.max = "10"; gbSlider.step = "0.1";
    gbSlider.value = String(genericBallot);
    gbSlider.addEventListener("input", () => {
      genericBallot = +gbSlider.value;
      render(false);             // instant, smooth while dragging
    });
  }

  /* ---- model switching ------------------------------------------------- */
  const modeNav = document.getElementById("modes");
  modeNav.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-mode]");
    if (!btn) return;
    mode = btn.dataset.mode;
    modeNav.querySelectorAll("button").forEach(b =>
      b.setAttribute("aria-selected", b === btn ? "true" : "false"));
    render(true);
  });

  /* ---- meta-driven text (refreshes whenever data changes) -------------- */
  const frozenEl  = document.getElementById("frozen");
  const stampEl   = document.getElementById("shapefile-stamp");
  const ballotNote = document.getElementById("ballot-note");
  const footnoteEl = document.getElementById("footnote");
  const techEl    = document.getElementById("tech-method");
  const boundaryEl = document.getElementById("boundary-note");
  function signed(n) { return (n >= 0 ? "+" : "\u2212") + Math.abs(n); }
  function refreshMetaText() {
    if (frozenEl) frozenEl.textContent = "Model last run on " + (meta.dataUpdated || "");
    if (stampEl)  stampEl.textContent  = meta.shapefileNote || "";
    if (ballotNote) ballotNote.textContent =
      "Opens at " + fmtGB(genericBallot) + " \u2014 " + (meta.gbSource || "generic-ballot average") +
      " as of " + (meta.dataUpdated || "") + "; drag to apply a uniform national swing.";
    if (footnoteEl) footnoteEl.textContent = meta.note || "";
    if (boundaryEl && meta.boundaryNote) boundaryEl.textContent = meta.boundaryNote;
    if (techEl) techEl.textContent =
      "Method — a uniform national swing is applied to every district\u2019s baseline margin, " +
      "anchored at D +" + ANCHOR + " (the slider\u2019s opening value). Win probabilities use a " +
      "logistic function (\u03c3 = " + SIGMA + " points). The tipping-point district is the 218th seat " +
      "when districts are ranked from most Democratic to most Republican. The Plus model adds the " +
      "2025\u201326 mid-decade redistricting as a baseline shift of " + signed(REDISTRICT_SHIFT) +
      " points (negative = toward Republicans). Generic-ballot input: " + fmtGB(genericBallot) +
      " (" + (meta.gbSource || "n/a") + ", " + (meta.dataUpdated || "n/a") + "). Figures are illustrative. " +
      "Election: Nov. 3, 2026; current House: Republican 220, Democratic 213.";
  }

  /* ---- spreadsheet loader (no terminal needed) ------------------------- */
  // code -> district id, for matching rows from the Districts sheet
  const codeToId = {};
  for (const id in forecast) codeToId[forecast[id].code.toUpperCase()] = id;

  function applyWorkbook(wb, file) {
    // Inputs sheet: scan first column for labels, read value in 2nd column
    const inputs = wb.Sheets["Inputs"] || wb.Sheets[wb.SheetNames[0]];
    let foundDate = false;
    if (inputs) {
      const rows = XLSX.utils.sheet_to_json(inputs, { header: 1, blankrows: false });
      for (const r of rows) {
        const label = String(r[0] ?? "").toLowerCase();
        const val = r[1];
        if (val === undefined || val === "") continue;
        if (label.includes("generic ballot") && !label.includes("source")) {
          const n = parseFloat(val); if (!isNaN(n)) genericBallot = Math.max(0, Math.min(10, n));
        } else if (label.includes("redistrict") || label.includes("shift")) {
          const n = parseFloat(val); if (!isNaN(n)) REDISTRICT_SHIFT = n;
        } else if (label.includes("source")) {
          meta.gbSource = String(val);
        } else if (label.includes("updated") || label.includes("date")) {
          meta.dataUpdated = formatDate(val); foundDate = true;
        }
      }
    }
    // Districts sheet: header row, then [code, margin]
    const dists = wb.Sheets["Districts"];
    if (dists) {
      const rows = XLSX.utils.sheet_to_json(dists, { header: 1, blankrows: false });
      let applied = 0;
      for (const r of rows) {
        const code = String(r[0] ?? "").trim().toUpperCase();
        const m = parseFloat(r[1]);
        if (codeToId[code] && !isNaN(m)) { forecast[codeToId[code]].margin = m; applied++; }
      }
      console.log("district overrides applied:", applied);
    }
    // if no explicit date in the sheet, stamp with the file's modified time
    if (file && !foundDate) {
      meta.dataUpdated = formatDate(new Date(file.lastModified));
    }
    if (gbSlider) gbSlider.value = String(genericBallot);
    refreshMetaText();
    render(true);
    flash("Updated from " + (file ? file.name : "spreadsheet") + " \u2014 " + meta.dataUpdated);
  }

  function formatDate(v) {
    let d;
    if (v instanceof Date) d = v;
    else if (typeof v === "number") d = new Date(Math.round((v - 25569) * 86400 * 1000)); // Excel serial
    else { const p = new Date(v); d = isNaN(p) ? null : p; }
    if (!d || isNaN(d)) return String(v);
    return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  }

  const fileInput = document.getElementById("xlsx-input");
  const loadBtn = document.getElementById("load-xlsx");
  if (loadBtn && fileInput) {
    loadBtn.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => {
      const file = fileInput.files[0]; if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const wb = XLSX.read(new Uint8Array(ev.target.result), { type: "array" });
          applyWorkbook(wb, file);
        } catch (err) { console.error(err); flash("Could not read that file."); }
      };
      reader.readAsArrayBuffer(file);
    });
  }

  /* ---- download the current data as a spreadsheet (same schema) -------- */
  const downloadBtn = document.getElementById("download-xlsx");
  if (downloadBtn) {
    downloadBtn.addEventListener("click", () => {
      const inputs = [
        ["Setting", "Value", "Notes"],
        ["Generic ballot (Dem margin, points)", genericBallot, "National House popular-vote margin; sets the slider start."],
        ["Redistricting shift \u2014 Plus (points)", REDISTRICT_SHIFT, "Plus baseline shift; negative = toward Republicans."],
        ["Generic ballot source", meta.gbSource || "", "Shown in the note under the slider."],
        ["Data updated (date)", meta.dataUpdated || "", "Stamps the model-run line; blank = file save date."]
      ];
      const dist = [["District", "Margin (Dem +)", "State"]];
      Object.values(forecast)
        .sort((a, b) => a.code.localeCompare(b.code))
        .forEach(f => dist.push([f.code, Math.round(f.margin * 10) / 10, f.state]));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(inputs), "Inputs");
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(dist), "Districts");
      XLSX.writeFile(wb, "house-polling.xlsx");
      flash("Downloaded current data \u2014 house-polling.xlsx");
    });
  }

  const flashEl = document.getElementById("flash");
  let flashTimer;
  function flash(msg) {
    if (!flashEl) return;
    flashEl.textContent = msg; flashEl.classList.add("on");
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => flashEl.classList.remove("on"), 4000);
  }

  /* ---- first paint ----------------------------------------------------- */
  refreshMetaText();
  render(true);
})();
