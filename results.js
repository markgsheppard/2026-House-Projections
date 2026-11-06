/* =========================================================================
   2026 Results - live returns scored against the frozen forecast
   Depends on: d3 v7, topojson v3, window.HOUSE_DATA (data.js),
               final-forecast.json (the model's final projection) and
               results.json (AP calls and counts, refreshed every 2 minutes)
   ========================================================================= */
(function () {
  "use strict";

  const DATA = window.HOUSE_DATA;
  if (!DATA) { console.error("HOUSE_DATA missing"); return; }
  const { districts, forecast, meta } = DATA;

  let FF = window.FINAL_FORECAST || null;     // frozen projection (inlined or fetched)
  let RES = window.RESULTS_DATA || null;      // live results (inlined or fetched)
  let COUNTY = window.COUNTY_SHIFT || null;   // county margins for the Shift view (county-shift.json)
  let CENT = window.COUNTY_CENTROIDS || null; // county centroids, lon/lat (county-centroids.json)

  const HOUSE_WIN = 218;
  const SEN_WIN_D = (typeof meta.senateWin === "number") ? meta.senateWin : 51;   // Democrats need 51; the Vice President breaks ties for Republicans
  const SEN_NOTUP_D = (typeof meta.senateNotUpD === "number") ? meta.senateNotUpD : 34;
  const SEN_NOTUP_R = 100 - 35 - SEN_NOTUP_D;

  const css = getComputedStyle(document.documentElement);
  const C = (n) => css.getPropertyValue(n).trim();
  const cDem = C("--dem") || "#2e74d0", cGop = C("--gop") || "#e24b38", cInk = C("--ink") || "#0f1115",
        cFaint = C("--ink-faint") || "#9aa0a8", cLine = C("--line") || "#e6e7e9", cGold = C("--gold") || "#b8902f", cMiss = "#c3c7cd",
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
  const gShift = svg.append("g").attr("class", "shift-arrows").style("pointer-events", "none");
  svg.insert("defs", ":first-child").html(`<pattern id="split-seats" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)"><rect width="3" height="6" fill="${fade(cDem, 0.6)}"/><rect x="3" width="3" height="6" fill="${fade(cGop, 0.6)}"/></pattern>`);
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
  const REDRAWN = new Set(Object.values(forecast).filter(f => f.real).map(f => f.state));
  const REDRAWN_LIST = [...REDRAWN].sort().join(", ");
  const isRedrawn = code => REDRAWN.has(code.slice(0, 2));

  /* ---- scoring ----------------------------------------------------------- */
  function fmtMargin(m) { const v = Math.abs(m); return `${m >= 0 ? "D" : "R"}+${v < 0.05 ? "0.0" : v.toFixed(1)}`; }
  function fmtNum(n) { return (n == null) ? "" : Number(n).toLocaleString("en-US"); }
  const HIST = DATA.hist || {};
  function baselineOf(ch, code) {
    const series = ch === "senate" ? (HIST.state || {})[code] : (HIST.district || {})[code];
    const v = (series || []).filter(x => typeof x === "number" && isFinite(x));
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  }
  function stateBaselineOf(code) { return baselineOf("senate", code.slice(0, 2)); }   // the district's state, 2008 to 2024 average
  let baseRef = "state";   // Baseline view on the House map: "state" (the district's state) or "district" (its own lines)
  const HY = HIST.years || [2008, 2012, 2016, 2020, 2024];
  function pres2024(ch, code) {
    const series = ch === "senate" ? (HIST.state || {})[code] : (HIST.district || {})[code];
    const i = HY.indexOf(2024), v = series ? series[i < 0 ? series.length - 1 : i] : null;
    return (typeof v === "number" && isFinite(v)) ? v : null;
  }
  // the result (or the count so far) against the 2024 presidential margin: + = moved toward Democrats
  function shiftOf(ch, code) {
    const r = resFor(ch, code), b = pres2024(ch, code);
    return (r && typeof r.margin === "number" && b !== null) ? r.margin - b : null;
  }
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
  // outlook: where a race lands if the count keeps going the way it is going. Called races are
  // settled; otherwise the feed's live estimate (win odds and median final margin from the votes
  // counted so far), then the current leader, then the frozen model as a last resort.
  function outlookOf(ch, code) {
    const s = score(ch, code), r = s.r, p = s.p;
    if (s.called) return { party: s.actualSide, prob: 1, basis: "called", margin: (typeof r.margin === "number") ? r.margin : null };
    const e = r.est, est = (e && typeof e.d === "number" && typeof e.r === "number") ? { party: e.d >= e.r ? "D" : "R", prob: Math.max(e.d, e.r), margin: (typeof e.m === "number") ? e.m : null } : null;
    if (typeof r.margin === "number" && r.tv > 0) return { party: r.margin >= 0 ? "D" : "R", prob: null, basis: "lead", margin: r.margin, est };
    if (est) return { party: est.party, prob: est.prob, basis: "trend", margin: est.margin };
    if (p) return { party: s.projParty, prob: s.projParty === "D" ? p.demProb : 1 - p.demProb, basis: "model", margin: p.margin };
    return { party: null, prob: null, basis: "none", margin: null };
  }
  function outlookCounts(ch) {
    const o = { d: 0, r: 0, i: 0, trend: 0, lead: 0, model: 0 };
    racesFor(ch).forEach(code => { const k = outlookOf(ch, code); if (k.party === "D") o.d++; else if (k.party === "R") o.r++; else if (k.party === "I") o.i++; if (k.basis in o) o[k.basis]++; });
    return o;
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
    if (view === "redrawn" && ch === "house") { const base = resultFill(ch, code); return isRedrawn(code) ? base : fade(base, 0.82); }
    if (view === "baseline") {
      const s = score(ch, code), r = s.r, b = (ch === "house" && baseRef === "state") ? stateBaselineOf(code) : baselineOf(ch, code);
      if (typeof r.margin !== "number" || b === null) return r.status === "none" ? NONE : "#f4f5f7";
      const col = colorScale(r.margin - b);
      return s.called ? col : fade(col, 0.45);
    }
    return resultFill(ch, code);
  }
  function resultFill(ch, code) {
    const s = score(ch, code), r = s.r;
    if (view === "misses") {
      if (!s.called) return LIGHT;
      if (s.correct === false) return (typeof r.margin === "number") ? colorScale(r.margin) : (s.actualSide === "D" ? cDem : s.actualSide === "R" ? cGop : cFaint);
      const base = (typeof r.margin === "number") ? colorScale(r.margin) : (s.actualSide === "D" ? cDem : cGop);
      return fade(base, 0.8);
    }
    if (view === "shift") return (r.status === "none") ? NONE : "#f4f5f7";
    if (view === "outlook" && !s.called) {
      if (typeof r.margin === "number" && r.tv > 0) return fade(colorScale(r.margin >= 0 ? Math.max(r.margin, 2) : Math.min(r.margin, -2)), 0.5);   // the count so far, tinted toward the leader even when it is close
      const k = outlookOf(ch, code);
      if (!k.party || k.party === "I") return NONE;
      const m = (typeof k.margin === "number") ? k.margin : (k.party === "D" ? 12 : -12);
      return fade(colorScale(k.party === "D" ? Math.max(m, 2) : Math.min(m, -2)), 0.5);
    }
    if (s.called) {
      if (typeof r.margin === "number") return colorScale(r.margin);
      return s.actualSide === "D" ? colorScale(30) : s.actualSide === "R" ? colorScale(-30) : cFaint;
    }
    if (r.status === "counting") return (typeof r.margin === "number") ? fade(colorScale(r.margin), 0.55) : COUNTING;   // leading, not called: a lighter lean color
    return NONE;
  }
  const SEN_NOT_UP = { AZ: "DD", CA: "DD", CT: "DD", HI: "DD", IN: "RR", MD: "DD", MO: "RR", NV: "DD", NY: "DD", ND: "RR", PA: "DR", UT: "RR", VT: "DD", WA: "DD", WI: "DR" };
  function senFill(st) {
    if (senUp[st]) return fillFor("senate", st);
    if (view === "outlook") {   // no race this year: the delegation as it stands
      const h = SEN_NOT_UP[st];
      if (h === "DD") return fade(cDem, 0.18);   // two Democratic senators: a deep blue
      if (h === "RR") return fade(cGop, 0.18);   // two Republican senators: a deep red
      if (h === "DR") return fade(cDem, 0.62);   // one of each: a light blue
    }
    return LIGHT;
  }

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
    // the result against the place's usual lean: the 2008 to 2024 presidential average, as on the forecast page
    const base = baselineOf(ch, code), sbase = ch === "house" ? stateBaselineOf(code) : null;
    const signed = v => `<b style="color:${v >= 0 ? "var(--dem)" : "var(--gop)"}">${fmtMargin(v)}</b>`;
    let vsBase = "";
    if (typeof r.margin === "number" && (base !== null || sbase !== null)) {
      const sofar = s.called ? "" : ", so far";
      if (ch === "senate") vsBase = `<div class="t-row"><span>vs. state baseline${sofar}</span>${signed(r.margin - base)}</div><div class="t-soft t-sub">state baseline ${fmtMargin(base)}, 2008 to 2024 pres. avg.</div>`;
      else {
        if (sbase !== null) vsBase += `<div class="t-row"><span>vs. state baseline${sofar}</span>${signed(r.margin - sbase)}</div>`;
        if (base !== null) vsBase += `<div class="t-row"><span>vs. district baseline${sofar}</span>${signed(r.margin - base)}</div>`;
        vsBase += `<div class="t-soft t-sub">${sbase !== null ? `state ${fmtMargin(sbase)}` : ""}${sbase !== null && base !== null ? " &middot; " : ""}${base !== null ? `district ${fmtMargin(base)}` : ""}, 2008 to 2024 pres. avg.</div>`;
      }
    }
    let outlook = "";
    if (!s.called) {
      const k = outlookOf(ch, code);
      const who = k.party === "D" ? ((r.d && r.d.name) || (r.i && r.i.name) || projName(p, "D", r)) : k.party === "R" ? ((r.r && r.r.name) || projName(p, "R", r)) : null;
      if (who && k.basis === "trend") outlook = `<div class="t-row"><span>Outlook</span><b style="color:${k.party === "D" ? "var(--dem)" : "var(--gop)"}">${who} ${Math.round(k.prob * 100)}%${typeof k.margin === "number" ? ` &middot; ${fmtMargin(k.margin)}` : ""}</b></div><div class="t-soft t-sub">live estimate from the votes counted so far</div>`;
      else if (who && k.basis === "lead") {
        const e = k.est, ewho = e ? (e.party === "D" ? ((r.d && r.d.name) || (r.i && r.i.name) || projName(p, "D", r)) : ((r.r && r.r.name) || projName(p, "R", r))) : null;
        outlook = `<div class="t-row"><span>Outlook</span><b style="color:${k.party === "D" ? "var(--dem)" : "var(--gop)"}">${who} leads the count</b></div>` + (e ? `<div class="t-soft t-sub">live estimate from the votes counted so far: ${ewho} ${Math.round(e.prob * 100)}%${typeof e.margin === "number" ? ` &middot; ${fmtMargin(e.margin)}` : ""}</div>` : "");
      }
      else if (who && k.basis === "model") outlook = `<div class="t-row"><span>Outlook</span><b style="color:${k.party === "D" ? "var(--dem)" : "var(--gop)"}">${who}, no votes yet (model ${Math.round(k.prob * 100)}%)</b></div>`;
    }
    const sh = shiftOf(ch, code);
    const shiftRow = (sh !== null) ? `<div class="t-row"><span>Shift from 2024${s.called ? "" : ", so far"}</span><b style="color:${sh >= 0 ? "var(--dem)" : "var(--gop)"}">${fmtMargin(sh)}</b></div>` : "";
    let model = "";
    if (p) {
      const pd = Math.round(p.demProb * 100);
      model += `<div class="t-row"><span>Model projected</span><b>${fmtMargin(p.margin)} &middot; ${p.margin >= 0 ? pd : 100 - pd}% ${p.margin >= 0 ? "D" : "R"}</b></div>`;
      if (s.errLive !== null) model += `<div class="t-row"><span>Model off by</span><b style="color:${s.errLive >= 0 ? "var(--dem)" : "var(--gop)"}">${fmtMargin(s.errLive)}</b></div>`;
      // the polls at face value: the generic-ballot average through the seat's elasticity, before the model's adjustments
      if (typeof p.poll === "number") {
        model += `<div class="t-row"><span>Polls projected</span><b>${fmtMargin(p.poll)}</b></div>`;
        if (typeof r.margin === "number") { const pe = r.margin - p.poll; model += `<div class="t-row"><span>Polls off by</span><b style="color:${pe >= 0 ? "var(--dem)" : "var(--gop)"}">${fmtMargin(pe)}</b></div>`; }
      }
      if (s.errLive !== null) model += `<div class="t-soft t-sub">off by: ${s.called ? "result" : "count so far"} minus projection; D means more Democratic than projected</div>`;
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
    const redrawnNote = (ch === "house" && isRedrawn(code)) ? `<div class="t-soft t-sub t-left">district lines redrawn for 2026</div>` : "";
    return `<div class="t-head"><div class="t-code">${code}</div>${statusTag(s)}</div>${redrawnNote}${rows}${bar}${margin}${vsBase}${shiftRow}${held}${outlook}${model}${call}`;
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
    const outlook = view === "outlook" && RES;
    const oc = outlook ? outlookCounts(chamber) : null;
    let d, r, total, win, body;
    if (chamber === "senate") { d = SEN_NOTUP_D + (oc ? oc.d : st.d); r = SEN_NOTUP_R + (oc ? oc.r : st.r); total = 100; win = SEN_WIN_D; body = "the Senate"; }
    else { d = oc ? oc.d : st.d; r = oc ? oc.r : st.r; total = 435; win = HOUSE_WIN; body = "the House"; }
    elDem.textContent = d; elGop.textContent = r;
    elGD.style.width = (100 * d / total) + "%"; elGR.style.width = (100 * r / total) + "%";
    const gm = document.getElementById("gauge-mid");
    if (gm) gm.dataset.label = (chamber === "senate") ? SEN_WIN_D + " needed" : HOUSE_WIN + " needed";
    let v;
    if (!RES) v = `Waiting for results`;
    else if (outlook) {
      const lead = d >= r ? "D" : "R";
      v = `<span class="${lead === "D" ? "lead-d" : "lead-r"}">${lead === "D" ? "Democrats" : "Republicans"}</span> on track for ${Math.max(d, r)}`;
      const ind = oc.i ? `, ${oc.i} independent` : "";
      const tail = ` <span class="verdict-sub">${st.called.length} called${ind} &middot; ${st.uncalled} uncalled, given to the current leader</span>`;
      elVerdict.innerHTML = v + tail;
      if (elUncalled) elUncalled.innerHTML = "";
      return;
    }
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
    setText("ro-bias-note", st.bias !== null ? `results ran ${Math.abs(st.bias).toFixed(1)} pts more ${st.bias >= 0 ? "Democratic" : "Republican"} than projected` : "results vs. projection");
  }

  /* ---- map ------------------------------------------------------------------ */
  function recolor(animate) {
    if (chamber === "senate") { (animate ? senatePaths.transition().duration(400) : senatePaths).attr("fill", d => senFill(d.id)); }
    else { (animate ? paths.transition().duration(400) : paths).attr("fill", d => fillFor("house", codeOf(d.id))); }
    paths.classed("missed", d => view === "misses" && score("house", codeOf(d.id)).correct === false);
    paths.classed("redrawn-on", d => view === "redrawn" && isRedrawn(codeOf(d.id)));
    paths.classed("redrawn-miss", d => view === "redrawn" && isRedrawn(codeOf(d.id)) && score("house", codeOf(d.id)).correct === false);
    senatePaths.classed("missed", d => view === "misses" && senUp[d.id] && score("senate", d.id).correct === false);
    renderShift();
  }
  // shift arrows, one per district or state: pointing up and to the right for a move toward Democrats,
  // up and to the left for a move toward Republicans, length by the size of the shift
  const ARROW = { angle: Math.PI / 6, perPt: 0.55, min: 3, max: 24, head: 3 };          // one arrow per state or district
  const ARROW_CO = { angle: Math.PI / 6, perPt: 0.32, min: 1.6, max: 14, head: 2.1 };   // one arrow per county
  function arrowPath(cx, cy, shift, cfg) {
    const A = cfg || ARROW;
    const len = Math.min(A.max, A.min + Math.abs(shift) * A.perPt);
    const dir = shift >= 0 ? -1 : 1;                   // Democratic shift points left, Republican right
    const ux = dir * Math.cos(A.angle), uy = -Math.sin(A.angle);
    const x1 = cx + ux * len, y1 = cy + uy * len;
    const h = A.head, a = Math.PI / 7;
    const bx = -ux, by = -uy;   // back along the shaft
    const lx = x1 + h * (bx * Math.cos(a) - by * Math.sin(a)), ly = y1 + h * (bx * Math.sin(a) + by * Math.cos(a));
    const rx = x1 + h * (bx * Math.cos(-a) - by * Math.sin(-a)), ry = y1 + h * (bx * Math.sin(-a) + by * Math.cos(-a));
    return `M${cx.toFixed(1)},${cy.toFixed(1)}L${x1.toFixed(1)},${y1.toFixed(1)}M${lx.toFixed(1)},${ly.toFixed(1)}L${x1.toFixed(1)},${y1.toFixed(1)}L${rx.toFixed(1)},${ry.toFixed(1)}`;
  }
  function countyRows(st) { const rows = COUNTY && COUNTY[chamber]; return (rows && rows[st] && Object.keys(rows[st]).length && CENT) ? rows[st] : null; }
  function renderShift() {
    gShift.selectAll("*").remove();
    if (view !== "shift") return;
    const items = [];
    // counties, the whole country: the AP count by county against the county's 2024 presidential
    // margin. The Senate tab uses the Senate race wherever there is one and the House vote elsewhere.
    // Every county takes the first race that gives it a two-party margin: on the House tab the
    // House vote, then the Senate race, then the governor's race; on the Senate tab the Senate
    // race first, then the House vote, then the governor's race.
    const sen = (COUNTY && COUNTY.senate) || {}, hou = (COUNTY && COUNTY.house) || {}, gov = (COUNTY && COUNTY.governor) || {};
    const order = chamber === "senate" ? [sen, hou, gov] : [hou, sen, gov];
    const srcFor = st => { const rows = {}; order.forEach(src => { const r = src[st]; if (!r) return; for (const fips in r) if (!rows[fips] && r[fips] && r[fips][3]) rows[fips] = r[fips]; }); return Object.keys(rows).length ? rows : null; };
    const covered = new Set();
    if (CENT) for (const st of new Set([...Object.keys(sen), ...Object.keys(hou), ...Object.keys(gov)])) {
      const rows = srcFor(st); if (!rows) continue;
      covered.add(st);
      for (const fips in rows) {
        const r = rows[fips], ll = CENT[fips]; if (!ll || !r || !r[3]) continue;
        const c = projection(ll); if (!c || !isFinite(c[0])) continue;
        const eevp = r[2] || 0;
        items.push({ c, sh: r[0] - r[1], op: eevp < 5 ? 0.2 : 0.3 + 0.6 * Math.min(1, eevp / 90), county: true });
      }
    }
    // states or districts with no county counts (Alaska, say): one arrow for the whole race
    if (chamber === "senate") {
      stateFeatures.forEach(f => { if (!senUp[f.id] || covered.has(f.id)) return; const sh = shiftOf("senate", f.id); if (sh === null) return; const c = path.centroid(f); if (!isFinite(c[0])) return; items.push({ c, sh, op: score("senate", f.id).called ? 0.9 : 0.5, big: true }); });
    }
    allDistricts.forEach(f => { const code = codeOf(f.id), st = forecast[f.id].state; if (covered.has(st) || (chamber === "senate" && senUp[st])) return; const sh = shiftOf("house", code); if (sh === null) return; const c = path.centroid(f); if (!isFinite(c[0])) return; items.push({ c, sh, op: score("house", code).called ? 0.9 : 0.5, big: false }); });
    gShift.selectAll("path").data(items).join("path")
      .attr("d", d => arrowPath(d.c[0], d.c[1], d.sh, d.county ? ARROW_CO : ARROW))
      .attr("fill", "none")
      .attr("stroke", d => d.sh >= 0 ? cDem : cGop)
      .attr("stroke-width", d => d.county ? 0.85 : (d.big ? 1.6 : 1.1))
      .attr("stroke-linecap", "round").attr("stroke-linejoin", "round")
      .attr("opacity", d => d.op)
      .attr("paint-order", "stroke");
  }
  function renderLegend() {
    const el = document.getElementById("legend-chips"); if (!el) return;
    const chip = (style, label) => `<span class="chip"><i style="${style}"></i>${label}</span>`;
    const ends = document.getElementById("legend-ends");
    if (ends) ends.innerHTML = view === "baseline" ? "<span>R +30 vs. baseline</span><span>At baseline</span><span>D +30 vs. baseline</span>" : "<span>R +30</span><span>Even</span><span>D +30</span>";
    if (view === "baseline") {
      const sw = chamber === "house"
        ? `<span class="chip chip-switch" role="group" aria-label="Baseline reference"><button type="button" data-baseref="state" aria-pressed="${baseRef === "state"}">State baseline</button><button type="button" data-baseref="district" aria-pressed="${baseRef === "district"}">District baseline</button></span>`
        : "";
      const what = chamber === "senate" ? "state" : (baseRef === "state" ? "district&rsquo;s state" : "district");
      el.innerHTML = sw + chip(`background:${colorScale(-18)}`, "Running more Republican than the baseline") + chip(`background:${colorScale(18)}`, "Running more Democratic than the baseline") + chip(`background:${fade(colorScale(18), .45)}`, "Not yet called") + chip(`background:${NONE}`, "No results yet") + (chamber === "senate" ? chip(`background:${LIGHT}`, "Not on the ballot") : "") +
        `<span class="chip chip-note">margin so far minus the ${what}&rsquo;s 2008 to 2024 presidential average, whoever is winning</span>`;
      return;
    }
    const arrow = (col, dir) => `<svg width="22" height="14" viewBox="0 0 22 14" aria-hidden="true"><path d="${dir > 0 ? "M2,12L19,3M13,2L19,3L18,9" : "M20,12L3,3M9,2L3,3L4,9"}" fill="none" stroke="${col}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    if (view === "shift") {
      el.innerHTML = `<span class="chip">${arrow(cDem, -1)}Shift toward Democrats</span><span class="chip">${arrow(cGop, 1)}Shift toward Republicans</span><span class="chip chip-note">one arrow per county across the country, from the county&rsquo;s 2024 presidential margin, using ${chamber === "senate" ? "the Senate race where there is one, otherwise the House vote, otherwise the governor&rsquo;s race" : "the House vote, or the Senate or governor&rsquo;s race where the House seat had no two-party contest"}; longer arrows are bigger shifts, faint ones have little of the vote counted</span>`;
      return;
    }
    if (view === "redrawn") {
      if (chamber === "senate") { el.innerHTML = chip(`background:${cGop}`, "Called, Republican") + chip(`background:${cDem}`, "Called, Democrat") + chip(`background:${fade(cDem, .55)}`, "Leading, not yet called") + `<span class="chip chip-note">Redrawn applies to the House map; no Senate seat changed shape</span>`; return; }
      let d = 0, r = 0, u = 0, miss = 0; racesFor("house").forEach(code => { if (!isRedrawn(code)) return; const sc = score("house", code); if (!sc.called) u++; else { if (sc.actualSide === "D") d++; else r++; if (sc.correct === false) miss++; } });
      el.innerHTML = chip(`background:${cGop}`, "Called, Republican") + chip(`background:${cDem}`, "Called, Democrat") + chip(`background:${fade(cDem, .55)}`, "Leading, not yet called") + chip(`background:${cDem};box-shadow:0 0 0 2px ${cInk} inset`, "Model missed, redrawn district") + chip(`background:${fade(cGop, .82)}`, "Not redrawn") +
        `<span class="chip chip-note">full color: the ${d + r + u} districts in the ${REDRAWN.size} states with new maps for 2026 (${REDRAWN_LIST}); so far ${d} D, ${r} R called, ${u} uncalled, ${miss} ${miss === 1 ? "miss" : "misses"}</span>`;
      return;
    }
    if (view === "outlook") {
      el.innerHTML = chip(`background:${cGop}`, "Called, Republican") + chip(`background:${cDem}`, "Called, Democrat") + chip(`background:${fade(cDem, .5)}`, "Not yet called, colored by the count so far") + chip(`background:${NONE}`, "No results yet")
        + (chamber === "senate" ? chip(`background:${fade(cDem, .18)}`, "No race: two Democratic senators") + chip(`background:${fade(cDem, .62)}`, "No race: one Democrat, one Republican") + chip(`background:${fade(cGop, .18)}`, "No race: two Republican senators") : "");
      return;
    }
    el.innerHTML = view === "misses"
      ? chip(`background:${cGop};box-shadow:0 0 0 2px ${cMiss} inset`, "Model missed, Republican won") + chip(`background:${cDem};box-shadow:0 0 0 2px ${cMiss} inset`, "Model missed, Democrat won") + chip(`background:${fade(cDem, .8)}`, "Model correct") + chip(`background:${LIGHT}`, "Not yet called")
      : chip(`background:${cGop}`, "Called, Republican") + chip(`background:${cDem}`, "Called, Democrat") + chip(`background:${fade(cDem, .55)}`, "Leading, not yet called") + chip(`background:${NONE}`, "No results yet") + (chamber === "senate" ? chip(`background:${LIGHT}`, "Not on the ballot") : "");
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
        ? `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="7" fill="${col}" stroke="${cMiss}" stroke-width="2.6"/>`
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
    setText("data-note", RES ? `Results: ${RES.source || "AP via The New York Times"} &middot; refreshed every 2 minutes` : "Results refresh every 2 minutes once counting begins");
    if (FF) setText("model-stamp", `Model frozen ${FF.asOf || ""} &middot; ballot ${fmtGB(FF.genericBallot)}${FF.settings && FF.settings.meanReversion ? ` (${fmtGB(FF.effectiveBallot)} after mean reversion)` : ""}`);
    const foot = document.getElementById("footnote");
    if (foot) foot.textContent = (meta.note || "");
    const tech = document.getElementById("tech-method");
    if (tech) tech.textContent =
      "Results: AP race calls and vote counts published in The New York Times results feed, pulled by a GitHub Action every two minutes and committed to the site. " +
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
  document.getElementById("legend-chips").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-baseref]"); if (!b) return;
    baseRef = b.dataset.baseref; recolor(true); renderLegend();
  });
  document.querySelectorAll(".view-toggle").forEach(wrap => wrap.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-view]"); if (!btn) return;
    view = btn.dataset.view;
    document.querySelectorAll(".view-toggle button").forEach(b => b.setAttribute("aria-pressed", b.dataset.view === view ? "true" : "false"));
    recolor(true); renderLegend(); renderTopline();
  }));

  function renderAll(animate = true) {
    recolor(animate); renderLegend(); renderTopline(); renderReadouts(); renderMisses(); renderReg(); renderStamps();
  }

  /* ---- data loading + two-minute refresh ---------------------------------- */
  async function getJSON(name) {
    const r = await fetch(name + "?t=" + Date.now(), { cache: "no-store" });
    if (!r.ok) throw new Error(name + " " + r.status);
    return r.json();
  }
  async function loadCounties() {
    try { if (!CENT) CENT = await getJSON("county-centroids.json"); } catch (e) { /* no centroids: state and district arrows */ }
    try { const j = await getJSON("county-shift.json"); if (j && (j.senate || j.house)) COUNTY = j; } catch (e) { /* keep what we have */ }
    if (view === "shift") renderShift();
  }
  async function loadResults(first) {
    try { const j = await getJSON("results.json"); if (j && j.house) { RES = j; renderAll(!first); } }
    catch (e) { if (first && !RES) renderAll(false); }
    loadCounties();
  }
  (async function init() {
    if (!FF) { try { FF = await getJSON("final-forecast.json"); } catch (e) { console.warn("final-forecast.json missing", e); } }
    renderAll(false);
    await loadResults(true);
    setInterval(() => loadResults(false), 2 * 60 * 1000);
  })();
})();
