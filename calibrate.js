/* =========================================================================
   2026 Forecast - calibration page (unlisted)
   Fits the forecast's own dials to the actual House and Senate margins:
   the national environment, elasticity, mail-in drag, the economic
   fundamental (level and misery threshold), the fundraising weight and,
   optionally, ridge-penalized state effects. Nelder-Mead with random
   restarts over whichever dials are unlocked; state effects solved in
   closed form and scored by leave-one-out cross-validation.
   Depends on: d3 v7, window.HOUSE_DATA (data.js), results.json, final-forecast.json
   ========================================================================= */
(function () {
  "use strict";

  const DATA = window.HOUSE_DATA;
  if (!DATA) { console.error("HOUSE_DATA missing"); return; }
  const { forecast, mail, meta } = DATA;
  const ECON = DATA.econ || {}, MAIL = mail || {};
  const ECON_MAX = (typeof meta.econMax === "number") ? meta.econMax : 1.5;
  const ECON_THRESH = (typeof meta.econThreshold === "number") ? meta.econThreshold : 7.5;
  const GB = (typeof meta.genericBallot === "number") ? meta.genericBallot : 9.1;   // the polls' generic ballot the Senate odds were anchored to
  const KSD = Math.sqrt(72), SIGMA = 3.5;
  const STATE_NAMES = { AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming" };

  /* ---- math helpers ------------------------------------------------------ */
  function probit(p) {
    if (p <= 0) return -8; if (p >= 1) return 8;
    const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.3577518672690, -30.66479806614716, 2.506628277459239];
    const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
    const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
    const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
    const pl = 0.02425, ph = 1 - pl; let q, r;
    if (p < pl) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    if (p <= ph) { q = p - 0.5; r = q * q; return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1); }
    q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  function normCdf(z) {
    const t = 1 / (1 + 0.2316419 * Math.abs(z)), d = 0.3989423 * Math.exp(-z * z / 2);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return z > 0 ? 1 - p : p;
  }
  const logistic = (m, s) => 1 / (1 + Math.exp(-m / s));
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const fmtGB = m => `${m >= 0 ? "D" : "R"} +${Math.abs(m).toFixed(1)}`;
  const fmtMargin = m => { const v = Math.abs(m); return `${m >= 0 ? "D" : "R"}+${v < 0.05 ? "0.0" : v.toFixed(1)}`; };
  const fmtNum = n => Number(n).toLocaleString("en-US");

  // average of (share x skew) across districts, so the mail dial reads in national points (as on the forecast page)
  let MAILK = 1;
  { let s = 0, n = 0; for (const id in forecast) { const m = MAIL[forecast[id].state]; if (m) s += m.share * m.skew; n++; } MAILK = n ? s / n : 1; }
  function mailShock(st, drag) { const m = MAIL[st]; return (m && MAILK > 0) ? -(drag / MAILK) * m.share * m.skew : 0; }

  /* ---- the dials --------------------------------------------------------- */
  const FROZEN_S_DEFAULT = 7.72;
  const DIALS = [
    { k: "S",    label: "Environment",   min: -10, max: 25,  step: 0.1,  fmt: fmtGB },
    { k: "kel",  label: "Elasticity",    min: 0,   max: 2.5, step: 0.01, fmt: v => v.toFixed(2) + "\u00d7" },
    { k: "mail", label: "Mail-in drag",  min: 0,   max: 6,   step: 0.1,  fmt: v => v.toFixed(1) + " pts" },
    { k: "shock", label: "Fundamentals", min: 0,  max: 20,  step: 0.1,  fmt: v => v.toFixed(1) + " pts" },
    { k: "thr",  label: "Misery threshold", min: 5, max: 10.5, step: 0.1, fmt: v => v.toFixed(1) },
    { k: "wf",   label: "Fundraising",   min: 0,   max: 10,  step: 0.05, fmt: v => v.toFixed(2) + "\u00d7" },
  ];
  // hover explanations, in plain language, for every label on the page
  const TIPS = {
    S: ["Environment", "How good a year it was for Democrats nationwide, in points of margin. Every race moves with this number by its own elasticity: swing seats move almost point for point, safe seats barely budge. The polls had it at " + fmtGB(GB) + "; the model ran " + fmtGB(FROZEN_S_DEFAULT) + "."],
    kel: ["Elasticity", "How much races respond to the national mood. 1\u00d7 is the model as run. Above 1, the swingy seats swung even more than the model expected; below 1, the swing landed more evenly than it expected."],
    mail: ["Mail-in drag", "How many points Democrats lost nationwide to restricted mail voting. It lands hardest in states where many Democrats vote by mail and lightest where few do. Zero means the fit found no such penalty."],
    shock: ["Fundamentals", "The economy's bite, in points of margin. In every state whose misery index (unemployment plus inflation) is above the threshold, every race shifts this many points against the party holding the governorship: a Democratic governor's state moves toward Republicans, a Republican governor's toward Democrats. The forecast page allowed at most " + ECON_MAX + "."],
    thr: ["Misery threshold", "How bad a state's economy has to be before the Fundamentals shock applies. Lower it to bring in more states, raise it to confine the shock to the worst-off ones. The model used " + ECON_THRESH + "."],
    wf: ["Fundraising", "How much third-quarter money mattered. 1\u00d7 is the model's capped adjustment; 5\u00d7 means a well-funded candidate gained five times the edge the model gave them."],
    hold: ["Hold", "Keep this dial where it is while the others are searched."],
    obj: ["Fit to", "What the search tries to get right. Margins, robust: the size of every miss, with the handful of very wrong races unable to dominate. Margins: the plain root mean square miss. Winners: calling the right party, and being confident about it."],
    fe: ["State effects", "Gives every state its own offset on top of the dials, like a per-state fudge factor. That always fits better in sample, so trust the cross-validated numbers, which estimate each state's offset without the race being scored."],
    lam: ["Ridge penalty", "How tightly the state offsets are reined in. A small penalty lets them absorb almost anything; a large one shrinks them toward zero. Tune by cross-validation picks the value that predicts held-out races best."],
    fit: ["Fit", "Searches for the dial settings that best reproduce the results: eight starting points, the best answer kept and polished. Dials marked hold stay where they are. It takes about a second."],
    reset: ["Reset", "Puts every dial back to the forecast as it was frozen on November 2."],
    right: ["Races right", "How many of the scored races these dials call for the party that actually won or leads."],
    rmse: ["RMS miss", "The typical size of a miss, in points of margin: the square root of the average squared gap between predicted and actual."],
    house: ["House", "Democratic House seats the dials would have predicted, next to the seats Democrats actually won or lead."],
    senate: ["Senate", "Democratic Senate seats the dials would have predicted, next to the seats Democrats actually hold, won or lead."],
    env: ["Environment", "The national Democratic margin the dials imply, with what the polls said and what the model ran for comparison."],
    compare: ["Side by side", "The frozen forecast, the dials as they are now, and the last fit. The first rows are how well each does; the rest are the settings themselves."],
    training: ["Training", "The search watching itself. Each grey line is one restart falling toward a good answer; the blue line is the best found so far. If every restart ends in the same place, the answer is solid; if they scatter, the dials trade off against each other."],
    target: ["Shock falls on", "Who pays for a bad economy. Governor's party is how the model was built; President's party makes it a penalty on the national incumbent party everywhere above the threshold; Democrats makes it plain Democratic underperformance in stressed states."],
    form: ["Shape", "Step: every state above the threshold takes the full shock. Slope: the shock grows with how far above the threshold a state sits, in points per point of misery."],
    profile: ["Loss along the dial", "Read it like a valley: the bottom is the shock size that fits best. A flat valley means the results barely care what the dial is set to; a sharp one means they do."],
    refit: ["Refit", "Re-runs the search at each size of the shock, threshold held, so the dashed line shows how good the fit can get at every size once the other dials adjust around it."],
    heat: ["Size against threshold", "Every combination of shock size and threshold, darker where the fit is better. A dark band down the left means the economy dial earns little; a dark pocket means one size and threshold do real work."],
    states: ["States above the threshold", "The states the economy dial touches right now, how hard it hits them and in which direction, and how far each ran from the dials with the shock off and on. A miss that shrinks when the dial is on is a state the shock is explaining."],
    scatter: ["Dials vs. result", "Each dot is a race. On the dashed diagonal the dials nailed the margin; above it Democrats did better than predicted, below it worse. Outlined dots are called for the wrong party."],
    wrong: ["Still wrong", "The races no setting of these dials calls right. What they have in common is the story the model is missing."]
  };
  const FROZEN = { S: FROZEN_S_DEFAULT, kel: 1, mail: 0, shock: 0, thr: ECON_THRESH, wf: 1 };
  let P = Object.assign({}, FROZEN);
  const locked = {};                       // dial -> true to hold it fixed during a fit
  const spec = { target: "gov", form: "step", fe: false, lam: 8, objective: "robust" };
  let FF = null, RES = null, ROWS = [], BEST = null;

  /* ---- data: one row per race with a two-party margin ------------------- */
  // D-minus-R margin from the count, letting an independent stand in for a missing or outpolled
  // major-party candidate (Nebraska's Osborn, Alaska's Hill), as the forecast framed those races
  function actualMargin(r) {
    if (!r) return null;
    const dv = r.d ? +r.d.v || 0 : null, rv = r.r ? +r.r.v || 0 : null, iv = r.i ? +r.i.v || 0 : 0, tv = +r.tv || 0;
    let ds = dv, rs = rv;
    if (r.i && (ds === null || iv > ds)) ds = iv;
    else if (r.i && (rs === null || iv > rs)) rs = iv;
    if (ds === null || rs === null || tv <= 0) return (typeof r.margin === "number") ? r.margin : null;
    return (ds - rs) / tv * 100;
  }
  // a called race counts in full; one still being counted counts by its share of the expected vote
  function weightOf(r) { return r.status === "called" ? 1 : clamp(((+r.eevp) || 0) / 100, 0.2, 1); }
  function buildRows() {
    ROWS = [];
    if (!RES) return;
    for (const id in forecast) {
      const f = forecast[id], r = (RES.house || {})[f.code];
      const y = actualMargin(r);
      if (y === null || !isFinite(y)) continue;
      ROWS.push({ code: f.code, ch: "house", st: f.state, base: f.margin, el: (typeof f.elast === "number") ? f.elast : 1, anchor: 0,
                  fund: (f.fund && typeof f.fund.adj === "number") ? f.fund.adj : 0, y, called: r.status === "called", w: weightOf(r), sd: SIGMA, kind: "logit" });
    }
    (meta.senate || []).forEach(rc => {
      const r = (RES.senate || {})[rc.st], y = actualMargin(r);
      if (y === null || !isFinite(y)) return;
      ROWS.push({ code: rc.st, ch: "senate", st: rc.st, base: KSD * probit(rc.p), el: (typeof rc.elast === "number") ? rc.elast : 1, anchor: GB,
                  fund: 0, y, called: r.status === "called", w: weightOf(r), sd: KSD, kind: "probit" });
    });
  }

  /* ---- the model --------------------------------------------------------- */
  function econShock(st, p, sp) {
    const e = ECON[st]; if (!e) return 0;
    const over = e.m - p.thr; if (over <= 0) return 0;
    const sign = sp.target === "gov" ? (e.g === "D" ? -1 : 1) : sp.target === "pres" ? 1 : -1;
    return sign * p.shock * (sp.form === "step" ? 1 : over);
  }
  function rawMargin(row, p, sp) {
    return row.base + p.kel * row.el * (p.S - row.anchor) + mailShock(row.st, p.mail) + econShock(row.st, p, sp) + p.wf * row.fund;
  }
  // predictions for every row at dials p: raw margins, then ridge state effects if they are on,
  // with the leave-one-out version of each state's effect for an honest score
  function predictAll(p, sp) {
    const n = ROWS.length, m = new Float64Array(n), cv = new Float64Array(n);
    for (let i = 0; i < n; i++) m[i] = rawMargin(ROWS[i], p, sp);
    const off = {};
    if (sp.fe) {
      const sum = {}, cnt = {};
      for (let i = 0; i < n; i++) { const s = ROWS[i].st, w = ROWS[i].w, r = ROWS[i].y - m[i]; sum[s] = (sum[s] || 0) + w * r; cnt[s] = (cnt[s] || 0) + w; }
      for (const s in sum) off[s] = sum[s] / (cnt[s] + sp.lam);
      for (let i = 0; i < n; i++) {
        const s = ROWS[i].st, w = ROWS[i].w, r = ROWS[i].y - m[i];
        const loo = (cnt[s] - w > 1e-9) ? (sum[s] - w * r) / (cnt[s] - w + sp.lam) : 0;
        cv[i] = m[i] + loo; m[i] += off[s];
      }
    } else { for (let i = 0; i < n; i++) cv[i] = m[i]; }
    return { m, cv, off };
  }
  function probOf(row, m) {   // the model's own win probability for the Democratic side
    return clamp(row.kind === "logit" ? logistic(m, row.sd) : normCdf(m / row.sd), 0.001, 0.999);
  }
  const HUBER = 8;   // points: misses beyond this count linearly, so a few bad-data outliers cannot steer the dials
  function scoreOf(pred) {
    const n = ROWS.length; let se = 0, ae = 0, ll = 0, hu = 0, right = 0, cvse = 0, cvright = 0, W = 0;
    for (let i = 0; i < n; i++) {
      const row = ROWS[i], w = row.w, e = pred.m[i] - row.y, a = Math.abs(e), pd = probOf(row, pred.m[i]);
      W += w; se += w * e * e; ae += w * a; ll -= w * Math.log(row.y >= 0 ? pd : 1 - pd);
      hu += w * (a <= HUBER ? 0.5 * e * e : HUBER * (a - 0.5 * HUBER));
      if ((pred.m[i] >= 0) === (row.y >= 0)) right++;
      const ec = pred.cv[i] - row.y; cvse += w * ec * ec; if ((pred.cv[i] >= 0) === (row.y >= 0)) cvright++;
    }
    return { n, rmse: Math.sqrt(se / W), mae: ae / W, logloss: ll / W, huber: Math.sqrt(2 * hu / W), right, cvRmse: Math.sqrt(cvse / W), cvRight: cvright };
  }
  function objective(sc, sp) { return sp.objective === "winners" ? sc.logloss : sp.objective === "rmse" ? sc.rmse : sc.huber; }
  function lossAt(p, sp) { return objective(scoreOf(predictAll(p, sp)), sp); }

  /* ---- Nelder-Mead over the unlocked dials, several random starts -------- */
  function nelderMead(f, x0, step, iters) {
    const n = x0.length, S = [x0.slice()];
    for (let i = 0; i < n; i++) { const x = x0.slice(); x[i] += step; S.push(x); }
    let V = S.map(f), trace = [];
    for (let it = 0; it < iters; it++) {
      const idx = V.map((v, i) => i).sort((a, b) => V[a] - V[b]);
      const Ss = idx.map(i => S[i]), Vs = idx.map(i => V[i]); S.splice(0, n + 1, ...Ss); V.splice(0, n + 1, ...Vs);
      trace.push(V[0]);
      const c = new Array(n).fill(0); for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) c[j] += S[i][j] / n;
      const xr = c.map((cj, j) => cj + (cj - S[n][j])), fr = f(xr);
      if (fr < V[0]) { const xe = c.map((cj, j) => cj + 2 * (cj - S[n][j])), fe = f(xe); if (fe < fr) { S[n] = xe; V[n] = fe; } else { S[n] = xr; V[n] = fr; } }
      else if (fr < V[n - 1]) { S[n] = xr; V[n] = fr; }
      else {
        const xc = c.map((cj, j) => cj + 0.5 * (S[n][j] - cj)), fc = f(xc);
        if (fc < V[n]) { S[n] = xc; V[n] = fc; }
        else for (let i = 1; i <= n; i++) { S[i] = S[i].map((v, j) => S[0][j] + 0.5 * (v - S[0][j])); V[i] = f(S[i]); }
      }
      if (n > 0 && Math.abs(V[n] - V[0]) < 1e-7 && it > 40) { trace.push(Math.min(...V)); break; }
    }
    let bi = 0; for (let i = 1; i <= n; i++) if (V[i] < V[bi]) bi = i;
    return { x: S[bi], v: V[bi], trace };
  }
  // run a fit: dials unlocked in `free`, others held at p0; returns the best dials and the traces
  function fit(p0, sp, free, opts) {
    const restarts = (opts && opts.restarts) || 8, iters = (opts && opts.iters) || 320;
    const dials = DIALS.filter(d => free.includes(d.k));
    const toP = x => { const p = Object.assign({}, p0); dials.forEach((d, i) => { p[d.k] = d.min + clamp(x[i], 0, 1) * (d.max - d.min); }); return p; };
    const f = x => lossAt(toP(x), sp);
    let best = null; const traces = [];
    const rng = mulberry32(20261103);
    for (let r = 0; r < restarts; r++) {
      const x0 = dials.map(d => r === 0 ? (p0[d.k] - d.min) / (d.max - d.min) : rng());
      const out = nelderMead(f, x0, 0.18, iters);
      traces.push(out.trace);
      if (!best || out.v < best.v) best = out;
      if (opts && opts.onRestart) opts.onRestart(r, best.v, traces);
    }
    // snap to the dials' steps and polish by coordinate search at one step either way
    let p = toP(best.x);
    dials.forEach(d => { p[d.k] = Math.round(p[d.k] / d.step) * d.step; });
    let v = lossAt(p, sp), moved = true, guard = 0;
    while (moved && guard++ < 60) {
      moved = false;
      for (const d of dials) for (const dir of [-1, 1]) {
        const q = Object.assign({}, p); q[d.k] = clamp(+(p[d.k] + dir * d.step).toFixed(4), d.min, d.max);
        const vq = lossAt(q, sp); if (vq < v - 1e-9) { p = q; v = vq; moved = true; }
      }
    }
    return { p, v, traces };
  }
  function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

  /* ---- seats: chamber totals at the current dials ----------------------- */
  function seatTotals(pred) {
    const byCode = {}; ROWS.forEach((row, i) => byCode[row.ch + ":" + row.code] = pred.m[i]);
    const out = { house: { d: 0, r: 0, ad: 0, ar: 0 }, senate: { d: 0, r: 0, ad: 0, ar: 0 } };
    const tally = (ch, code, proj) => {
      const r = ((RES || {})[ch] || {})[code] || {};
      const k = byCode[ch + ":" + code];
      const party = (typeof k === "number") ? (k >= 0 ? "D" : "R") : (r.winner === "D" || r.winner === "R") ? r.winner : (proj && proj.margin >= 0 ? "D" : "R");
      out[ch][party === "D" ? "d" : "r"]++;
      // actual: the call, else the leader, else the model
      const y = actualMargin(r);
      const ap = (r.winner === "D" || r.winner === "R") ? r.winner : (r.winner === "I" && r.dside === "I") ? "D" : (y !== null) ? (y >= 0 ? "D" : "R") : (proj && proj.margin >= 0 ? "D" : "R");
      out[ch][ap === "D" ? "ad" : "ar"]++;
    };
    for (const id in forecast) tally("house", forecast[id].code, FF && FF.house ? FF.house[forecast[id].code] : null);
    (meta.senate || []).forEach(rc => tally("senate", rc.st, FF && FF.senate ? FF.senate[rc.st] : null));
    const notUpD = (typeof meta.senateNotUpD === "number") ? meta.senateNotUpD : 34;
    out.senate.d += notUpD; out.senate.ad += notUpD; out.senate.r += 100 - notUpD - (meta.senate || []).length; out.senate.ar += 100 - notUpD - (meta.senate || []).length;
    return out;
  }

  /* ---- rendering --------------------------------------------------------- */
  const $ = id => document.getElementById(id);
  let fitting = false;
  const tooltip = $("tooltip");
  function moveTip(evt) {
    const pad = 16, tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
    let x = evt.clientX + pad, y = evt.clientY + pad;
    if (x + tw > window.innerWidth - 8) x = evt.clientX - tw - pad;
    if (y + th > window.innerHeight - 8) y = evt.clientY - th - pad;
    tooltip.style.left = x + "px"; tooltip.style.top = y + "px";
  }
  function showTip(evt, html, wide) { tooltip.innerHTML = html; tooltip.classList.add("on"); tooltip.classList.toggle("wide", !!wide); tooltip.setAttribute("aria-hidden", "false"); moveTip(evt); }
  function hideTip() { tooltip.classList.remove("on", "wide"); tooltip.setAttribute("aria-hidden", "true"); }
  // every label with a data-tip gets the same hover card, in plain language, with the arrow cursor left alone
  function wireTips() {
    document.querySelectorAll(".has-tip[data-tip]").forEach(el => {
      if (el.dataset.tipWired) return;
      const t = TIPS[el.dataset.tip]; if (!t) return;
      el.dataset.tipWired = "1"; el.setAttribute("aria-description", t[1]); if (el.tabIndex < 0) el.tabIndex = 0;
      const show = evt => {
        const html = `<div class="t-code">${t[0]}</div><div class="t-desc">${t[1]}</div>`;
        if (evt && evt.clientX != null) showTip(evt, html, true);
        else { const r = el.getBoundingClientRect(); showTip({ clientX: r.left, clientY: r.bottom }, html, true); }
      };
      el.addEventListener("mouseenter", show); el.addEventListener("mousemove", moveTip);
      el.addEventListener("mouseleave", hideTip); el.addEventListener("focus", show); el.addEventListener("blur", hideTip);
    });
  }

  function renderDials() {
    const host = $("dials"); if (!host) return;
    if (!host.children.length) {
      host.innerHTML = DIALS.map(d => `
        <div class="ballot dial" data-k="${d.k}">
          <div class="ballot-head">
            <label for="dial-${d.k}" class="has-tip" data-tip="${d.k}">${d.label}</label>
            <output id="dial-${d.k}-val"></output>
          </div>
          <input type="range" id="dial-${d.k}" class="dial-range" min="${d.min}" max="${d.max}" step="${d.step}" value="${P[d.k]}" aria-label="${d.label}" />
          <label class="dial-lock has-tip" data-tip="hold"><input type="checkbox" id="lock-${d.k}" /> hold during fit</label>
        </div>`).join("");
      DIALS.forEach(d => {
        $("dial-" + d.k).addEventListener("input", e => { P[d.k] = +e.target.value; BEST = null; renderAll(); });
        $("lock-" + d.k).addEventListener("change", e => { locked[d.k] = e.target.checked; });
      });
      wireTips();
    }
    DIALS.forEach(d => { $("dial-" + d.k).value = String(P[d.k]); $("dial-" + d.k + "-val").textContent = d.fmt(P[d.k]); });
    $("fe-lam").value = String(Math.log10(spec.lam)); $("fe-lam-val").textContent = "\u03bb " + spec.lam.toFixed(1);
    document.querySelectorAll("#fe-toggle button").forEach(b => b.setAttribute("aria-pressed", String((b.dataset.fe === "on") === spec.fe)));
    document.querySelectorAll("#obj-toggle button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.obj === spec.objective)));
    document.querySelectorAll("#target-toggle button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.target === spec.target)));
    document.querySelectorAll("#form-toggle button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.form === spec.form)));
    $("lam-wrap").classList.toggle("is-off", !spec.fe);
  }

  function renderReadouts(pred, sc) {
    const seats = seatTotals(pred);
    $("ro-right").textContent = `${sc.right} of ${sc.n}`;
    $("ro-right-note").textContent = spec.fe ? `${sc.cvRight} of ${sc.n} cross-validated` : `${(100 * sc.right / sc.n).toFixed(1)}% of scored races`;
    $("ro-rmse").textContent = sc.rmse.toFixed(2);
    $("ro-rmse-note").textContent = spec.fe ? `${sc.cvRmse.toFixed(2)} cross-validated` : `average miss ${sc.mae.toFixed(2)} pts`;
    $("ro-house").innerHTML = `<span class="d">${seats.house.d}</span> <span class="vs">vs</span> <span class="d">${seats.house.ad}</span>`;
    $("ro-house-note").textContent = `Democratic seats, dials vs. result`;
    $("ro-senate").innerHTML = `<span class="d">${seats.senate.d}</span> <span class="vs">vs</span> <span class="d">${seats.senate.ad}</span>`;
    $("ro-senate-note").textContent = `Democratic seats, dials vs. result`;
    $("ro-env").textContent = fmtGB(P.S);
    $("ro-env-note").textContent = `polls ${fmtGB(GB)} · model ${fmtGB(FROZEN.S)}`;
    const frozen = scoreOf(predictAll(FROZEN, Object.assign({}, spec, { fe: false })));
    $("compare").innerHTML = `
      <tr><th></th><th>Frozen model</th><th>Current dials</th>${BEST ? "<th>Best fit</th>" : ""}</tr>
      <tr><td>Races called right</td><td>${frozen.right} of ${frozen.n}</td><td>${sc.right} of ${sc.n}</td>${BEST ? `<td>${BEST.sc.right} of ${BEST.sc.n}</td>` : ""}</tr>
      <tr><td>Root mean square miss, points</td><td>${frozen.rmse.toFixed(2)}</td><td>${sc.rmse.toFixed(2)}</td>${BEST ? `<td>${BEST.sc.rmse.toFixed(2)}</td>` : ""}</tr>
      <tr><td>Robust (Huber) miss, points</td><td>${frozen.huber.toFixed(2)}</td><td>${sc.huber.toFixed(2)}</td>${BEST ? `<td>${BEST.sc.huber.toFixed(2)}</td>` : ""}</tr>
      <tr><td>Log loss on the winner</td><td>${frozen.logloss.toFixed(3)}</td><td>${sc.logloss.toFixed(3)}</td>${BEST ? `<td>${BEST.sc.logloss.toFixed(3)}</td>` : ""}</tr>
      ${spec.fe ? `<tr><td>Cross-validated, right / RMSE</td><td>n/a</td><td>${sc.cvRight} / ${sc.cvRmse.toFixed(2)}</td>${BEST ? `<td>${BEST.sc.cvRight} / ${BEST.sc.cvRmse.toFixed(2)}</td>` : ""}</tr>` : ""}
      ${DIALS.map(d => `<tr><td>${d.label}</td><td>${d.fmt(FROZEN[d.k])}</td><td>${d.fmt(P[d.k])}</td>${BEST ? `<td>${d.fmt(BEST.p[d.k])}</td>` : ""}</tr>`).join("")}`;
  }

  /* training curve */
  function renderCurve(traces, label) {
    const svg = d3.select("#curve-svg"); svg.selectAll("*").remove();
    const W = 1000, H = 300, M = { t: 18, r: 20, b: 34, l: 54 };
    if (!traces || !traces.length) { svg.append("text").attr("x", W / 2).attr("y", H / 2).attr("text-anchor", "middle").attr("fill", "#9aa0a8").attr("font-size", 14).text("Press Fit to train"); return; }
    let offset = 0; const segs = [], all = [];
    traces.forEach(t => { const seg = t.map((v, i) => ({ x: offset + i, v })); offset += t.length; segs.push(seg); seg.forEach(d => all.push(d)); });
    let best = Infinity; const bestLine = all.map(d => { best = Math.min(best, d.v); return { x: d.x, v: best }; });
    const x = d3.scaleLinear().domain([0, offset]).range([M.l, W - M.r]);
    const lo = d3.min(all, d => d.v), hi = d3.quantile(all.map(d => d.v).sort(d3.ascending), 0.97);
    const y = d3.scaleLinear().domain([lo - (hi - lo) * 0.08, hi]).range([H - M.b, M.t]).nice();
    svg.append("g").attr("transform", `translate(0,${H - M.b})`).call(d3.axisBottom(x).ticks(8).tickSize(0)).call(g => g.select(".domain").attr("stroke", "#d6d8db"));
    svg.append("g").attr("transform", `translate(${M.l},0)`).call(d3.axisLeft(y).ticks(5).tickSize(-(W - M.l - M.r)).tickFormat(d3.format(spec.objective === "winners" ? ".3f" : ".2f")))
      .call(g => g.select(".domain").remove()).call(g => g.selectAll("line").attr("stroke", "#eceef0"));
    svg.selectAll("text").attr("fill", "#9aa0a8").attr("font-size", 11);
    const line = d3.line().x(d => x(d.x)).y(d => y(Math.min(d.v, y.domain()[1]))).curve(d3.curveMonotoneX);
    segs.forEach(seg => svg.append("path").datum(seg).attr("d", line).attr("fill", "none").attr("stroke", "#c9ccd1").attr("stroke-width", 1));
    svg.append("path").datum(bestLine).attr("d", line).attr("fill", "none").attr("stroke", "#2e74d0").attr("stroke-width", 2.2);
    svg.append("text").attr("x", W - M.r).attr("y", H - 6).attr("text-anchor", "end").attr("fill", "#9aa0a8").attr("font-size", 11).text("iterations, across restarts");
    svg.append("text").attr("x", M.l).attr("y", 12).attr("fill", "#5b6068").attr("font-size", 12).attr("font-weight", 700).text(label || "");
  }

  /* the economy dial: loss as the level moves, others held */
  function renderProfile(profile) {
    const svg = d3.select("#profile-svg"); svg.selectAll("*").remove();
    const W = 560, H = 300, M = { t: 18, r: 18, b: 34, l: 54 };
    const d = DIALS.find(d => d.k === "shock");
    const pts = []; for (let v = d.min; v <= d.max + 1e-9; v += 0.25) { const q = Object.assign({}, P, { shock: v }); pts.push({ v: +v.toFixed(2), loss: lossAt(q, spec) }); }
    const x = d3.scaleLinear().domain([d.min, d.max]).range([M.l, W - M.r]);
    const ext = d3.extent(pts.concat(profile || []), p => p.loss);
    const y = d3.scaleLinear().domain([ext[0] - (ext[1] - ext[0]) * 0.1, ext[1] + (ext[1] - ext[0]) * 0.1]).range([H - M.b, M.t]).nice();
    svg.append("g").attr("transform", `translate(0,${H - M.b})`).call(d3.axisBottom(x).ticks(10).tickSize(0).tickFormat(v => v + " pts")).call(g => g.select(".domain").attr("stroke", "#d6d8db"));
    svg.append("g").attr("transform", `translate(${M.l},0)`).call(d3.axisLeft(y).ticks(5).tickSize(-(W - M.l - M.r)).tickFormat(d3.format(spec.objective === "winners" ? ".3f" : ".2f")))
      .call(g => g.select(".domain").remove()).call(g => g.selectAll("line").attr("stroke", "#eceef0"));
    svg.selectAll("text").attr("fill", "#9aa0a8").attr("font-size", 11);
    const line = d3.line().x(p => x(p.v)).y(p => y(p.loss)).curve(d3.curveMonotoneX);
    if (profile && profile.length) svg.append("path").datum(profile).attr("d", line).attr("fill", "none").attr("stroke", "#0d52bd").attr("stroke-width", 2).attr("stroke-dasharray", "5 4");
    svg.append("path").datum(pts).attr("d", line).attr("fill", "none").attr("stroke", "#2e74d0").attr("stroke-width", 2.2);
    const bestPt = pts.reduce((a, b) => b.loss < a.loss ? b : a);
    svg.append("line").attr("x1", x(ECON_MAX)).attr("x2", x(ECON_MAX)).attr("y1", M.t).attr("y2", H - M.b).attr("stroke", "#c9ccd1").attr("stroke-dasharray", "3 4");
    svg.append("text").attr("x", x(ECON_MAX) + 5).attr("y", M.t + 12).attr("fill", "#9aa0a8").attr("font-size", 11).text("forecast page's limit");
    svg.append("circle").attr("cx", x(P.shock)).attr("cy", y(lossAt(P, spec))).attr("r", 5).attr("fill", "#fff").attr("stroke", "#2e74d0").attr("stroke-width", 2);
    svg.append("circle").attr("cx", x(bestPt.v)).attr("cy", y(bestPt.loss)).attr("r", 3.5).attr("fill", "#2e74d0");
    svg.append("text").attr("x", x(bestPt.v)).attr("y", y(bestPt.loss) - 10).attr("text-anchor", "middle").attr("fill", "#2e74d0").attr("font-size", 11).attr("font-weight", 700).text(`best ${bestPt.v.toFixed(2)} pts (others held)`);
    $("profile-note").textContent = profile && profile.length
      ? `Solid: the loss as only the Fundamentals dial moves, everything else at its current setting. Dashed: the other dials (threshold aside) refit at each size of the shock, which is the dial's real profile.`
      : `The loss as only the Fundamentals dial moves, everything else at its current setting. Refit the other dials at each size of the shock for the dial's real profile.`;
  }

  /* level x threshold heatmap */
  function renderHeat() {
    const svg = d3.select("#heat-svg"); svg.selectAll("*").remove();
    const W = 560, H = 300, M = { t: 18, r: 18, b: 34, l: 54 };
    const lv = d3.range(0, 20.01, 2), th = d3.range(5, 10.51, 0.5);
    const cells = []; lv.forEach(l => th.forEach(t => cells.push({ l, t, loss: lossAt(Object.assign({}, P, { shock: l, thr: t }), spec) })));
    const x = d3.scaleBand().domain(lv).range([M.l, W - M.r]).paddingInner(0.08), y = d3.scaleBand().domain(th).range([H - M.b, M.t]).paddingInner(0.08);
    const ext = d3.extent(cells, c => c.loss);
    const col = d3.scaleSequential(d3.interpolateRgb("#0d52bd", "#eef3fb")).domain(ext);
    svg.selectAll("rect").data(cells).join("rect").attr("x", c => x(c.l)).attr("y", c => y(c.t)).attr("width", x.bandwidth()).attr("height", y.bandwidth()).attr("rx", 2).attr("fill", c => col(c.loss))
      .on("mouseenter", (ev, c) => showTip(ev, `<div class="t-code">${c.l}-point shock, threshold ${c.t.toFixed(1)}</div><div class="t-row"><span>Loss</span><b>${c.loss.toFixed(3)}</b></div><div class="t-row"><span>States above</span><b>${Object.keys(ECON).filter(st => ECON[st].m > c.t).length}</b></div>`))
      .on("mousemove", moveTip).on("mouseleave", hideTip);
    const best = cells.reduce((a, b) => b.loss < a.loss ? b : a);
    svg.append("rect").attr("x", x(best.l)).attr("y", y(best.t)).attr("width", x.bandwidth()).attr("height", y.bandwidth()).attr("rx", 2).attr("fill", "none").attr("stroke", "#0f1115").attr("stroke-width", 1.6);
    svg.append("g").attr("transform", `translate(0,${H - M.b})`).call(d3.axisBottom(x).tickValues(lv).tickSize(0).tickFormat(v => v + " pts")).call(g => g.select(".domain").remove());
    svg.append("g").attr("transform", `translate(${M.l},0)`).call(d3.axisLeft(y).tickValues(th.filter((v, i) => i % 2 === 0)).tickSize(0).tickFormat(v => v.toFixed(1))).call(g => g.select(".domain").remove());
    svg.selectAll("text").attr("fill", "#9aa0a8").attr("font-size", 11);
    svg.append("text").attr("x", W - M.r).attr("y", H - 6).attr("text-anchor", "end").attr("fill", "#9aa0a8").attr("font-size", 11).text("size of the shock");
    svg.append("text").attr("transform", `translate(12,${(H - M.b + M.t) / 2}) rotate(-90)`).attr("text-anchor", "middle").attr("fill", "#9aa0a8").attr("font-size", 11).text("misery threshold");
    $("heat-note").textContent = `Darker is a better fit. The outlined cell, a ${best.l}-point shock at a threshold of ${best.t.toFixed(1)}, is the best of this grid with the other dials where they are.`;
  }

  /* states above the threshold: the shock each takes and what it explains */
  function renderStates(pred) {
    const sp0 = Object.assign({}, spec), p0 = Object.assign({}, P, { shock: 0 });
    const pre = predictAll(p0, sp0);    // the same dials with the economy dial off
    const by = {};
    ROWS.forEach((row, i) => { const b = by[row.st] || (by[row.st] = { n: 0, pre: 0, post: 0 }); b.n++; b.pre += row.y - pre.m[i]; b.post += row.y - pred.m[i]; });
    const rows = Object.keys(ECON).filter(st => ECON[st].m > P.thr).sort((a, b) => ECON[b].m - ECON[a].m).map(st => {
      const e = ECON[st], b = by[st] || { n: 0, pre: 0, post: 0 }, shock = econShock(st, P, spec);
      return `<tr><td>${STATE_NAMES[st] || st}</td><td>${e.m.toFixed(1)}</td><td>${e.g === "D" ? "Democratic" : "Republican"}</td><td class="${shock >= 0 ? "d" : "r"}">${shock >= 0 ? "D" : "R"} ${Math.abs(shock).toFixed(2)}</td><td>${b.n}</td><td class="${b.pre >= 0 ? "d" : "r"}">${b.n ? fmtMargin(b.pre / b.n) : "n/a"}</td><td class="${b.post >= 0 ? "d" : "r"}">${b.n ? fmtMargin(b.post / b.n) : "n/a"}</td></tr>`;
    });
    $("state-table").innerHTML = `<tr><th>State above threshold</th><th>Misery</th><th>Governor</th><th>Shock, pts</th><th>Races</th><th>Avg miss, dial off</th><th>Avg miss, dial on</th></tr>${rows.join("")}`;
    $("state-note").textContent = rows.length
      ? `${rows.length} states clear a threshold of ${P.thr.toFixed(1)}. The last two columns are the average result minus prediction across each state's scored races with the Fundamentals dial at zero and at its current setting, so a D miss that shrinks when the dial is on means the shock is pulling in the right direction there.`
      : `No state clears a threshold of ${P.thr.toFixed(1)}; lower it to bring the economy dial into play.`;
  }

  /* predicted vs. actual */
  function renderScatter(pred) {
    const svg = d3.select("#fit-svg"); svg.selectAll("*").remove();
    const W = 1000, H = 560, M = { t: 20, r: 20, b: 40, l: 54 };
    const pts = ROWS.map((row, i) => ({ row, x: pred.m[i], y: row.y, miss: (pred.m[i] >= 0) !== (row.y >= 0) }));
    const lim = Math.ceil(d3.max(pts, p => Math.max(Math.abs(p.x), Math.abs(p.y))) / 10) * 10;
    const x = d3.scaleLinear().domain([-lim, lim]).range([M.l, W - M.r]), y = d3.scaleLinear().domain([-lim, lim]).range([H - M.b, M.t]);
    const fmtAx = v => v === 0 ? "Even" : (v > 0 ? "D+" : "R+") + Math.abs(v);
    svg.append("g").attr("transform", `translate(0,${H - M.b})`).call(d3.axisBottom(x).ticks(8).tickSize(-(H - M.t - M.b)).tickFormat(fmtAx)).call(g => g.select(".domain").remove()).call(g => g.selectAll("line").attr("stroke", "#eceef0"));
    svg.append("g").attr("transform", `translate(${M.l},0)`).call(d3.axisLeft(y).ticks(8).tickSize(-(W - M.l - M.r)).tickFormat(fmtAx)).call(g => g.select(".domain").remove()).call(g => g.selectAll("line").attr("stroke", "#eceef0"));
    svg.selectAll("text").attr("fill", "#9aa0a8").attr("font-size", 11);
    svg.append("line").attr("x1", x(-lim)).attr("y1", y(-lim)).attr("x2", x(lim)).attr("y2", y(lim)).attr("stroke", "#c9ccd1").attr("stroke-dasharray", "4 4");
    svg.append("line").attr("x1", x(0)).attr("x2", x(0)).attr("y1", M.t).attr("y2", H - M.b).attr("stroke", "#d6d8db");
    svg.append("line").attr("y1", y(0)).attr("y2", y(0)).attr("x1", M.l).attr("x2", W - M.r).attr("stroke", "#d6d8db");
    svg.append("g").selectAll("circle").data(pts).join("circle")
      .attr("cx", p => x(p.x)).attr("cy", p => y(p.y)).attr("r", p => p.row.ch === "senate" ? 5 : 3.6)
      .attr("fill", p => p.y >= 0 ? "#2e74d0" : "#e24b38").attr("fill-opacity", p => p.miss ? 0.9 : 0.45)
      .attr("stroke", p => p.miss ? "#0f1115" : "none").attr("stroke-width", 1.4)
      .on("mouseenter", (ev, p) => showTip(ev, `<div class="t-code">${p.row.code}${p.row.ch === "senate" ? " Senate" : ""}</div><div class="t-row"><span>Predicted</span><b>${fmtMargin(p.x)}</b></div><div class="t-row"><span>Result${p.row.called ? "" : " so far"}</span><b>${fmtMargin(p.y)}</b></div><div class="t-row"><span>Miss</span><b>${fmtMargin(p.y - p.x)}</b></div>`))
      .on("mousemove", moveTip).on("mouseleave", hideTip);
    svg.append("text").attr("x", W - M.r).attr("y", H - 8).attr("text-anchor", "end").attr("fill", "#9aa0a8").attr("font-size", 11).text("predicted margin at these dials");
    svg.append("text").attr("transform", `translate(14,${(H - M.b + M.t) / 2}) rotate(-90)`).attr("text-anchor", "middle").attr("fill", "#9aa0a8").attr("font-size", 11).text("actual margin");
    const misses = pts.filter(p => p.miss).sort((a, b) => Math.abs(b.y - b.x) - Math.abs(a.y - a.x));
    $("miss-count").textContent = misses.length ? `${misses.length} race${misses.length === 1 ? "" : "s"} still called wrong` : "every scored race called right";
    $("misses").innerHTML = misses.map(p => `<div class="bg-cell"><div class="bg-code">${p.row.code}${p.row.ch === "senate" ? " <span class=\"bg-ch\">Senate</span>" : ""}</div><div class="bg-margin ${p.y >= 0 ? "d" : "r"}">Result ${fmtMargin(p.y)}${p.row.called ? "" : "*"}</div><div class="bg-prob">dials said ${fmtMargin(p.x)}</div></div>`).join("") || `<div class="bg-cell"><div class="bg-prob">none</div></div>`;
  }

  function renderAll() {
    if (!ROWS.length) return;
    renderDials();
    const pred = predictAll(P, spec), sc = scoreOf(pred);
    renderReadouts(pred, sc); renderProfile(null); renderHeat(); renderStates(pred); renderScatter(pred);
    const called = ROWS.filter(r => r.called).length;
    $("stamp").textContent = `Results as of ${RES && RES.fetched ? new Date(RES.fetched).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "n/a"} · ${sc.n} races scored, ${called} called`;
  }

  /* ---- fitting, animated across restarts --------------------------------- */
  function runFit() {
    if (fitting || !ROWS.length) return;
    fitting = true; $("fit-btn").disabled = true; $("fit-btn").textContent = "Fitting…";
    const free = DIALS.map(d => d.k).filter(k => !locked[k]);
    const traces = []; let r = 0; const restarts = 8;
    const p0 = Object.assign({}, P), sp = Object.assign({}, spec);
    let best = null;
    const dials = DIALS.filter(d => free.includes(d.k));
    const toP = x => { const p = Object.assign({}, p0); dials.forEach((d, i) => { p[d.k] = d.min + clamp(x[i], 0, 1) * (d.max - d.min); }); return p; };
    const f = x => lossAt(toP(x), sp);
    const rng = mulberry32(20261103 + ROWS.length);
    const step = () => {
      const x0 = dials.map(d => r === 0 ? (p0[d.k] - d.min) / (d.max - d.min) : rng());
      const out = nelderMead(f, x0, 0.18, 320);
      traces.push(out.trace);
      if (!best || out.v < best.v) best = out;
      renderCurve(traces, `restart ${r + 1} of ${restarts} · best ${best.v.toFixed(spec.objective === "winners" ? 4 : 3)}`);
      r++;
      if (r < restarts) setTimeout(step, 30);
      else finish();
    };
    const finish = () => {
      let p = toP(best.x);
      dials.forEach(d => { p[d.k] = Math.round(p[d.k] / d.step) * d.step; });
      let v = lossAt(p, sp), moved = true, guard = 0;
      while (moved && guard++ < 60) {
        moved = false;
        for (const d of dials) for (const dir of [-1, 1]) {
          const q = Object.assign({}, p); q[d.k] = clamp(+(p[d.k] + dir * d.step).toFixed(4), d.min, d.max);
          const vq = lossAt(q, sp); if (vq < v - 1e-9) { p = q; v = vq; moved = true; }
        }
      }
      P = p; BEST = { p: Object.assign({}, p), v, sc: scoreOf(predictAll(p, sp)) };
      fitting = false; $("fit-btn").disabled = false; $("fit-btn").textContent = "Fit";
      renderAll();
      renderCurve(traces, `best ${v.toFixed(spec.objective === "winners" ? 4 : 3)} after ${restarts} restarts`);
      $("fit-summary").innerHTML = summary(BEST);
    };
    setTimeout(step, 10);
  }
  function summary(b) {
    const d = k => DIALS.find(x => x.k === k).fmt(b.p[k]);
    const over = Object.keys(ECON).filter(st => ECON[st].m > b.p.thr).length;
    return `Best fit on <b>${spec.objective === "winners" ? "winners" : spec.objective === "rmse" ? "margins" : "margins, robust"}</b>${spec.fe ? " with state effects" : ""}: an environment of <b>${d("S")}</b> (the polls said ${fmtGB(GB)}, the model ran ${fmtGB(FROZEN.S)}), elasticity <b>${d("kel")}</b>, mail-in drag <b>${d("mail")}</b>, a Fundamentals shock of <b>${d("shock")}</b> above a misery threshold of <b>${d("thr")}</b> (${over} states), fundraising <b>${d("wf")}</b>. It calls <b>${b.sc.right} of ${b.sc.n}</b> races right with a root mean square miss of <b>${b.sc.rmse.toFixed(2)}</b> points${spec.fe ? `, or ${b.sc.cvRight} of ${b.sc.n} and ${b.sc.cvRmse.toFixed(2)} once each state's effect is estimated without the race being scored` : ""}.`;
  }

  // the dial's profile: refit everything else at each level of the economy dial
  function runProfile() {
    if (fitting || !ROWS.length) return;
    fitting = true; const btn = $("profile-btn"); btn.disabled = true; btn.textContent = "Refitting…";
    // the threshold stays put: free, it would climb above every state and make any shock size fit equally well
    const free = DIALS.map(d => d.k).filter(k => !locked[k] && k !== "shock" && k !== "thr");
    const levels = d3.range(0, 20.01, 1), out = []; let i = 0;
    const step = () => {
      const shock = levels[i];
      const res = fit(Object.assign({}, P, { shock }), spec, free, { restarts: 3, iters: 220 });
      out.push({ v: shock, loss: res.v });
      btn.textContent = `Refitting… ${Math.round(100 * (i + 1) / levels.length)}%`;
      i++;
      if (i < levels.length) setTimeout(step, 10);
      else { fitting = false; btn.disabled = false; btn.textContent = "Refit the other dials at each size"; renderProfile(out); }
    };
    setTimeout(step, 10);
  }

  /* ---- wiring ------------------------------------------------------------ */
  function wire() {
    $("fit-btn").addEventListener("click", runFit);
    $("reset-btn").addEventListener("click", () => { P = Object.assign({}, FROZEN); BEST = null; $("fit-summary").textContent = ""; renderCurve(null); renderAll(); });
    $("profile-btn").addEventListener("click", runProfile);
    $("obj-toggle").addEventListener("click", e => { const b = e.target.closest("button[data-obj]"); if (!b) return; spec.objective = b.dataset.obj; BEST = null; renderCurve(null); renderAll(); });
    $("fe-toggle").addEventListener("click", e => { const b = e.target.closest("button[data-fe]"); if (!b) return; spec.fe = b.dataset.fe === "on"; BEST = null; renderAll(); });
    $("target-toggle").addEventListener("click", e => { const b = e.target.closest("button[data-target]"); if (!b) return; spec.target = b.dataset.target; BEST = null; renderAll(); });
    $("form-toggle").addEventListener("click", e => { const b = e.target.closest("button[data-form]"); if (!b) return; spec.form = b.dataset.form; BEST = null; renderAll(); });
    $("fe-lam").addEventListener("input", e => { spec.lam = +Math.pow(10, +e.target.value).toFixed(1); BEST = null; renderAll(); });
    $("lam-btn").addEventListener("click", () => {
      // tune the ridge penalty by leave-one-out cross-validation at the current dials
      let best = null;
      d3.range(-1, 2.01, 0.1).forEach(lg => { const sp = Object.assign({}, spec, { fe: true, lam: Math.pow(10, lg) }); const sc = scoreOf(predictAll(P, sp)); const v = spec.objective === "winners" ? -sc.cvRight + sc.cvRmse / 1000 : sc.cvRmse; if (!best || v < best.v) best = { v, lam: Math.pow(10, lg) }; });
      spec.fe = true; spec.lam = +best.lam.toFixed(1); BEST = null; renderAll();
    });
  }

  async function getJSON(name) {
    const r = await fetch(name + "?t=" + Date.now(), { cache: "no-store" });
    if (!r.ok) throw new Error(name + " " + r.status);
    return r.json();
  }
  (async function init() {
    wire(); wireTips(); renderCurve(null);
    try { FF = await getJSON("final-forecast.json"); if (FF && typeof FF.effectiveBallot === "number") { FROZEN.S = FF.effectiveBallot; P.S = FROZEN.S; } } catch (e) { /* the frozen file is optional */ }
    try { RES = await getJSON("results.json"); } catch (e) { $("stamp").textContent = "Could not load results.json"; return; }
    buildRows(); renderAll();
  })();
})();
