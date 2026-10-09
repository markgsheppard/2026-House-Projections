/* =========================================================================
   2026 House Forecast - rendering & interaction
   Depends on: d3 v7, topojson v3, window.HOUSE_DATA (data.js)
   ========================================================================= */
(function () {
  "use strict";

  const DATA = window.HOUSE_DATA;
  if (!DATA) { console.error("HOUSE_DATA missing"); return; }

  const { districts, forecast, mail, meta } = DATA;

  /* ---- model -----------------------------------------------------------
     Base margins are each district's lean at an even national vote, so the
     generic-ballot slider IS the national Democratic margin (anchor 0).
     Mail-In Access models restricting mail voting as a non-uniform Democratic
     turnout drag, shock = severity x 2024 mail share x mail Dem-skew, applied
     per state; Historical polling bias is a uniform correction (see footer). */
  const ANCHOR = (typeof meta.anchor === "number") ? meta.anchor : 0;
  let genericBallot = (typeof meta.genericBallot === "number") ? meta.genericBallot : 7.5;
  const MAIL = mail || {};
  const ECON = DATA.econ || {};                 // { ST: { m: misery index, g: governor party } }
  const ECON_THRESH = (typeof meta.econThreshold === "number") ? meta.econThreshold : 7.5;
  const ECON_MAX = (typeof meta.econMax === "number") ? meta.econMax : 1.5;
  let mailDrag = 0;                     // target national Dem-margin drag, points (0..5)
  let econLevel = 0;                    // Fundamentals slider, 0..100
  const POLLBIAS = (typeof meta.pollBias === "number") ? meta.pollBias : 2.9; // historical average D-favoring polling error (reference)
  let biasPts = 0;                      // Historical polling bias toggle: 0 (off) or POLLBIAS (on), points toward Republicans
  const SIGMA = 3.5;
  const logistic = (m, s) => 1 / (1 + Math.exp(-m / s));

  // Fundamentals: in a state whose misery index is above the threshold,
  // scale up to ECON_MAX points against the party holding that governorship.
  function econShock(stateCode) {
    const e = ECON[stateCode];
    if (!e || e.m <= ECON_THRESH) return 0;
    return (e.g === "D" ? -1 : 1) * (econLevel / 100) * ECON_MAX;
  }

  // average of (share x skew) across districts, so the slider reads in points
  let MAILK = 1;
  { let s = 0, n = 0;
    for (const id in forecast) { const m = MAIL[forecast[id].state]; if (m) s += m.share * m.skew; n++; }
    MAILK = n ? s / n : 1; }

  function mailShock(stateCode) {
    const m = MAIL[stateCode]; if (!m || MAILK <= 0) return 0;
    return -(mailDrag / MAILK) * m.share * m.skew;   // per-state, points off the Dem margin
  }
  function nationalDrag() {
    let sum = 0, n = 0;
    for (const id in forecast) { sum += mailShock(forecast[id].state); n++; }
    return n ? sum / n : 0;
  }

  // effective per-district numbers: generic ballot + Mail-In Access + Fundamentals,
  // less a uniform historical polling-bias correction.
  function effective(d) {
    const bias = -biasPts;
    const margin = d.margin + (genericBallot - ANCHOR) + mailShock(d.state) + econShock(d.state) + bias;
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
    [-40, "#b62d2d"],
    [-22, "#d43d34"],
    [-9,  "#ec5a44"],
    [-2,  "#f6c4bb"],
    [0,   "#f4f2f2"],
    [2,   "#a9c9f2"],
    [9,   "#2e74d0"],
    [22,  "#0d52bd"],
    [40,  "#08306b"]
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

  // state borders derived from the districts topology (adjacent districts in
  // different states), plus the national outline
  const stateMesh = topojson.mesh(districts, districts.objects.districts,
    (a, b) => a.properties.st !== b.properties.st);
  const stateOuter = topojson.mesh(districts, districts.objects.districts, (a, b) => a === b);
  gState.append("path").attr("class", "state-border").attr("d", path(stateMesh));
  gState.append("path").attr("class", "state-border").attr("d", path(stateOuter));

  /* ---- Senate view (state-level, same methodology) --------------------- */
  let chamber = "house";
  const SEN_MU0 = (typeof meta.genericBallot === "number") ? meta.genericBallot : 7.5;
  const SEN_KSD = Math.sqrt(6 * 6 + 6 * 6);           // national + race sd (matches the simulator)
  const SEN_NOTUP_D = (typeof meta.senateNotUpD === "number") ? meta.senateNotUpD : 34;
  const SEN_WINLINE = (typeof meta.senateWin === "number") ? meta.senateWin : 51;
  const senByState = {}; (meta.senate || []).forEach(rc => senByState[rc.st] = rc);
  const senTipState = (function () {
    const s = (meta.senate || []).slice().sort((a, b) => b.p - a.p);
    const i = SEN_WINLINE - SEN_NOTUP_D - 1;
    return (i >= 0 && i < s.length) ? s[i].st : "";
  })();
  // standard normal CDF (Zelen & Severo) so a race reproduces its stored win prob
  function normCdf(z) {
    const t = 1 / (1 + 0.2316419 * Math.abs(z)), d = 0.3989423 * Math.exp(-z * z / 2);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return z > 0 ? 1 - p : p;
  }
  function senMargin(st) {
    const rc = senByState[st]; if (!rc) return null;
    const base = SEN_KSD * probit(rc.p);              // race margin at the reference environment
    const bias = -biasPts;
    return base + (genericBallot - SEN_MU0) + mailShock(st) + econShock(st) + bias;
  }
  function senProb(m) { return Math.max(0.002, Math.min(0.998, normCdf(m / SEN_KSD))); }
  const SEN_NOTUP = meta.senateNotUp || {};        // { ST: 'D' | 'R' | 'split' } for the 15 states not on the ballot
  const SEN_NOTUP_LEAN = meta.senateNotUpLean || {}; // composite lean (Senate + governor + legislature), coloring only
  function senColor(st) {
    const m = senMargin(st);
    if (m !== null) return colorScale(m);            // race up: color by forecast margin
    if (st in SEN_NOTUP_LEAN) return colorScale(SEN_NOTUP_LEAN[st]);   // not up: composite partisan tilt
    return "#e6e7e9";
  }

  // merge districts into state polygons
  const stGeoms = {};
  districts.objects.districts.geometries.forEach(g => {
    const st = g.properties.st; if (!st) return;
    (stGeoms[st] = stGeoms[st] || []).push(g);
  });
  const stateFeatures = Object.keys(stGeoms).map(st => ({
    type: "Feature", id: st, geometry: topojson.merge(districts, stGeoms[st])
  }));
  const gSenate = svg.append("g").attr("class", "senate-states");
  gSenate.lower();                                     // sit beneath the state borders
  gSenate.style("display", "none");
  const senatePaths = gSenate.selectAll("path")
    .data(stateFeatures, d => d.id).join("path")
    .attr("class", "senate-state")
    .attr("d", path)
    .attr("fill", d => senColor(d.id));

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
       <div class="t-row"><span style="color:var(--gop)">GOP hold</span><b>${rp}%</b></div>
       <div class="t-row"><span style="color:var(--dem)">DEM hold</span><b>${dp}%</b></div>
       ${isTip ? `<div class="t-tip">Tipping-point district</div>` : ``}
       ${histSpark((HIST.district || {})[f.code], e.margin)}`;
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

  function showSenTip(evt, d) {
    const st = d.id, rc = senByState[st];
    if (!rc) {
      const g = SEN_NOTUP[st];
      const held = g === "D" ? "2 Democrats" : g === "R" ? "2 Republicans" : "Split delegation";
      tooltip.innerHTML = `<div class="t-code">${st}</div>
        <div class="t-row"><span>Not up in 2026</span><b></b></div>
        <div class="t-row"><span>Held by</span><b>${held}</b></div>
        ${histSpark((HIST.state || {})[st])}`;
    } else {
      const m = senMargin(st), dp = Math.round(senProb(m) * 100), rp = 100 - dp;
      const isTip = st === senTipState;
      tooltip.innerHTML = `<div class="t-code">${st}</div>
        <div class="t-row"><span>Projected margin</span><b>${fmtMargin(m)}</b></div>
        <div class="t-bar"><i style="width:${rp}%;background:var(--gop)"></i><i style="width:${dp}%;background:var(--dem)"></i></div>
        <div class="t-row"><span style="color:var(--gop)">GOP win</span><b>${rp}%</b></div>
        <div class="t-row"><span style="color:var(--dem)">DEM win</span><b>${dp}%</b></div>
        <div class="t-row"><span>Held by</span><b>${rc.held === "D" ? "Democrat" : "Republican"}</b></div>
        ${isTip ? `<div class="t-tip">Tipping-point seat</div>` : ``}
        ${histSpark((HIST.state || {})[st], m)}`;
    }
    tooltip.classList.add("on");
    tooltip.setAttribute("aria-hidden", "false");
    moveTip(evt);
    stage.classList.add("dim");
    gHi.selectAll("*").remove();
    gHi.append("path").attr("d", path(d)).attr("fill", senColor(st)).attr("class", "senate-state hot");
  }
  senatePaths.on("mouseenter", showSenTip).on("mousemove", moveTip).on("mouseleave", hideTip);

  /* ---- history sparklines for the tooltip ------------------------------ */
  // Presidential margin over time; the line is blue above zero, red below.
  const HIST = DATA.hist || {};
  const HYEARS = HIST.years || [2008, 2012, 2016, 2020, 2024];
  let sparkSeq = 0;
  // series: presidential margins by HYEARS; proj: this race's 2026 projected margin
  // (moves with the polling and every slider), drawn as the final point.
  function histSpark(series, proj) {
    const hasProj = typeof proj === "number" && isFinite(proj);
    if (!series || series.filter(v => v != null).length + (hasProj ? 1 : 0) < 2) return "";
    const YRS = HYEARS.concat(hasProj ? [2026] : []);
    const W = 176, H = 42, pl = 3, pr = 5, pt = 5, pb = 5;
    const pts = series.map((v, i) => v == null ? null : [HYEARS[i], v]).filter(Boolean);
    const all = pts.map(p => p[1]).concat(hasProj ? [proj] : []);
    const lo = Math.min(-4, ...all) - 2, hi = Math.max(4, ...all) + 2;
    const x0 = YRS[0], x1 = YRS[YRS.length - 1];
    const x = yr => pl + (yr - x0) * (W - pl - pr) / (x1 - x0);
    const y = v => pt + (hi - v) * (H - pt - pb) / (hi - lo);
    const y0 = y(0).toFixed(1);
    const P = (yr, v) => x(yr).toFixed(1) + "," + y(v).toFixed(1);
    const d = pts.map((p, k) => (k ? "L" : "M") + P(p[0], p[1])).join("");
    const last = pts[pts.length - 1];
    const dProj = (hasProj && last) ? "M" + P(last[0], last[1]) + "L" + P(2026, proj) : "";
    const id = "hs" + (++sparkSeq);
    const col = v => v >= 0 ? "var(--dem)" : "var(--gop)";
    const dots = pts.map(p => `<circle cx="${x(p[0]).toFixed(1)}" cy="${y(p[1]).toFixed(1)}" r="1.7" fill="${col(p[1])}"/>`).join("");
    const projDot = hasProj ? `<circle cx="${x(2026).toFixed(1)}" cy="${y(proj).toFixed(1)}" r="3" fill="#fff" stroke="${col(proj)}" stroke-width="1.6"/>` : "";
    const clip = (path, dash) => `<path d="${path}" fill="none" stroke="var(--dem)" stroke-width="1.6" stroke-linejoin="round"${dash} clip-path="url(#${id}a)"/>` +
                                 `<path d="${path}" fill="none" stroke="var(--gop)" stroke-width="1.6" stroke-linejoin="round"${dash} clip-path="url(#${id}b)"/>`;
    const head = hasProj
      ? `<span>Partisan lean, ${YRS[0]}–2026</span><span>${fmtMargin(proj)} in 2026</span>`
      : `<span>Presidential margin</span><span>${fmtMargin(last[1])} in ${last[0]}</span>`;
    return `<div class="t-spark">
      <div class="t-spark-h">${head}</div>
      <svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true">
        <defs>
          <clipPath id="${id}a"><rect x="0" y="0" width="${W}" height="${y0}"/></clipPath>
          <clipPath id="${id}b"><rect x="0" y="${y0}" width="${W}" height="${(H - y0).toFixed(1)}"/></clipPath>
        </defs>
        <line x1="0" x2="${W}" y1="${y0}" y2="${y0}" stroke="#c8ccd1" stroke-width="1" stroke-dasharray="2 2"/>
        ${clip(d, "")}${dProj ? clip(dProj, ' stroke-dasharray="3 2"') : ""}
        ${dots}${projDot}
      </svg>
      <div class="t-spark-x"><span>${YRS[0]}</span><span>${hasProj ? "pres. results · 2026 forecast" : ""}</span><span>${x1}</span></div>
    </div>`;
  }

  /* ---- generic-ballot polling sparkline + undecided --------------------- */
  const POLLS = (DATA.polls || []).map(p => {
    const s0 = Date.parse(p[1]), e0 = Date.parse(p[2]);
    return { who: p[0], t: (s0 + e0) / 2, end: e0, d: +p[3], r: +p[4] };
  }).filter(p => isFinite(p.t) && isFinite(p.d) && isFinite(p.r)).sort((a, b) => a.t - b.t);
  const DAY = 864e5;
  function smoothPolls() {
    if (POLLS.length < 3) return [];
    const bw = 7 * DAY, t0 = POLLS[0].t, t1 = POLLS[POLLS.length - 1].t, out = [];
    for (let t = t0; t <= t1 + 1; t += DAY) {
      let w = 0, sd = 0, sr = 0;
      const ws = POLLS.map(p => Math.exp(-0.5 * Math.pow((t - p.t) / bw, 2)));
      POLLS.forEach((p, i) => { w += ws[i]; sd += ws[i] * p.d; sr += ws[i] * p.r; });
      const md = sd / w, mr = sr / w;
      let vd = 0, vr = 0;
      POLLS.forEach((p, i) => { vd += ws[i] * (p.d - md) ** 2; vr += ws[i] * (p.r - mr) ** 2; });
      out.push({ t, d: md, r: mr, sdd: Math.sqrt(vd / w), sdr: Math.sqrt(vr / w) });
    }
    return out;
  }
  function undecidedShare() {
    if (!POLLS.length) return null;
    const last = POLLS[POLLS.length - 1].end;
    const rec = POLLS.filter(p => p.end >= last - 21 * DAY && p.d + p.r < 98);   // skip forced-choice polls
    if (!rec.length) return null;
    return rec.reduce((a, p) => a + (100 - p.d - p.r), 0) / rec.length;
  }
  let pollSpark = null;
  function renderPollSpark() {
    const svgEl = document.getElementById("poll-svg"), wrap = document.getElementById("poll-spark");
    if (!svgEl || !wrap) return;
    const sm = smoothPolls();
    if (!sm.length) { wrap.style.display = "none"; return; }
    const W = 180, H = 44, pad = 2;
    let lo = Infinity, hi = -Infinity;
    sm.forEach(p => { lo = Math.min(lo, p.r - p.sdr, p.d - p.sdd); hi = Math.max(hi, p.d + p.sdd, p.r + p.sdr); });
    const t0 = sm[0].t, t1 = sm[sm.length - 1].t;
    const x = t => pad + (t - t0) / ((t1 - t0) || 1) * (W - 2 * pad);
    const y = v => pad + (hi - v) / ((hi - lo) || 1) * (H - 2 * pad);
    const line = k => sm.map((p, i) => (i ? "L" : "M") + x(p.t).toFixed(1) + "," + y(p[k]).toFixed(1)).join("");
    const band = (k, sk) => sm.map((p, i) => (i ? "L" : "M") + x(p.t).toFixed(1) + "," + y(p[k] + p[sk]).toFixed(1)).join("") +
      sm.slice().reverse().map(p => "L" + x(p.t).toFixed(1) + "," + y(p[k] - p[sk]).toFixed(1)).join("") + "Z";
    svgEl.innerHTML =
      `<path d="${band("r", "sdr")}" fill="var(--gop)" opacity=".09"/>` +
      `<path d="${band("d", "sdd")}" fill="var(--dem)" opacity=".09"/>` +
      `<path d="${line("r")}" fill="none" stroke="var(--gop)" stroke-width="1.5" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>` +
      `<path d="${line("d")}" fill="none" stroke="var(--dem)" stroke-width="1.5" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>` +
      `<line class="ps-guide" x1="0" x2="0" y1="0" y2="${H}" stroke="#9aa0a8" stroke-width="1" vector-effect="non-scaling-stroke" style="display:none"/>` +
      `<rect width="${W}" height="${H}" fill="transparent"/>`;
    pollSpark = { sm, x, W };
    const lastP = sm[sm.length - 1];
    const und = undecidedShare();
    const fmtD = t => new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
    document.getElementById("ps-vals").innerHTML =
      `<b style="color:var(--dem)">D ${lastP.d.toFixed(1)}</b> <b style="color:var(--gop)">R ${lastP.r.toFixed(1)}</b>`;
    document.getElementById("ps-und").textContent = und == null ? "" : Math.round(und) + "% undecided";
    document.getElementById("ps-x0").textContent = fmtD(t0);
    document.getElementById("ps-x1").textContent = fmtD(POLLS[POLLS.length - 1].end);
    svgEl.setAttribute("aria-label", `Generic ballot polling average: Democrats ${lastP.d.toFixed(1)}, Republicans ${lastP.r.toFixed(1)}` +
      (und == null ? "" : `, ${Math.round(und)}% undecided`));
  }

  // hover readout for the polling sparkline
  (function () {
    const svgEl = document.getElementById("poll-svg"); if (!svgEl) return;
    const guide = () => svgEl.querySelector(".ps-guide");
    const fmtD = t => new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
    function move(evt) {
      if (!pollSpark) return;
      const r = svgEl.getBoundingClientRect();
      const cx = ((evt.touches ? evt.touches[0].clientX : evt.clientX) - r.left) / r.width * pollSpark.W;
      const sm = pollSpark.sm; let best = 0, bd = Infinity;
      sm.forEach((p, i) => { const dd = Math.abs(pollSpark.x(p.t) - cx); if (dd < bd) { bd = dd; best = i; } });
      const p = sm[best], gx = pollSpark.x(p.t).toFixed(1), g = guide();
      if (g) { g.setAttribute("x1", gx); g.setAttribute("x2", gx); g.style.display = ""; }
      const near = POLLS.filter(q => Math.abs(q.t - p.t) <= 3.5 * DAY);
      const m = p.d - p.r;
      tooltip.innerHTML = `<div class="t-code">${fmtD(p.t)}</div>
        <div class="t-row"><span style="color:var(--dem)">Democrats</span><b>${p.d.toFixed(1)}%</b></div>
        <div class="t-row"><span style="color:var(--gop)">Republicans</span><b>${p.r.toFixed(1)}%</b></div>
        <div class="t-row"><span>Average margin</span><b>${fmtMargin(m)}</b></div>
        <div class="t-row"><span>Spread (\u00b11 SD)</span><b>\u00b1${((p.sdd + p.sdr) / 2).toFixed(1)}</b></div>
        ${near.length ? `<div class="t-polls">${near.slice(-4).reverse().map(q => `<div><span>${q.who}</span><b>${fmtMargin(q.d - q.r)}</b></div>`).join("")}</div>` : ""}`;
      tooltip.classList.add("on"); tooltip.setAttribute("aria-hidden", "false");
      moveTip(evt.touches ? evt.touches[0] : evt);
    }
    function leave() { const g = guide(); if (g) g.style.display = "none"; tooltip.classList.remove("on"); tooltip.setAttribute("aria-hidden", "true"); }
    svgEl.addEventListener("mousemove", move);
    svgEl.addEventListener("mouseleave", leave);
    svgEl.addEventListener("touchstart", move, { passive: true });
    svgEl.addEventListener("touchmove", move, { passive: true });
    svgEl.addEventListener("touchend", leave);
  })();

  /* ---- topline + gauge + verdict --------------------------------------- */
  const elDem = document.getElementById("dem-seats");
  const elGop = document.getElementById("gop-seats");
  const elGD = document.getElementById("gauge-d");
  const elGR = document.getElementById("gauge-r");
  const elVerdict = document.getElementById("verdict");

  function tally() {
    if (chamber === "senate") {
      let d = SEN_NOTUP_D;
      (meta.senate || []).forEach(rc => { const m = senMargin(rc.st); if (m !== null && m >= 0) d++; });
      return { d, r: 100 - d, total: 100 };
    }
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
    const win = (chamber === "senate") ? SEN_WINLINE : 218;
    const gm = document.getElementById("gauge-mid");
    if (gm) gm.dataset.label = (chamber === "senate") ? SEN_WINLINE + " needed" : "218 needed";
    const body = (chamber === "senate") ? "the Senate" : "the House";
    const demWins = d >= win;
    const cls = demWins ? "lead-d" : "lead-r";
    elVerdict.innerHTML =
      `<span class="${cls}">${demWins ? "Democrats" : "Republicans"}</span> are favored to win ${body}`;
  }

  /* ---- battlegrounds --------------------------------------------------- */
  const bgWrap = document.getElementById("battlegrounds");
  function renderBattlegrounds() {
    let rows, tipCode;
    if (chamber === "senate") {
      tipCode = senTipState;
      rows = (meta.senate || []).map(rc => {
        const m = senMargin(rc.st);
        return { code: rc.st, margin: m, demProb: senProb(m) };
      }).sort((a, b) => Math.abs(a.margin) - Math.abs(b.margin)).slice(0, 16);
    } else {
      tipCode = currentTip;
      rows = Object.keys(forecast).map(id => {
        const f = forecast[id]; const e = effective(f);
        return { code: f.code, margin: e.margin, demProb: e.demProb };
      }).sort((a, b) => Math.abs(a.margin) - Math.abs(b.margin)).slice(0, 24);
    }
    bgWrap.innerHTML = rows.map(r => {
      const dp = Math.round(r.demProb * 100), rp = 100 - dp;
      const partyCls = r.margin >= 0 ? "d" : "r";
      const leadProb = Math.max(dp, rp);
      const isTip = r.code === tipCode;
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
    if (chamber === "senate") {
      const sel = animate ? senatePaths.transition().duration(450) : senatePaths;
      sel.attr("fill", d => senColor(d.id));
      return;
    }
    const sel = animate ? paths.transition().duration(450) : paths;
    sel.attr("fill", d => colorScale(effective(forecast[d.id]).margin));
    paths.attr("class", d =>
      "district" + (forecast[d.id].code === currentTip ? " tipping" : ""));
  }

  const gbVal = document.getElementById("gb-val");
  function fmtGB(v) {
    if (Math.abs(v) <= 0.05) return "Even";
    const p = (Math.abs(v - Math.round(v)) < 0.05) ? Math.round(Math.abs(v)) : Math.abs(v).toFixed(1);
    return (v > 0 ? "D +" : "R +") + p;
  }
  function render(animate = true) {
    currentTip = computeTipping();
    if (gbVal) gbVal.textContent = fmtGB(genericBallot);
    recolor(animate);
    renderTopline(animate);
    renderBattlegrounds();
  }

  /* ---- chamber toggle (House / Senate) --------------------------------- */
  const mainTitle = document.getElementById("main-title");
  const subDesc = document.getElementById("sub-desc");
  const HOUSE_SUB = "All 435 districts, simulated. Hover a district for its margin and odds.";
  const SENATE_SUB = "The 35 seats up in 2026, plus the seats not on the ballot. Hover a state for its margin and odds.";
  function setChamber(ch) {
    if (ch === chamber) return;
    chamber = ch;
    document.querySelectorAll(".ch-tab").forEach(t => t.classList.toggle("is-on", t.dataset.ch === ch));
    if (mainTitle) mainTitle.textContent = "2026 " + (ch === "senate" ? "Senate" : "House") + " Forecast";
    if (subDesc) subDesc.textContent = (ch === "senate") ? SENATE_SUB : HOUSE_SUB;
    gDist.style("display", ch === "house" ? null : "none");
    gSenate.style("display", ch === "senate" ? null : "none");
    hideTip();
    render(false);
  }
  document.querySelectorAll(".ch-tab").forEach(t =>
    t.addEventListener("click", () => setChamber(t.dataset.ch)));

  /* ---- generic-ballot slider (R +10 .. D +10) -------------------------- */
  const gbSlider = document.getElementById("gb-slider");
  if (gbSlider) {
    gbSlider.min = "-10"; gbSlider.max = "10"; gbSlider.step = "0.1";
    gbSlider.value = String(genericBallot);
    gbSlider.addEventListener("input", () => {
      genericBallot = +gbSlider.value;
      render(false);             // instant, smooth while dragging
    });
  }

  /* ---- Mail-In Access slider ------------------------------------------- */
  const mailWrap = document.getElementById("mail-wrap");
  const mailSlider = document.getElementById("mail-slider");
  const mailVal = document.getElementById("mail-val");
  function fmtDrag() {
    const d = nationalDrag();
    return (d <= -0.05 ? "-" + Math.abs(d).toFixed(1) : "0.0") + " pts";
  }
  if (mailSlider) {
    mailSlider.addEventListener("input", () => {
      mailDrag = +mailSlider.value;
      if (mailVal) mailVal.textContent = fmtDrag();
      render(false);
    });
  }

  /* ---- Fundamentals slider (state misery) ------------------------------ */
  const econSlider = document.getElementById("econ-slider");
  const econVal = document.getElementById("econ-val");
  if (econSlider) {
    econSlider.addEventListener("input", () => {
      econLevel = +econSlider.value;
      if (econVal) econVal.textContent = econLevel + "%";
      render(false);
    });
  }

  /* ---- Historical polling bias toggle (uniform correction) ------------- */
  function fmtBias(v) { return Math.abs(v) < 0.05 ? "Off" : "-" + Math.abs(v).toFixed(1) + " pts"; }
  // on/off toggle (styled like the old Standard/Plus control); returns a setter
  function biasToggle(wrap, out, onChange) {
    if (!wrap) return;
    wrap.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-bias]"); if (!btn) return;
      const on = btn.dataset.bias === "on";
      wrap.querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", b === btn ? "true" : "false"));
      const v = on ? POLLBIAS : 0;
      if (out) out.textContent = fmtBias(v);
      onChange(v);
    });
  }
  biasToggle(document.querySelector("#bias-wrap .bias-toggle"), document.getElementById("bias-val"),
    v => { biasPts = v; render(true); });

  /* ---- meta-driven text (refreshes whenever data changes) -------------- */
  const frozenEl  = document.getElementById("frozen");
  const stampEl   = document.getElementById("shapefile-stamp");
  const ballotNote = document.getElementById("ballot-note");
  const footnoteEl = document.getElementById("footnote");
  const techEl    = document.getElementById("tech-method");
  const boundaryEl = document.getElementById("boundary-note");
  function signed(n) { return (n >= 0 ? "+" : "-") + Math.abs(n); }
  function refreshMetaText() {
    if (frozenEl) frozenEl.textContent = "Model last run on " + (meta.dataUpdated || "");
    if (stampEl)  stampEl.textContent  = meta.shapefileNote || "";
    if (ballotNote) ballotNote.textContent =
      "The generic ballot is based on generic-ballot polling, Mail-In Access is an estimate from " +
      "voting-restriction models, Fundamentals reflects state economic stress, and turning on Historical polling bias " +
      "shifts every race " + POLLBIAS + " points toward Republicans, the average recent polling error in Democrats\u2019 favor.";
    if (footnoteEl) footnoteEl.textContent = meta.note || "";
    if (boundaryEl && meta.boundaryNote) boundaryEl.textContent = meta.boundaryNote;
    if (techEl) techEl.textContent =
      "Method: the generic-ballot slider applies a uniform national swing to every district\u2019s baseline " +
      "margin, so its value is the national vote margin; Mail-In Access is an estimate of a non-uniform turnout " +
      "effect from voting-restriction models, scaled by each state\u2019s 2024 mail share; Fundamentals models " +
      "state economic stress: in any state whose misery index (unemployment plus inflation) exceeds " + ECON_THRESH +
      ", the slider applies up to " + ECON_MAX + " points against the party holding that state\u2019s governorship; and Historical " +
      "polling bias, when on, applies a uniform " + POLLBIAS + "-point correction toward Republicans for the average recent " +
      "polling error in Democrats\u2019 favor. The polling sparkline smooths individual generic-ballot polls " +
      "(" + (meta.pollSource || "public polls") + ") with a two-week kernel; the light band is \u00b11 standard deviation of the polls. " +
      "Undecided is the average share choosing neither party in polls from the last three weeks, excluding forced-choice polls. " +
      "Tooltip trend lines show each place\u2019s presidential margin over time (" + ((DATA.hist && DATA.hist.source) || "") + "), ending in this race\u2019s 2026 projected margin, which updates with the polling and every control. Win probabilities use a logistic function (\u03c3 = " +
      SIGMA + " points); the tipping-point district is the 218th ranked by margin. Inputs: generic ballot " +
      fmtGB(genericBallot) + " (" + (meta.gbSource || "n/a") + ", " + (meta.dataUpdated || "n/a") +
      "). Figures are illustrative. Election: Nov. 3, 2026.";
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
    // Senate sheet: header row, then [State, Dem win %]
    const senSheet = wb.Sheets["Senate"];
    if (senSheet && SENRACES.length) {
      const rows = XLSX.utils.sheet_to_json(senSheet, { header: 1, blankrows: false });
      const byState = {}; for (const rc of SENRACES) byState[rc.st] = rc;
      let n = 0;
      for (const r of rows) {
        const st = String(r[0] ?? "").trim().toUpperCase();
        let p = parseFloat(r[1]);
        if (byState[st] && !isNaN(p)) { if (p > 1) p = p / 100; byState[st].p = Math.max(0.001, Math.min(0.999, p)); n++; }
      }
      if (n) SIM = buildSim(20260923);   // rebuild draws with the new Senate odds
      console.log("senate overrides applied:", n);
    }
    // Polls sheet: header row, then [Pollster, Start date, End date, Dem %, Rep %]
    const pollSheet = wb.Sheets["Polls"];
    if (pollSheet) {
      const rows = XLSX.utils.sheet_to_json(pollSheet, { header: 1, blankrows: false });
      const isoOf = v => { const t = (typeof v === "number") ? new Date(Math.round((v - 25569) * 864e5)) : new Date(v); return isNaN(t) ? null : t.toISOString().slice(0, 10); };
      const np = [];
      for (const r of rows) {
        const s0 = isoOf(r[1]), e0 = isoOf(r[2]), dv = parseFloat(r[3]), rv = parseFloat(r[4]);
        if (s0 && e0 && !isNaN(dv) && !isNaN(rv)) np.push([String(r[0] ?? ""), s0, e0, dv, rv]);
      }
      if (np.length >= 3) {
        DATA.polls = np;
        POLLS.length = 0;
        np.map(p => ({ who: p[0], t: (Date.parse(p[1]) + Date.parse(p[2])) / 2, end: Date.parse(p[2]), d: p[3], r: p[4] }))
          .sort((a, b) => a.t - b.t).forEach(p => POLLS.push(p));
        renderPollSpark();
      }
      console.log("polls loaded:", np.length);
    }
    // if no explicit date in the sheet, stamp with the file's modified time
    if (file && !foundDate) {
      meta.dataUpdated = formatDate(new Date(file.lastModified));
    }
    if (gbSlider) gbSlider.value = String(genericBallot);
    refreshMetaText();
    render(true);
    renderSim();
    flash("Updated from " + (file ? file.name : "spreadsheet") + ", " + meta.dataUpdated);
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
        ["Generic ballot (Dem margin, points)", genericBallot, "National House Democratic margin; drives the slider."],
        ["Generic ballot source", meta.gbSource || "", "Shown in the note under the slider."],
        ["Data updated (date)", meta.dataUpdated || "", "Stamps the model-run line; blank = file save date."]
      ];
      const dist = [["District", "Margin (Dem +)", "State"]];
      Object.values(forecast)
        .sort((a, b) => a.code.localeCompare(b.code))
        .forEach(f => dist.push([f.code, Math.round(f.margin * 10) / 10, f.state]));
      const sen = [["State", "Dem win %", "Rating", "Held"]];
      SENRACES.forEach(rc => sen.push([rc.st, Math.round(rc.p * 100), rc.rating || "", rc.held || ""]));
      const polls = [["Pollster", "Start date", "End date", "Dem %", "Rep %"]];
      (DATA.polls || []).forEach(p => polls.push(p.slice(0, 5)));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(inputs), "Inputs");
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(dist), "Districts");
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sen), "Senate");
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(polls), "Polls");
      XLSX.writeFile(wb, "house-polling.xlsx");
      flash("Downloaded current data: house-polling.xlsx");
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

  /* ---- Monte Carlo simulator: TRUE per-seat draws (House + Senate) ----- */
  let simMu = genericBallot;
  const SIG = 6.0;                        // fixed national-margin uncertainty
  const SEN_WIN = (meta.senateWin || 51), NOTUP_D = (meta.senateNotUpD || 34);
  const SENRACES = (meta.senate || []);   // [{st, held, rating, p}] - per-race Dem win odds
  const MU0 = genericBallot;              // environment the Senate odds reflect (current generic ballot)
  // inverse normal CDF (Acklam) - turns a per-race win probability into a margin
  function probit(p) {
    if (p <= 0) return -8; if (p >= 1) return 8;
    const a = [-39.69683028665376,220.9460984245205,-275.9285104469687,138.3577518672690,-30.66479806614716,2.506628277459239];
    const b = [-54.47609879822406,161.5858368580409,-155.6989798598866,66.80131188771972,-13.28068155288572];
    const c = [-0.007784894002430293,-0.3223964580411365,-2.400758277161838,-2.549732539343734,4.374664141464968,2.938163982698783];
    const d = [0.007784695709041462,0.3224671290700398,2.445134137142996,3.754408661907416];
    const pl = 0.02425, ph = 1 - pl; let q, r, x;
    if (p < pl) { q = Math.sqrt(-2 * Math.log(p)); x = (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1); }
    else if (p <= ph) { q = p - 0.5; r = q*q; x = (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q / (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1); }
    else { q = Math.sqrt(-2 * Math.log(1 - p)); x = -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1); }
    return x;
  }
  // tipping-point Senate seat: the race that delivers the 51st seat, by safety rank
  const senTip = (function () {
    const sorted = SENRACES.slice().sort((a, b) => b.p - a.p);
    const idx = SEN_WIN - NOTUP_D - 1;
    return (idx >= 0 && idx < sorted.length) ? sorted[idx].st : "";
  })();

  let SIM = null;
  function buildSim(seed) {
    const N = 20000, TAU_H = 3.5, TAU_S = 6.0;
    const KSD = Math.sqrt(SIG * SIG + TAU_S * TAU_S);      // combined national + race sd
    const flist = Object.values(forecast);
    const bases = Float64Array.from(flist.map(f => f.margin));
    const ND = bases.length;
    // per-district mail-in shock per point of drag (state mail share x Dem-skew), and codes
    const mUnitH = Float64Array.from(flist.map(f => { const mm = MAIL[f.state]; return mm && MAILK > 0 ? -(mm.share * mm.skew) / MAILK : 0; }));
    // per-seat Fundamentals shock at full (100%) intensity
    const eUnit = st => { const e = ECON[st]; return (e && e.m > ECON_THRESH) ? (e.g === "D" ? -1 : 1) * ECON_MAX : 0; };
    const eUnitH = Float64Array.from(flist.map(f => eUnit(f.state)));
    const codesH = flist.map(f => f.code);
    const M = Float64Array.from(SENRACES.map(rc => KSD * probit(rc.p)));  // race margin at MU0
    const mUnitS = Float64Array.from(SENRACES.map(rc => { const mm = MAIL[rc.st]; return mm && MAILK > 0 ? -(mm.share * mm.skew) / MAILK : 0; }));
    const eUnitS = Float64Array.from(SENRACES.map(rc => eUnit(rc.st)));
    const NS = M.length;
    let s = (seed >>> 0) || 1;
    const rnd = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    const gs = () => { let u = 0; while (!u) u = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd()); };
    const Z = new Float64Array(N), EH = new Float32Array(N * ND), ES = new Float32Array(N * NS);
    for (let i = 0; i < N; i++) {
      Z[i] = gs();
      const oh = i * ND; for (let d = 0; d < ND; d++) EH[oh + d] = TAU_H * gs();
      const os = i * NS; for (let r = 0; r < NS; r++) ES[os + r] = TAU_S * gs();
    }
    return {
      N, codesH, senRaces: SENRACES, notUpD: NOTUP_D,
      // effective margins at (mu, mail, econ) with no idiosyncratic noise (for pivotal ranking)
      houseEff(mu, mail, econ) { const ef = (econ || 0) / 100; return flist.map((f, d) => ({ code: f.code, m: bases[d] + mu + mail * mUnitH[d] + ef * eUnitH[d] })); },
      senEff(mu, mail, econ) { const dmu = mu - MU0, ef = (econ || 0) / 100; return SENRACES.map((rc, r) => ({ st: rc.st, m: M[r] + dmu + mail * mUnitS[r] + ef * eUnitS[r] })); },
      run(mu, mail, econ) {
        mail = mail || 0; const ef = (econ || 0) / 100;
        const hc = new Int32Array(436), sc = new Int32Array(101); let hM = 0, sM = 0;
        const dmu = mu - MU0;
        for (let i = 0; i < N; i++) {
          const m = mu + SIG * Z[i];                    // national environment this run
          const oh = i * ND; let h = 0;
          for (let d = 0; d < ND; d++) if (bases[d] + m + mail * mUnitH[d] + ef * eUnitH[d] + EH[oh + d] > 0) h++;
          const os = i * NS; let se = NOTUP_D;
          for (let r = 0; r < NS; r++) if (M[r] + dmu + SIG * Z[i] + mail * mUnitS[r] + ef * eUnitS[r] + ES[os + r] > 0) se++;
          hc[h]++; sc[se]++;
          if (h >= 218) hM++; if (se >= SEN_WIN) sM++;
        }
        const med = (c, mx) => { let a = 0; for (let k = 0; k <= mx; k++) { a += c[k]; if (a >= N / 2) return k; } return mx; };
        return { house: { counts: hc, pDem: hM / N, median: med(hc, 435) },
                 senate: { counts: sc, pDem: sM / N, median: med(sc, 100) } };
      }
    };
  }

  // stacked-box (isotype) histogram with SQUARE boxes -> { html, cells }
  function boxHist(counts, maxIdx, threshold, binSize, cols) {
    const { cDem, cGop, cInk, cFaint, fSans } = cols;
    const W = 470, H = 300, padL = 8, padR = 8, padB = 28, padT = 8;
    let lo = maxIdx, hi = 0;
    for (let k = 0; k <= maxIdx; k++) if (counts[k] > 0) { if (k < lo) lo = k; if (k > hi) hi = k; }
    if (hi < lo) { lo = 0; hi = maxIdx; }
    lo = Math.max(0, Math.floor((lo - binSize) / binSize) * binSize);
    hi = Math.min(maxIdx, hi + binSize);
    const bins = [];
    for (let start = lo; start <= hi; start += binSize) {
      let c = 0; for (let k = start; k < start + binSize && k <= maxIdx; k++) c += counts[k];
      bins.push({ start, c });
    }
    let peak = 1; for (const b of bins) if (b.c > peak) peak = b.c;
    const plotW = W - padL - padR, plotH = H - padB - padT;
    const colW = plotW / bins.length;
    const side = Math.max(4, Math.min(colW - 1.4, 14));
    const stepV = side + 1.4;
    const maxBoxes = Math.max(1, Math.floor(plotH / stepV));
    const unit = Math.max(1, Math.ceil(peak / maxBoxes));
    let out = ""; const cells = [];
    bins.forEach((b, ix) => {
      const x0 = padL + ix * colW, cx = x0 + colW / 2;
      cells.push({ x0, x1: x0 + colW, start: b.start, count: b.c });
      const nb = Math.round(b.c / unit);
      const fill = (b.start + binSize / 2) >= threshold ? cDem : cGop;
      for (let j = 0; j < nb; j++) {
        const y = padT + plotH - (j + 1) * stepV;
        out += `<rect x="${(cx - side / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${side.toFixed(1)}" height="${side.toFixed(1)}" rx="1" fill="${fill}"/>`;
      }
    });
    const xT = padL + ((threshold - lo) / binSize) * colW;
    if (threshold > lo && threshold < hi)
      out += `<line x1="${xT.toFixed(1)}" y1="${padT}" x2="${xT.toFixed(1)}" y2="${padT + plotH}" stroke="${cInk}" stroke-width="1.1" stroke-dasharray="3 3"/>`;
    const stepBins = Math.max(1, Math.round(bins.length / 5));
    for (let ix = 0; ix < bins.length; ix += stepBins) {
      const cx = padL + ix * colW + colW / 2;
      out += `<text x="${cx.toFixed(1)}" y="${H - 9}" text-anchor="middle" font-family="${fSans}" font-size="11" fill="${cFaint}">${bins[ix].start}</text>`;
    }
    return { html: out, cells };
  }

  const simMuS = document.getElementById("sim-mu"), simMuV = document.getElementById("sim-mu-val");
  const simMailS = document.getElementById("sim-mail"), simMailV = document.getElementById("sim-mail-val");
  const simEconS = document.getElementById("sim-econ"), simEconV = document.getElementById("sim-econ-val");
  const simResim = document.getElementById("sim-resim");
  const hSvg = document.getElementById("sim-house"), sSvg = document.getElementById("sim-senate");
  let simMailDrag = 0, simEcon = 0, simBias = 0;

  let houseHit = null, senHit = null;   // per-render hover data for the two charts

  function setHead(id, name, o, extra) {
    const el = document.getElementById(id); if (!el) return;
    el.innerHTML = `<span class="sim-cham">${name}</span> <span class="sim-odds">${Math.round(o.pDem * 100)}% Democratic majority</span> <span class="sim-med">median ${o.median}${extra || ""}</span>`;
  }
  function renderSim() {
    if (!SIM) return;
    const cols = { cDem: C('--dem') || '#2e74d0', cGop: C('--gop') || '#e24b38', cInk: C('--ink') || '#0f1115', cFaint: C('--ink-faint') || '#9aa0a8', fSans: C('--sans') || 'sans-serif' };
    const muEff = simMu - simBias;   // uniform polling-bias correction
    const r = SIM.run(muEff, simMailDrag, simEcon);
    // pivotal-seat rankings at the current settings (safest Democratic first)
    const hEff = SIM.houseEff(muEff, simMailDrag, simEcon).sort((a, b) => b.m - a.m);
    const sEff = SIM.senEff(muEff, simMailDrag, simEcon).sort((a, b) => b.m - a.m);
    const hb = boxHist(r.house.counts, 435, 218, 4, cols);
    const sb = boxHist(r.senate.counts, 100, SEN_WIN, 1, cols);
    if (hSvg) hSvg.innerHTML = hb.html;
    if (sSvg) sSvg.innerHTML = sb.html;
    houseHit = {
      cells: hb.cells, tip(cell) {
        const end = Math.min(435, cell.start + 3);
        const rank = Math.min(435, Math.max(1, Math.round(cell.start + 2)));
        const piv = hEff[rank - 1] ? hEff[rank - 1].code : "";
        return `<div class="t-code">${cell.start}-${end} seats</div>
          <div class="t-row"><span>Share of runs</span><b>${(cell.count / SIM.N * 100).toFixed(1)}%</b></div>
          <div class="t-row"><span>Pivotal district</span><b>${piv}</b></div>`;
      }
    };
    senHit = {
      cells: sb.cells, tip(cell) {
        const K = cell.start;
        let piv; if (K <= SIM.notUpD) piv = "safe seat"; else { const i = K - SIM.notUpD - 1; piv = sEff[i] ? sEff[i].st : ""; }
        return `<div class="t-code">${K} seats</div>
          <div class="t-row"><span>Share of runs</span><b>${(cell.count / SIM.N * 100).toFixed(1)}%</b></div>
          <div class="t-row"><span>Pivotal state</span><b>${piv}</b></div>`;
      }
    };
    const tag = (Math.abs(simBias) >= 0.05) ? ` \u00b7 bias ${fmtBias(simBias)}` : "";
    setHead("sim-h-head", "House", r.house, tag);
    setHead("sim-s-head", "Senate", r.senate, (senTip ? ` \u00b7 tips on ${senTip}` : "") + tag);
  }
  // shared light tooltip for the simulation columns
  function simTip(evt, html) {
    tooltip.innerHTML = html; tooltip.classList.add("on");
    const pad = 16, tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
    let x = evt.clientX + pad, y = evt.clientY + pad;
    if (x + tw > window.innerWidth - 8) x = evt.clientX - tw - pad;
    if (y + th > window.innerHeight - 8) y = evt.clientY - th - pad;
    tooltip.style.left = x + "px"; tooltip.style.top = y + "px";
  }
  function attachHover(svgEl, getHit) {
    if (!svgEl) return;
    svgEl.addEventListener("mousemove", (e) => {
      const h = getHit(); if (!h) return;
      const rect = svgEl.getBoundingClientRect();
      const xvb = (e.clientX - rect.left) / rect.width * 470;
      const cell = h.cells.find(c => xvb >= c.x0 && xvb < c.x1 && c.count > 0);
      if (!cell) { tooltip.classList.remove("on"); return; }
      simTip(e, h.tip(cell));
    });
    svgEl.addEventListener("mouseleave", () => tooltip.classList.remove("on"));
  }
  attachHover(hSvg, () => houseHit);
  attachHover(sSvg, () => senHit);

  function fmtMu(v) { return (Math.abs(v) <= 0.05) ? "Even" : (v > 0 ? "D +" : "R +") + (Math.abs(v - Math.round(v)) < 0.05 ? Math.round(Math.abs(v)) : Math.abs(v).toFixed(1)); }
  function fmtPts(v) { return (v <= 0.05 ? "0.0" : "-" + v.toFixed(1)) + " pts"; }
  if (simMuS) {
    simMuS.value = String(simMu);
    simMuS.addEventListener("input", () => { simMu = +simMuS.value; if (simMuV) simMuV.textContent = fmtMu(simMu); renderSim(); });
  }
  if (simMailS) {
    simMailS.addEventListener("input", () => { simMailDrag = +simMailS.value; if (simMailV) simMailV.textContent = fmtPts(simMailDrag); renderSim(); });
  }
  if (simEconS) {
    simEconS.addEventListener("input", () => { simEcon = +simEconS.value; if (simEconV) simEconV.textContent = simEcon + "%"; renderSim(); });
  }
  biasToggle(document.getElementById("sim-bias"), document.getElementById("sim-bias-val"),
    v => { simBias = v; renderSim(); });
  if (simResim) {
    simResim.addEventListener("click", () => {
      simResim.disabled = true;
      setTimeout(() => { SIM = buildSim((Math.random() * 4294967296) >>> 0); renderSim(); simResim.disabled = false; }, 20);
    });
  }
  if (simMuV) simMuV.textContent = fmtMu(simMu);
  if (simMailV) simMailV.textContent = fmtPts(simMailDrag);

  /* ---- first paint ----------------------------------------------------- */
  refreshMetaText();
  renderPollSpark();
  render(true);
  setTimeout(() => { SIM = buildSim(20260923); renderSim(); }, 40);
})();
