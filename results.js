/* =========================================================================
   2026 Results - live returns scored against the frozen forecast
   Depends on: d3 v7, topojson v3, window.HOUSE_DATA (data.js),
               final-forecast.json (the model's final projection) and
               results.json (AP calls and counts, refreshed every 10 minutes)
   ========================================================================= */
(function () {
  "use strict";

  const DATA = window.HOUSE_DATA;
  if (!DATA) { console.error("HOUSE_DATA missing"); return; }
  const { districts, forecast, meta } = DATA;

  let FF = window.FINAL_FORECAST || null;     // frozen projection (inlined or fetched)
  let RES = window.RESULTS_DATA || null;      // live results (inlined or fetched)

  const HOUSE_WIN = 218;
  const SEN_WIN_D = (typeof meta.senateWin === "number") ? meta.senateWin : 51;   // Democrats need 51; the Vice President breaks ties for Republicans
  const SEN_NOTUP_D = (typeof meta.senateNotUpD === "number") ? meta.senateNotUpD : 34;
  const SEN_NOTUP_R = 100 - 35 - SEN_NOTUP_D;

  const css = getComputedStyle(document.documentElement);
  const C = (n) => css.getPropertyValue(n).trim();
  const cDem = C("--dem") || "#2e74d0", cGop = C("--gop") || "#e24b38", cInk = C("--ink") || "#0f1115",
        cFaint = C("--ink-faint") || "#9aa0a8", cLine = C("--line") || "#e6e7e9", cGold = C("--gold") || "#b8902f",
        fSans = C("--sans") || "sans-serif";
  const colorStops = [[-40, "#b62d2d"], [-22, "#d43d34"], [-9, "#ec5a44"], [-2, "#f6c4bb"], [0, "#f4f2f2"], [2, "#a9c9f2"], [9, "#2e74d0"], [22, "#0d52bd"], [40, "#08306b"]];
  const colorScale = d3.scaleLinear().domain(colorStops.map(s => s[0])).range(colorStops.map(s => s[1])).interpolate(d3.interpolateRgb).clamp(true);
  const fade = (col, k) => d3.interpolateRgb(col, "#ffffff")(k);
  const NONE = "#eceef0", COUNTING = "#d3d6da", LIGHT = "#f1f2f4";

  /* ---- geography (same projection as the forecast page) ---------------- */
  const allDistricts = topojson.feature(districts, districts.objects.districts).features.filter(f => forecast[f.id]);
  const fc = { type: "FeatureCollection", features: allDistricts };
  const W = 960, H = 600;
  const projection = d3.geoAlbersUsa().fitSize([W, H], fc);
  const path = d3.geoPath(projection);
  const svg = d3.select("#map");
  const gDist = svg.append("g").attr("class", "districts");
  const gState = svg.append("g").attr("class", "states");
  const gHi = svg.append("g").attr("class", "highlight");
  const codeOf = id => forecast[id].code;
  const paths = gDist.selectAll("path").data(allDistricts, d => d.id).join("path").attr("class", "district").attr("d", path);
  const stateMesh = topojson.mesh(districts, districts.objects.districts, (a, b) => a.properties.st !== b.properties.st);
  const stateOuter = topojson.mesh(districts, districts.objects.districts, (a, b) => a === b);
  gState.append("path").attr("class", "state-border").attr("d", path(stateMesh));
  gState.append("path").attr("class", "state-border").attr("d", path(stateOuter));
  const stGeoms = {};
  districts.objects.districts.geometries.forEach(g => { const st = g.properties.st; if (st) (stGeoms[st] = stGeoms[st] || []).push(g); });
  const stateFeatures = Object.keys(stGeoms).map(st => ({ type: "Feature", id: st, geometry: topojson.merge(districts, stGeoms[st]) }));
  const gSenate = svg.append("g").attr("class", "senate-states"); gSenate.lower(); gSenate.style("display", "none");
  const senatePaths = gSenate.selectAll("path").data(stateFeatures, d => d.id).join("path").attr("class", "senate-state").attr("d", path);
  const senUp = {}; (meta.senate || []).forEach(rc => senUp[rc.st] = rc);

  let chamber = "house", view = "results";

  /* ---- scoring ----------------------------------------------------------- */
  function fmtMargin(m) { const v = Math.abs(m); return `${m >= 0 ? "D" : "R"}+${v < 0.05 ? "0.0" : v.toFixed(1)}`; }
  function fmtNum(n) { return (n == null) ? "" : Number(n).toLocaleString("en-US"); }
  function projFor(ch, code) { if (!FF) return null; return ch === "senate" ? (FF.senate || {})[code] : (FF.house || {})[code]; }
  function resFor(ch, code) { if (!RES) return null; return ch === "senate" ? (RES.senate || {})[code] : (RES.house || {})[code]; }
  // the projected party's candidate: the feed's name (who is actually on the ballot) first, then the forecast's
  function projName(p, side, r) {
    const c = (p && p.cand) || {}, f = r || {};
    if (side === "D") return (f.d && f.d.name) || c.d || (f.i && !f.d && f.i.name) || (c.i && !c.d ? c.i : "Democrat");
    return (f.r && f.r.name) || c.r || "Republican";
  }
  // one record per race: what happened, what the model said, and whether it was right
  function score(ch, code) {
    const p = projFor(ch, code), r = resFor(ch, code) || { status: "none", winner: null, margin: null };
    const projParty = p ? (p.margin >= 0 ? "D" : "R") : null;
    let actualSide = null;
    if (r.winner === "D" || r.winner === "R") actualSide = r.winner;
    else if (r.winner === "I") actualSide = (p && p.cand && p.cand.i && !p.cand.d) ? "D" : "I";   // Nebraska: the model framed Osborn as the D side
    else if (r.winner === "O") actualSide = "I";
    const called = r.status === "called";
    const correct = (called && projParty) ? (actualSide === projParty) : null;
    const errLive = (p && typeof r.margin === "number") ? r.margin - p.margin : null;   // result so far minus projection
    const err = called ? errLive : null;                                                   // scored only once called
    const lead = (typeof r.margin === "number") ? (r.margin >= 0 ? "D" : "R") : null;
    return { code, p, r, projParty, actualSide, called, correct, err, errLive, lead,
             winnerName: actualSide === "D" ? ((r.d && r.d.name) || (r.i && r.i.name) || "Democrat") : actualSide === "R" ? ((r.r && r.r.name) || "Republican") : ((r.i && r.i.name) || "Independent") };
  }
  function racesFor(ch) {
    return ch === "senate" ? (meta.senate || []).map(rc => rc.st) : Object.keys(forecast).map(codeOf);
  }
  function stats(ch) {
    const all = racesFor(ch).map(code => score(ch, code));
    const called = all.filter(s => s.called);
    const scored = called.filter(s => s.correct !== null);
    const correct = scored.filter(s => s.correct).length;
    const withErr = called.filter(s => s.err !== null);
    const mae = withErr.length ? withErr.reduce((a, s) => a + Math.abs(s.err), 0) / withErr.length : null;
    const bias = withErr.length ? withErr.reduce((a, s) => a + s.err, 0) / withErr.length : null;
    const misses = scored.filter(s => !s.correct).sort((a, b) => Math.abs(b.err || 0) - Math.abs(a.err || 0));
    let d = 0, r = 0, i = 0;
    called.forEach(s => { if (s.actualSide === "D" && s.r.winner !== "I") d++; else if (s.actualSide === "R") r++; else i++; });
    return { all, called, scored, correct, mae, bias, misses, d, r, i, uncalled: all.length - called.length, withErr };
  }

  /* ---- colors ------------------------------------------------------------ */
  function fillFor(ch, code) {
    const s = score(ch, code), r = s.r;
    if (view === "misses") {
      if (!s.called) return LIGHT;
      if (s.correct === false) return (typeof r.margin === "number") ? colorScale(r.margin) : (s.actualSide === "D" ? cDem : s.actualSide === "R" ? cGop : cFaint);
      const base = (typeof r.margin === "number") ? colorScale(r.margin) : (s.actualSide === "D" ? cDem : cGop);
      return fade(base, 0.8);
    }
    if (s.called) {
      if (typeof r.margin === "number") return colorScale(r.margin);
      return s.actualSide === "D" ? colorScale(30) : s.actualSide === "R" ? colorScale(-30) : cFaint;
    }
    if (r.status === "counting") return COUNTING;   // still counting: grey until AP calls it
    return NONE;
  }
  function senFill(st) { return senUp[st] ? fillFor("senate", st) : LIGHT; }

  /* ---- tooltip ------------------------------------------------------------- */
  const tooltip = document.getElementById("tooltip");
  const stage = document.getElementById("stage");
  function pct(v, tv) { return tv > 0 ? (100 * v / tv).toFixed(1) + "%" : "0.0%"; }
  function statusTag(s) {
    const r = s.r;
    if (s.called) return `<span class="t-tag called">Called${(typeof r.eevp === "number" && r.eevp > 0) ? ` &middot; ${Math.round(r.eevp)}% in` : ""}</span>`;
    if (r.status === "counting") return `<span class="t-tag counting">Counting &middot; ${Math.round(r.eevp || 0)}% in</span>`;
    return `<span class="t-tag none">No results yet</span>`;
  }
  function tipHtml(ch, code) {
    const s = score(ch, code), r = s.r, p = s.p, tv = r.tv || 0;
    const dName = r.d ? r.d.name : (r.i && !r.d ? r.i.name : null);
    const dV = r.d ? r.d.v : (r.i && !r.d ? r.i.v : null);
    const dLab = r.d ? "D" : "I";
    let rows = "";
    if (dName != null) rows += `<div class="t-row"><span style="color:var(--dem)">${dName} (${dLab})</span><b>${pct(dV, tv)} &middot; ${fmtNum(dV)}</b></div>`;
    if (r.r) rows += `<div class="t-row"><span style="color:var(--gop)">${r.r.name} (R)</span><b>${pct(r.r.v, tv)} &middot; ${fmtNum(r.r.v)}</b></div>`;
    if (r.i && r.d) rows += `<div class="t-row"><span style="color:var(--ink-soft)">${r.i.name} (I)</span><b>${pct(r.i.v, tv)} &middot; ${fmtNum(r.i.v)}</b></div>`;
    const dp = (tv > 0 && dV != null) ? 100 * dV / tv : 0, rp = (tv > 0 && r.r) ? 100 * r.r.v / tv : 0;
    const bar = tv > 0 ? `<div class="t-bar"><i style="width:${rp}%;background:var(--gop)"></i><i style="width:${100 - dp - rp}%;background:transparent"></i><i style="width:${dp}%;background:var(--dem)"></i></div>` : "";
    const margin = (typeof r.margin === "number") ? `<div class="t-row"><span>${s.called ? "Margin" : "Margin so far"}</span><b>${fmtMargin(r.margin)}</b></div>` : "";
    let model = "";
    if (p) {
      const pd = Math.round(p.demProb * 100);
      model += `<div class="t-row"><span>Model projected</span><b>${fmtMargin(p.margin)} &middot; ${p.margin >= 0 ? pd : 100 - pd}% ${p.margin >= 0 ? "D" : "R"}</b></div>`;
      if (s.errLive !== null) model += `<div class="t-row"><span>Model off by</span><b style="color:${s.errLive >= 0 ? "var(--dem)" : "var(--gop)"}">${fmtMargin(s.errLive)}</b></div><div class="t-soft t-sub">${s.called ? "result" : "result so far"} ${Math.abs(s.errLive).toFixed(1)} pts more ${s.errLive >= 0 ? "Democratic" : "Republican"} than projected</div>`;
    }
    let call = "";
    if (p && s.called) {
      call = s.correct
        ? `<div class="t-row t-win"><span>Model call</span><b style="color:var(--dem-deep)">Correct: ${s.winnerName}</b></div>`
        : `<div class="t-row t-win"><span>Model call</span><b style="color:var(--gop-deep)">Missed: projected ${projName(p, s.projParty, r)}, ${s.winnerName} won</b></div>`;
    } else if (p) {
      call = `<div class="t-row t-win"><span>Model call</span><b>${projName(p, s.projParty, r)} favored, ${Math.round((s.projParty === "D" ? p.demProb : 1 - p.demProb) * 100)}%</b></div>`;
    }
    const held = (ch === "senate" && senUp[code]) ? `<div class="t-row"><span>Held by</span><b>${senUp[code].held === "D" ? "Democrat" : "Republican"}</b></div>` : "";
    return `<div class="t-head"><div class="t-code">${code}</div>${statusTag(s)}</div>${rows}${bar}${margin}${held}${model}${call}`;
  }
  function moveTip(evt) {
    const pad = 16, tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
    let x = evt.clientX + pad, y = evt.clientY + pad;
    if (x + tw > window.innerWidth - 8) x = evt.clientX - tw - pad;
    if (y + th > window.innerHeight - 8) y = evt.clientY - th - pad;
    tooltip.style.left = x + "px"; tooltip.style.top = y + "px";
  }
  function showTipHtml(evt, html) { tooltip.innerHTML = html; tooltip.classList.add("on"); tooltip.setAttribute("aria-hidden", "false"); moveTip(evt); }
  function hideTip() { tooltip.classList.remove("on"); tooltip.setAttribute("aria-hidden", "true"); stage.classList.remove("dim"); gHi.selectAll("*").remove(); }
  paths.on("mouseenter", (evt, d) => {
      showTipHtml(evt, tipHtml("house", codeOf(d.id)));
      stage.classList.add("dim");
      gHi.selectAll("*").remove();
      gHi.append("path").attr("d", path(d)).attr("fill", fillFor("house", codeOf(d.id))).attr("class", "district hot");
    }).on("mousemove", moveTip).on("mouseleave", hideTip);
  senatePaths.on("mouseenter", (evt, d) => {
      const st = d.id;
      if (!senUp[st]) { showTipHtml(evt, `<div class="t-head"><div class="t-code">${st}</div><span class="t-tag none">Not on the ballot</span></div>`); return; }
      showTipHtml(evt, tipHtml("senate", st));
      gHi.selectAll("*").remove();
      gHi.append("path").attr("d", path(d)).attr("fill", senFill(st)).attr("class", "senate-state hot");
    }).on("mousemove", moveTip).on("mouseleave", hideTip);

  /* ---- topline ------------------------------------------------------------ */
  const elDem = document.getElementById("dem-seats"), elGop = document.getElementById("gop-seats");
  const elGD = document.getElementById("gauge-d"), elGR = document.getElementById("gauge-r");
  const elVerdict = document.getElementById("verdict"), elUncalled = document.getElementById("uncalled");
  function renderTopline() {
    const st = stats(chamber);
    let d, r, total, win, body;
    if (chamber === "senate") { d = SEN_NOTUP_D + st.d; r = SEN_NOTUP_R + st.r; total = 100; win = SEN_WIN_D; body = "the Senate"; }
    else { d = st.d; r = st.r; total = 435; win = HOUSE_WIN; body = "the House"; }
    elDem.textContent = d; elGop.textContent = r;
    elGD.style.width = (100 * d / total) + "%"; elGR.style.width = (100 * r / total) + "%";
    const gm = document.getElementById("gauge-mid");
    if (gm) gm.dataset.label = (chamber === "senate") ? SEN_WIN_D + " needed" : HOUSE_WIN + " needed";
    let v;
    if (!RES) v = `Waiting for results`;
    else if (d >= win) v = `<span class="lead-d">Democrats</span> win ${body}`;
    else if (chamber === "senate" ? r >= 50 : r >= win) v = `<span class="lead-r">Republicans</span> ${chamber === "senate" ? "keep" : "win"} ${body}`;
    else if (d === r) v = `Tied ${d} to ${r}, ${st.uncalled} ${chamber === "senate" ? "races" : "seats"} uncalled`;
    else v = `<span class="${d > r ? "lead-d" : "lead-r"}">${d > r ? "Democrats" : "Republicans"}</span> lead ${Math.max(d, r)} to ${Math.min(d, r)}`;
    const ind = st.i ? `, ${st.i} independent` : "";
    const tail = RES ? ` <span class="verdict-sub">${st.called.length} of ${st.all.length} called${ind} &middot; ${st.uncalled} to go</span>` : "";
    elVerdict.innerHTML = v + tail;
    if (elUncalled) elUncalled.innerHTML = "";
  }

  /* ---- masthead readouts ------------------------------------------------- */
  function setText(id, html) { const el = document.getElementById(id); if (el) el.innerHTML = html; }
  function renderReadouts() {
    const st = stats(chamber);
    const n = st.all.length;
    setText("ro-called", RES ? `${st.called.length} <span class="ro-sub">of ${n}</span>` : "&ndash;");
    const bar = document.getElementById("ro-called-bar"); if (bar) bar.style.width = (100 * st.called.length / n) + "%";
    setText("ro-record", st.scored.length ? `${st.correct} <span class="ro-sub">of ${st.scored.length}</span>` : "&ndash;");
    setText("ro-record-note", st.scored.length ? `${(100 * st.correct / st.scored.length).toFixed(0)}% of calls correct` : "no calls yet");
    setText("ro-mae", st.mae !== null ? `${st.mae.toFixed(1)} <span class="ro-sub">pts</span>` : "&ndash;");
    setText("ro-mae-note", st.mae !== null ? `average miss, ${st.withErr.length} races` : "waiting for calls");
    setText("ro-bias", st.bias !== null ? fmtMargin(st.bias) : "&ndash;");
    setText("ro-bias-note", st.bias !== null ? `results ran ${Math.abs(st.bias).toFixed(1)} pts more ${st.bias >= 0 ? "Democratic" : "Republican"} than projected` : "lean of the error");
  }

  /* ---- map ------------------------------------------------------------------ */
  function recolor(animate) {
    if (chamber === "senate") { (animate ? senatePaths.transition().duration(400) : senatePaths).attr("fill", d => senFill(d.id)); }
    else { (animate ? paths.transition().duration(400) : paths).attr("fill", d => fillFor("house", codeOf(d.id))); }
    paths.classed("missed", d => view === "misses" && score("house", codeOf(d.id)).correct === false);
    senatePaths.classed("missed", d => view === "misses" && senUp[d.id] && score("senate", d.id).correct === false);
  }
  function renderLegend() {
    const el = document.getElementById("legend-chips"); if (!el) return;
    const chip = (style, label) => `<span class="chip"><i style="${style}"></i>${label}</span>`;
    el.innerHTML = view === "misses"
      ? chip(`background:${cGop};box-shadow:0 0 0 2px ${cGold} inset`, "Model missed, Republican won") + chip(`background:${cDem};box-shadow:0 0 0 2px ${cGold} inset`, "Model missed, Democrat won") + chip(`background:${fade(cDem, .8)}`, "Model correct") + chip(`background:${LIGHT}`, "Not yet called")
      : chip(`background:${cGop}`, "Called, Republican") + chip(`background:${cDem}`, "Called, Democrat") + chip(`background:${COUNTING}`, "Counting, not yet called") + chip(`background:${NONE}`, "No results yet") + (chamber === "senate" ? chip(`background:${LIGHT}`, "Not on the ballot") : "");
  }

  /* ---- where the model missed ------------------------------------------- */
  const missWrap = document.getElementById("misses");
  function renderMisses() {
    const st = stats(chamber);
    const h2 = document.getElementById("miss-title");
    if (h2) h2.textContent = st.misses.length ? `Where the model missed: ${st.misses.length} ${st.misses.length === 1 ? "race" : "races"}` : "Where the model missed";
    if (!RES) { missWrap.innerHTML = `<div class="bg-cell bg-empty">Waiting for the first results.</div>`; return; }
    if (!st.misses.length) {
      missWrap.innerHTML = `<div class="bg-cell bg-empty">No misses so far. ${st.called.length ? `All ${st.called.length} called ${chamber === "senate" ? "races" : "seats"} went to the model's projected winner.` : "No races have been called yet."}</div>`;
      return;
    }
    const maxErr = Math.max(5, ...st.misses.map(s => Math.abs(s.err || 0)));
    missWrap.classList.toggle("many", st.misses.length > 9);
    missWrap.onmouseover = (ev) => { const cell = ev.target.closest(".bg-cell"); if (!cell || !cell.dataset.code) return; showTipHtml(ev, tipHtml(chamber, cell.dataset.code)); };
    missWrap.onmousemove = (ev) => { if (ev.target.closest(".bg-cell")) moveTip(ev); };
    missWrap.onmouseleave = () => hideTip();
    missWrap.innerHTML = st.misses.map(s => {
      const wCls = s.actualSide === "D" ? "d" : s.actualSide === "R" ? "r" : "";
      const pd = Math.round(s.p.demProb * 100);
      const projTxt = `${fmtMargin(s.p.margin)} &middot; ${s.projParty === "D" ? pd : 100 - pd}% ${s.projParty}`;
      const errTxt = s.err !== null ? `Miss: ${Math.abs(s.err).toFixed(1)} pts` : "Miss";
      const w = s.err !== null ? Math.min(100, 100 * Math.abs(s.err) / maxErr) : 100;
      const col = s.actualSide === "D" ? "var(--dem)" : "var(--gop)";
      return `<div class="bg-cell miss" data-code="${s.code}">
        <div class="bg-code">${s.code}</div>
        <div class="bg-margin ${wCls}">Won ${typeof s.r.margin === "number" ? fmtMargin(s.r.margin) : s.actualSide} &middot; ${s.winnerName}</div>
        <div class="bg-prob">Projected ${projTxt}</div>
        <div class="bg-fund">${errTxt}</div>
        <div class="bg-meter"><i style="width:${w}%;background:${col}"></i></div>
      </div>`;
    }).join("");
  }

  /* ---- forecast vs. result (regression) ----------------------------------- */
  let regPts = [], REG = null;
  function fitLine(pts) {
    const n = pts.length; if (n < 3) return null;
    const mx = d3.mean(pts, p => p.x), my = d3.mean(pts, p => p.y);
    const sxx = d3.sum(pts, p => (p.x - mx) ** 2); if (!sxx) return null;
    const b = d3.sum(pts, p => (p.x - mx) * (p.y - my)) / sxx, a = my - b * mx;
    const ssr = d3.sum(pts, p => (p.y - (a + b * p.x)) ** 2), sst = d3.sum(pts, p => (p.y - my) ** 2);
    const rmse = Math.sqrt(d3.sum(pts, p => (p.y - p.x) ** 2) / n);     // against the 1:1 line: the model's own error
    return { a, b, r2: sst ? 1 - ssr / sst : 0, n, rmse, bias: d3.mean(pts, p => p.y - p.x) };
  }
  function renderReg() {
    const svgEl = document.getElementById("res-svg"); if (!svgEl) return;
    const st = stats(chamber);
    const pts = st.withErr.map(s => ({ x: s.p.margin, y: s.r.margin, code: s.code, miss: s.correct === false, side: s.actualSide }));
    regPts = [];
    const W = 1000, H = 560, mL = 96, mR = 28, mT = 22, mB = 80, pw = W - mL - mR, ph = H - mT - mB;
    let lim = 20; pts.forEach(p => { lim = Math.max(lim, Math.abs(p.x), Math.abs(p.y)); });
    lim = Math.min(80, Math.ceil(lim / 10) * 10);
    const step = lim > 40 ? 20 : 10;
    const X = v => mL + (v + lim) / (2 * lim) * pw, Y = v => mT + (lim - v) / (2 * lim) * ph;
    const lab = g => g === 0 ? "even" : (g > 0 ? "D+" + g : "R+" + (-g));
    let s = "";
    for (let g = -lim; g <= lim; g += step) {
      s += `<line x1="${X(g).toFixed(1)}" y1="${mT}" x2="${X(g).toFixed(1)}" y2="${mT + ph}" stroke="${cLine}" stroke-width="${g === 0 ? 1.4 : 0.7}"/>`;
      s += `<line x1="${mL}" y1="${Y(g).toFixed(1)}" x2="${mL + pw}" y2="${Y(g).toFixed(1)}" stroke="${cLine}" stroke-width="${g === 0 ? 1.4 : 0.7}"/>`;
      if (g > -lim) s += `<text x="${X(g).toFixed(1)}" y="${mT + ph + 28}" text-anchor="middle" font-family="${fSans}" font-size="21" fill="${cFaint}">${lab(g)}</text>`;
      s += `<text x="${mL - 11}" y="${(Y(g) + 7).toFixed(1)}" text-anchor="end" font-family="${fSans}" font-size="21" fill="${cFaint}">${lab(g)}</text>`;
    }
    s += `<line x1="${X(-lim).toFixed(1)}" y1="${Y(-lim).toFixed(1)}" x2="${X(lim).toFixed(1)}" y2="${Y(lim).toFixed(1)}" stroke="${cFaint}" stroke-width="1" stroke-dasharray="4 4" opacity="0.7"/>`;
    REG = fitLine(pts);
    if (REG) s += `<defs><clipPath id="res-clip"><rect x="${mL}" y="${mT}" width="${pw}" height="${ph}"/></clipPath></defs>` +
      `<line clip-path="url(#res-clip)" x1="${X(-lim).toFixed(1)}" y1="${Y(REG.a + REG.b * -lim).toFixed(1)}" x2="${X(lim).toFixed(1)}" y2="${Y(REG.a + REG.b * lim).toFixed(1)}" stroke="${cInk}" stroke-width="2"/>`;
    pts.forEach(p => {
      const col = p.side === "D" ? cDem : cGop, cx = X(p.x), cy = Y(p.y);
      s += p.miss
        ? `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="7" fill="${col}" stroke="${cGold}" stroke-width="2.6"/>`
        : `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="5.5" fill="${col}" fill-opacity="0.85" stroke="#fff" stroke-width="1"/>`;
      regPts.push({ cx, cy, code: p.code });
    });
    if (!pts.length) s += `<text x="${(mL + pw / 2).toFixed(1)}" y="${(mT + ph / 2).toFixed(1)}" text-anchor="middle" font-family="${fSans}" font-size="24" fill="${cFaint}">Dots appear as races are called</text>`;
    s += `<text x="${(mL + pw / 2).toFixed(1)}" y="${H - 12}" text-anchor="middle" font-family="${fSans}" font-size="20" font-weight="700" fill="${cFaint}">Model's projected margin</text>`;
    s += `<text transform="translate(24,${(mT + ph / 2).toFixed(1)}) rotate(-90)" text-anchor="middle" font-family="${fSans}" font-size="20" font-weight="700" fill="${cFaint}">Actual margin</text>`;
    svgEl.innerHTML = s;
    const rn = document.getElementById("res-note");
    if (rn) rn.innerHTML = REG
      ? `<b>Fit: actual = ${REG.a >= 0 ? "" : "&minus;"}${Math.abs(REG.a).toFixed(1)} + ${REG.b.toFixed(2)} &times; projected</b>, R&sup2; ${REG.r2.toFixed(2)}, n = ${REG.n} called ${chamber === "senate" ? "races" : "seats"} with a margin. ` +
        `Root-mean-square error against the diagonal ${REG.rmse.toFixed(1)} points; results ran ${Math.abs(REG.bias).toFixed(1)} points more ${REG.bias >= 0 ? "Democratic" : "Republican"} than projected on average. ` +
        `A slope below one means margins came in closer than projected; an intercept above zero means the polling underrated Democrats. Gold rings mark the misses. Hover any dot for its race.`
      : `The fit appears once at least three ${chamber === "senate" ? "races" : "seats"} have been called with a vote margin.`;
  }
  (function () {
    const rsvg = document.getElementById("res-svg"); if (!rsvg) return;
    rsvg.addEventListener("mousemove", (e) => {
      const r = rsvg.getBoundingClientRect();
      const vx = (e.clientX - r.left) / r.width * 1000, vy = (e.clientY - r.top) / r.height * 560;
      let best = null, bd = 260;
      for (const p of regPts) { const dd = (p.cx - vx) ** 2 + (p.cy - vy) ** 2; if (dd < bd) { bd = dd; best = p; } }
      if (!best) { tooltip.classList.remove("on"); return; }
      showTipHtml(e, tipHtml(chamber, best.code));
    });
    rsvg.addEventListener("mouseleave", () => tooltip.classList.remove("on"));
  })();

  /* ---- stamps + notes ------------------------------------------------------ */
  function fmtET(iso) {
    if (!iso) return "";
    const d = new Date(iso); if (isNaN(d)) return "";
    return d.toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " ET";
  }
  function renderStamps() {
    const upd = RES ? fmtET(RES.updated) : "";
    setText("stamp", RES ? `Updated ${upd}` : "Waiting for results");
    setText("data-note", RES ? `Results: ${RES.source || "AP via The New York Times"} &middot; refreshed every 10 minutes` : "Results refresh every 10 minutes once counting begins");
    if (FF) setText("model-stamp", `Model frozen ${FF.asOf || ""} &middot; ballot ${fmtGB(FF.genericBallot)}${FF.settings && FF.settings.meanReversion ? ` (${fmtGB(FF.effectiveBallot)} after mean reversion)` : ""}`);
    const foot = document.getElementById("footnote");
    if (foot) foot.textContent = (meta.note || "");
    const tech = document.getElementById("tech-method");
    if (tech) tech.textContent =
      "Results: AP race calls and vote counts published in The New York Times results feed, pulled by a GitHub Action every ten minutes and committed to the site. " +
      "Margins are Democrat minus Republican as a share of all votes counted, so they move while counting continues; a race is scored only once it is called. " +
      "In Nebraska the independent, Dan Osborn, stands in for the Democratic side, as the model framed that race. " +
      "The model's projection is its final run (" + (FF ? FF.asOf : "") + "): generic ballot " + (FF ? fmtGB(FF.genericBallot) : "") +
      (FF && FF.settings && FF.settings.meanReversion ? ", projected onto the historical ballot-vs-result line (" + fmtGB(FF.effectiveBallot) + ")" : "") +
      ", with mail-in and fundamentals off and no polling-bias correction, applied to each seat through its elasticity and fundraising fundamental. " +
      "Win probabilities are the model's: a logistic with σ = 3.5 points for the House, and the blended race probabilities for the Senate. Election: Nov. 3, 2026.";
  }
  function fmtGB(v) { if (v == null) return ""; const a = Math.abs(v); return Math.abs(v) <= 0.05 ? "Even" : (v > 0 ? "D +" : "R +") + (Math.abs(a - Math.round(a)) < 0.05 ? Math.round(a) : a.toFixed(1)); }

  /* ---- chamber + view toggles ---------------------------------------------- */
  const mainTitle = document.getElementById("main-title"), subDesc = document.getElementById("sub-desc");
  const HOUSE_SUB = "Live returns for all 435 districts. Hover a district for the count and the model’s call.";
  const SENATE_SUB = "Live returns for the 35 seats on the ballot. Hover a state for the count and the model’s call.";
  function setChamber(ch) {
    if (ch === chamber) return;
    chamber = ch;
    document.querySelectorAll(".ch-tab").forEach(t => t.classList.toggle("is-on", t.dataset.ch === ch));
    if (mainTitle) mainTitle.textContent = "2026 " + (ch === "senate" ? "Senate" : "House") + " Results";
    if (subDesc) subDesc.textContent = ch === "senate" ? SENATE_SUB : HOUSE_SUB;
    gDist.style("display", ch === "house" ? null : "none");
    gSenate.style("display", ch === "senate" ? null : "none");
    hideTip(); renderAll(false);
  }
  document.querySelectorAll(".ch-tab").forEach(t => t.addEventListener("click", () => setChamber(t.dataset.ch)));
  document.querySelectorAll(".view-toggle").forEach(wrap => wrap.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-view]"); if (!btn) return;
    view = btn.dataset.view;
    document.querySelectorAll(".view-toggle button").forEach(b => b.setAttribute("aria-pressed", b.dataset.view === view ? "true" : "false"));
    recolor(true); renderLegend();
  }));

  function renderAll(animate = true) {
    recolor(animate); renderLegend(); renderTopline(); renderReadouts(); renderMisses(); renderReg(); renderStamps();
  }

  /* ---- data loading + ten-minute refresh ---------------------------------- */
  async function getJSON(name) {
    const r = await fetch(name + "?t=" + Date.now(), { cache: "no-store" });
    if (!r.ok) throw new Error(name + " " + r.status);
    return r.json();
  }
  async function loadResults(first) {
    try { const j = await getJSON("results.json"); if (j && j.house) { RES = j; renderAll(!first); } }
    catch (e) { if (first && !RES) renderAll(false); }
  }
  (async function init() {
    if (!FF) { try { FF = await getJSON("final-forecast.json"); } catch (e) { console.warn("final-forecast.json missing", e); } }
    renderAll(false);
    await loadResults(true);
    setInterval(() => loadResults(false), 10 * 60 * 1000);
  })();
})();
