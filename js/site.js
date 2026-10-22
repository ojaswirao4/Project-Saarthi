/* Site shell: theme, nav, reveals, hero twin, live graph, closed-loop stepper, benchmark. */
(function () {
  'use strict';
  const S = window.SAARTHI;
  const $ = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ------------------------------------------------------------------ theme toggle
  $('#theme-btn').addEventListener('click', () => {
    const root = document.documentElement;
    const dark = root.dataset.theme ? root.dataset.theme === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = dark ? 'light' : 'dark';
    try { localStorage.setItem('saarthi-theme', root.dataset.theme); } catch (e) {}
    document.dispatchEvent(new Event('themechange'));
  });

  // ------------------------------------------------------------------ nav + reveals
  const nav = $('#nav');
  window.addEventListener('scroll', () => nav.classList.toggle('scrolled', window.scrollY > 8), { passive: true });
  const links = $$('.nav-links a');
  const secObs = new IntersectionObserver(es => {
    for (const e of es) if (e.isIntersecting) links.forEach(a => a.classList.toggle('active', a.getAttribute('href') === `#${e.target.id}`));
  }, { rootMargin: '-45% 0px -50% 0px' });
  $$('section[id]').forEach(s => secObs.observe(s));

  let pending = $$('.reveal');
  let revealQueued = false;
  function revealCheck() {
    revealQueued = false;
    const limit = window.innerHeight * 0.92;
    let k = 0;
    pending = pending.filter(el => {
      if (el.getBoundingClientRect().top > limit) return true;
      const delay = reduced ? 0 : (k++ % 6) * 70;
      setTimeout(() => el.classList.add('in'), delay);
      return false;
    });
  }
  const queueReveal = () => { if (!revealQueued) { revealQueued = true; requestAnimationFrame(revealCheck); } };
  window.addEventListener('scroll', queueReveal, { passive: true });
  window.addEventListener('resize', queueReveal);
  window.addEventListener('load', revealCheck);
  revealCheck();

  // ------------------------------------------------------------------ hero twin
  const HERO_THEME = {
    ground: '#0b1018', block: '#12201a', blockText: '#5f8269', road: '#262d38', median: '#1a2029',
    lane: 'rgba(255,255,255,0.18)', kerb: 'rgba(255,255,255,0.28)', parked: '#000', label: '#e6ebf2', label2: '#7d8898',
    accent: '#5aa2ff', green: '#0ca30c', amber: '#fab219', red: '#d03b3b', types: {},
  };
  let hero = null;
  const rHero = new window.Renderer($('#cv-hero'));
  rHero.theme = HERO_THEME;
  rHero.selected = null;
  // The hero and the graph view in section 02 both run on the real Film City road network (OpenStreetMap).
  const HERO_NET = (window.SAARTHI_NETWORKS || {}).fco ? 'fco' : 'fc';
  let gsim = null, graphBuilt = false;
  function newHero() {
    hero = new S.Sim({ mode: 'adaptive', seed: 21, startHour: 8.75, warmup: true, network: HERO_NET });
    for (let i = 0; i < 600 / S.DT; i++) hero.step();
    rHero.sim = hero;
    gsim = hero;
    if (graphBuilt) { svg.innerHTML = ''; buildGraph(); } // point the graph at the new sim
  }
  newHero();
  let heroVisible = true, graphVisible = false;
  new IntersectionObserver(es => { heroVisible = es[es.length - 1].isIntersecting; if (heroVisible) rHero.resize(); }).observe($('.hero'));
  new IntersectionObserver(es => { graphVisible = es[es.length - 1].isIntersecting; }).observe($('#graph-svg'));
  window.addEventListener('resize', () => rHero.resize());
  rHero.resize();

  let hLast = performance.now(), hAcc = 0, hUi = 0;
  function heroFrame(now) {
    const dt = Math.min(0.1, (now - hLast) / 1000);
    hLast = now;
    if (heroVisible || graphVisible) {
      hAcc += dt * (reduced ? 1 : 4);
      while (hAcc >= S.DT) { hero.step(); hAcc -= S.DT; }
      if (hero.t > 10.5 * 3600) newHero();
      if (heroVisible) rHero.draw(now);
      if (now - hUi > 500) {
        hUi = now;
        $('#hero-clock').textContent = S.fmtClock(hero.t).slice(0, 5);
        let n = 0, v = 0;
        for (const L of hero.linkList) for (const arr of L.lane) for (const veh of arr) { n++; v += veh.v; }
        $('#hero-stat').textContent = `${n} vehicles · avg ${n ? Math.round(v / n * 3.6) : 0} km/h`;
        if (graphVisible) updateGraph();
      }
    }
    requestAnimationFrame(heroFrame);
  }

  // ------------------------------------------------------------------ live graph
  const svg = $('#graph-svg');
  const NS = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs, parent) => {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    (parent || svg).appendChild(e);
    return e;
  };
  // Every road is drawn along its real OpenStreetMap geometry; every intersection is a node.
  const graph = { edges: [], nodes: [], tags: [], k: 1 };
  function buildGraph() {
    graph.edges = []; graph.nodes = []; graph.tags = [];
    const size = gsim.net.size || { w: 1000, h: 640 };
    const k = graph.k = 1000 / size.w, H = Math.round(size.h * k);
    svg.setAttribute('viewBox', `0 0 1000 ${H}`);
    const P = pts => pts.map(p => `${(p[0] * k).toFixed(1)},${(p[1] * k).toFixed(1)}`).join(' ');

    // one drawn edge per road segment (both directions of a two-way road share it), underpasses first, flyovers last
    const pairs = new Map();
    for (const L of gsim.linkList) {
      const key = [L.from, L.to].sort().join('|');
      if (!pairs.has(key)) pairs.set(key, []);
      pairs.get(key).push(L);
    }
    const segs = [...pairs.values()].sort((a, b) => (a[0].level || 0) - (b[0].level || 0));
    const gEdges = el('g', {}), gFlow = el('g', {}), gNodes = el('g', {}), gText = el('g', {});
    for (const ls of segs) {
      const L = ls[0], lanes = ls.reduce((a, x) => a + x.lanes, 0), d = P(L.pts);
      if (L.level > 0) el('polyline', { points: d, fill: 'none', stroke: 'var(--surface)', 'stroke-width': lanes * 1.3 + 4, 'stroke-linecap': 'round' }, gEdges);
      const line = el('polyline', { points: d, fill: 'none', class: 'edge', 'stroke-width': Math.max(2.4, lanes * 1.3), stroke: '#0ca30c', 'stroke-opacity': L.level < 0 ? 0.45 : 0.85, 'stroke-linejoin': 'round' }, gEdges);
      const flow = L.length * k > 12
        ? el('polyline', { points: d, fill: 'none', class: 'flow', 'stroke-width': 1.4, stroke: 'rgba(255,255,255,0.85)' }, gFlow) : null;
      graph.edges.push({ ls, line, flow });
    }

    // nodes: every real intersection (three or more arms); the queue counts stopped vehicles on its approaches
    const into = {}, deg = {};
    for (const L of gsim.linkList) {
      (into[L.to] = into[L.to] || []).push(L);
      deg[L.from] = (deg[L.from] || 0) + 1; deg[L.to] = (deg[L.to] || 0) + 1;
    }
    for (const j of gsim.isects) {
      if ((deg[j.id] || 0) < 3) continue;
      const sig = gsim.junctions.includes(j);
      const c = el('circle', { cx: j.x * k, cy: j.y * k, r: 3, class: 'node', fill: 'var(--surface)', stroke: sig ? 'var(--accent)' : 'var(--ink-2)', 'stroke-width': sig ? 2.4 : 1.4 }, gNodes);
      graph.nodes.push({ j, c, sig, approaches: into[j.id] || [] });
    }
    for (const x of gsim.externals) el('circle', { cx: x.x * k, cy: x.y * k, r: 3, fill: 'var(--surface-3)', stroke: 'var(--line-2)' }, gNodes);

    // real road names, once each, along the longest stretch of that road
    const best = {};
    for (const L of gsim.linkList) {
      if (!L.name || / road [A-Z]\d+→/.test(L.name) || L.length * k < 40) continue;
      if (!best[L.name] || L.length > best[L.name].length) best[L.name] = L;
    }
    for (const name in best) {
      const L = best[name], m = L.pts[Math.floor(L.pts.length / 2)], a = L.pts[Math.max(0, Math.floor(L.pts.length / 2) - 1)];
      const b = L.pts[Math.min(L.pts.length - 1, Math.floor(L.pts.length / 2) + 1)];
      let ang = Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI;
      if (ang > 90) ang -= 180; else if (ang < -90) ang += 180;
      const t = el('text', { x: m[0] * k, y: m[1] * k - 6, transform: `rotate(${ang.toFixed(1)} ${(m[0] * k).toFixed(1)} ${(m[1] * k).toFixed(1)})`, 'text-anchor': 'middle', 'font-size': 14, fill: 'var(--muted)' }, gText);
      t.textContent = name;
    }
    const seen = new Set();
    for (const lb of gsim.net.labels || []) {
      if (seen.has(lb.text) || lb.offmap) continue;
      seen.add(lb.text);
      el('rect', { x: lb.x * k - 4, y: lb.y * k - 4, width: 8, height: 8, rx: 2, fill: lb.kind === 'hospital' ? '#d03b3b' : 'var(--accent)' }, gText);
      const right = lb.x * k > 800; // keep labels near the right edge inside the frame
      const t = el('text', { x: lb.x * k + (right ? -8 : 8), y: lb.y * k + 5, 'text-anchor': right ? 'end' : 'start', 'font-size': 16, 'font-weight': 600, fill: 'var(--ink-2)' }, gText);
      t.textContent = lb.text;
    }
    for (let i = 0; i < 3; i++) graph.tags.push(el('text', { 'font-size': 16, 'font-weight': 700, fill: 'var(--ink)', 'text-anchor': 'middle' }, gText));
  }
  function occColor(o) { return o < 0.35 ? '#0ca30c' : o < 0.6 ? '#fab219' : '#d03b3b'; }
  function updateGraph() {
    for (const e of graph.edges) {
      let occ = 0, spd = Infinity;
      for (const L of e.ls) { occ = Math.max(occ, L.occ); spd = Math.min(spd, L.meanSpeed); }
      e.line.setAttribute('stroke', occColor(occ));
      if (e.flow) e.flow.style.animationDuration = `${Math.max(0.5, Math.min(4, 8 / Math.max(spd, 0.5)))}s`;
    }
    for (const n of graph.nodes) {
      let q = 0;
      for (const L of n.approaches) for (const arr of L.lane) for (const v of arr) if (v.v < 2 && L.length - v.pos < 150) q += v.pcu;
      n.q = q;
      n.c.setAttribute('r', 3 + Math.min(11, Math.sqrt(q) * 1.4));
      n.c.setAttribute('stroke', q > 40 ? '#d03b3b' : q > 15 ? '#fab219' : n.sig ? 'var(--accent)' : 'var(--ink-2)');
    }
    // label the three intersections with the longest queues right now
    const top = graph.nodes.filter(n => n.q >= 5).sort((a, b) => b.q - a.q).slice(0, 3);
    graph.tags.forEach((t, i) => {
      const n = top[i];
      t.style.display = n ? '' : 'none';
      if (!n) return;
      const r = 3 + Math.min(11, Math.sqrt(n.q) * 1.4);
      t.setAttribute('x', n.j.x * graph.k);
      t.setAttribute('y', n.j.y * graph.k - r - 6);
      t.textContent = `${Math.round(n.q)} PCU queued`;
    });
  }
  buildGraph();
  graphBuilt = true;
  updateGraph();
  requestAnimationFrame(heroFrame);

  // ------------------------------------------------------------------ closed loop
  const STAGES = [
    { n: '01', name: 'Sense', sub: 'see every lane',
      does: 'Live vehicle counts, queue lengths, stopped and illegally parked vehicles, incidents.',
      ai: 'Computer vision on existing CCTV (YOLOv11 + BoT-SORT at the edge); GPS probe data.',
      twin: 'Every approach publishes the slide-7 edge message: per-lane queue, PCU, flow, speed and turning ratios. Open the junction inspector to see it live.', status: ['sim', 'Simulated edge feed'] },
    { n: '02', name: 'Predict', sub: 'see the jam coming',
      does: 'Forecasts congestion 30–60 min ahead from history, weather, office shifts and Film City / event schedules.',
      ai: 'Spatio-temporal deep learning on the corridor graph (GNN / Transformer).',
      twin: 'A 60-minute demand-vs-capacity forecast from the daily profile, tidal pattern and scheduled events drives departure advice. Junction controllers add a platoon look-ahead.', status: ['live', 'Live · simplified model'] },
    { n: '03', name: 'Decide & act', sub: 'one brain, many signals',
      does: 'Re-times junctions to live queues, forms green waves and pushes balanced diversions to message boards and navigation apps.',
      ai: 'Adaptive signals (multi-agent RL on a deterministic safety floor); route optimisation.',
      twin: 'A max-pressure, spillback-aware signal brain within hard min/max-green and anti-starvation limits, a dedicated green-corridor lane for ambulances (junctions hold for only the few seconds it takes to cross), perimeter metering at every entry and VMS diversions.', status: ['live', 'Live in the twin'] },
    { n: '04', name: 'Enforce', sub: 'protect the capacity',
      does: 'Auto-flags parking, stopping, box-blocking and wrong-way driving, and alerts towing and marshals.',
      ai: 'Vision-based violation detection.',
      twin: 'Illegal parking is spotted by camera in ~30 s (a patrol takes ~9 min) and towed in ~6 min instead of ~15; the twin\'s event stopwatch times both. Box-blocking alerts bring marshals in 60 s instead of 180. Keep-clear compliance holds at junctions.', status: ['live', 'Live in the twin'] },
    { n: '05', name: 'Shape demand', sub: 'flatten the peak',
      does: 'Nudges people to leave earlier or later, staggers shifts and right-sizes feeder buses.',
      ai: 'Personalised departure advice; shuttle / cab scheduling.',
      twin: 'When the forecast crosses 93% of capacity, 12% of car and two-wheeler commuters accept advice to leave 15 min later. Trip time counts from when they actually leave.', status: ['live', 'Live in the twin'] },
  ];
  const tabs = $('.loop-tabs'), panel = $('.loop-panel');
  tabs.innerHTML = STAGES.map((s, i) => `<button class="loop-tab${i ? '' : ' on'}" role="tab" data-i="${i}"><span class="n">${s.n}</span><b>${s.name}</b><small>${s.sub}</small></button>`).join('');
  let stage = 0, userPicked = false;
  function showStage(i) {
    stage = i;
    $$('.loop-tab').forEach((b, k) => { b.classList.toggle('on', k === i); b.setAttribute('aria-selected', String(k === i)); });
    const s = STAGES[i];
    panel.innerHTML = `<div><h4>What it does</h4><p>${s.does}</p></div><div><h4>AI capability</h4><p>${s.ai}</p></div>`
      + `<div><span class="status ${s.status[0]}">● ${s.status[1]}</span><p>${s.twin}</p></div>`;
  }
  tabs.addEventListener('click', e => { const b = e.target.closest('.loop-tab'); if (b) { userPicked = true; showStage(+b.dataset.i); } });
  showStage(0);
  if (!reduced) setInterval(() => { if (!userPicked) showStage((stage + 1) % STAGES.length); }, 6000);

  // ------------------------------------------------------------------ benchmark
  const B_START = 8, B_END = 10.5, B_FROM = 8.5;
  const bench = { done: false };
  const benchChart = new window.LineChart($('#bench-p95'), {
    fmt: (v, axis) => (v == null ? '—' : axis ? v.toFixed(v < 10 ? 1 : 0) : `${v.toFixed(1)} min`),
    xfmt: t => S.fmtClock(t).slice(0, 5),
  });

  function runBenchmark() {
    const seed = 7;
    const f = new S.Sim({ mode: 'fixed', seed, startHour: B_START, warmup: true });
    const s = new S.Sim({ mode: 'adaptive', seed, startHour: B_START, warmup: true });
    for (const x of [f, s]) { x.allTrips = []; x.allCrossings = []; }
    const total = (B_END - B_START) * 3600 / S.DT;
    let i = 0, ambFired = false, parkFired = false;
    function chunk() {
      const t0 = performance.now();
      while (i < total && performance.now() - t0 < 30) {
        if (!ambFired && f.t >= 9 * 3600 + 600) { f.triggerAmbulance(); s.triggerAmbulance(); ambFired = true; }
        if (!parkFired && f.t >= 9.5 * 3600) { f.triggerBlockage('FC-03>FC-04'); s.triggerBlockage('FC-03>FC-04'); parkFired = true; }
        f.step(); s.step(); i++;
      }
      $('#bench-fill').style.width = `${(i / total * 100).toFixed(1)}%`;
      $('#bench-status').textContent = `Simulating both twins… ${S.fmtClock(f.t).slice(0, 5)}`;
      if (i < total) setTimeout(chunk, 0);
      else { bench.f = f; bench.s = s; bench.done = true; renderBench(); }
    }
    chunk();
  }

  function aggregate(sim) {
    const from = B_FROM * 3600;
    const tr = sim.allTrips.filter(r => r.t >= from);
    const tts = tr.map(r => r.tt).sort((a, b) => a - b);
    const q = p => tts[Math.min(tts.length - 1, Math.floor((tts.length - 1) * p))];
    const mean = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);
    const corr = tr.filter(r => r.o === 'DND' && r.d === 'GNO').map(r => r.tt);
    const cr = sim.allCrossings.filter(c => c.t >= from);
    const series = sim.series.filter(p => p.t >= from);
    const ev = sim.stats.evTrips[0];
    const park = sim.eventLog.find(e => e.kind === 'parking');
    return {
      parkNormal: park && park.normalAt != null ? park.normalAt - park.start : null,
      parkClear: park ? park.clearAt - park.start : null, parkLost: park ? park.lost : null,
      n: tr.length, p95: q(0.95), avg: mean(tts), corridor: mean(corr), wait: mean(cr.map(c => c.wait)),
      stops: mean(tr.map(r => r.stops)), fuel: mean(tr.map(r => r.fuel)),
      throughput: tr.length / (B_END - B_FROM), maxBacklog: Math.max(0, ...series.map(p => p.backlog)),
      ev: ev ? ev.delay : null, gridlock: sim.stats.gridlockEvents, nudged: sim.stats.nudged,
    };
  }

  function renderBench() {
    const th = window.SAARTHI_THEME;
    const a = aggregate(bench.f), b = aggregate(bench.s);
    const cut = (x, y) => (x ? (x - y) / x * 100 : 0);
    const dur = S.fmtDur;
    const run = $('#bench-run');
    run.classList.add('done');
    $('#bench-status').innerHTML = `✓ Computed in your browser: ${a.n.toLocaleString('en-IN')} vs ${b.n.toLocaleString('en-IN')} trips, 08:30–10:30, `
      + `ambulance at 09:10 (green corridor lane in the SAARTHI twin), illegal parking at 09:30 (cleared in ${dur(b.parkClear)} vs ${dur(a.parkClear)}). `
      + `SAARTHI nudged ${b.nudged.toLocaleString('en-IN')} commuters to leave later.`;
    const card = (pct, title, fv, sv, i) => {
      const cls = pct >= 2 ? '' : pct <= -2 ? 'bad' : 'neutral';
      return `<div class="bcard" style="animation-delay:${i * 90}ms"><div class="big ${cls}">${pct >= 0 ? '−' : '+'}${Math.abs(pct).toFixed(0)}%</div>`
        + `<h3>${title}</h3><div class="vs"><span><i class="swatch fixed"></i>${fv}</span><span><i class="swatch smart"></i>${sv}</span></div></div>`;
    };
    $('#bench-cards').innerHTML = [
      card(cut(a.p95, b.p95), '95th-percentile trip time', dur(a.p95), dur(b.p95), 0),
      card(cut(a.corridor, b.corridor), 'DND → Greater Noida crossing', dur(a.corridor), dur(b.corridor), 1),
      card(cut(a.wait, b.wait), 'Average wait per junction', `${Math.round(a.wait)} s`, `${Math.round(b.wait)} s`, 2),
      card(cut(a.ev, b.ev), 'Ambulance delay', dur(a.ev), `${dur(b.ev)} · own lane`, 3),
      card(cut(a.parkNormal, b.parkNormal), 'Illegal parking: traffic back to normal', dur(a.parkNormal), dur(b.parkNormal), 4),
    ].join('');

    const pct = (x, y) => (y - x) / x * 100;
    const fmtP = v => `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(0)}%`;
    const status = (v, met, close) => v >= met ? '<span class="pill met">Met</span>' : v >= close ? '<span class="pill close">Close</span>' : '<span class="pill miss">Not yet</span>';
    const stopsNote = cut(a.stops, b.stops) >= 0 ? 'fewer, longer greens' : 'more phase switching under load';
    const rows = [
      ['Corridor crossing 20–30 min (from 45–60)', '≈ −50% crossing time', fmtP(pct(a.corridor, b.corridor)), status(cut(a.corridor, b.corridor), 40, 25)],
      ['−40% average junction wait', '', fmtP(pct(a.wait, b.wait)), status(cut(a.wait, b.wait), 40, 25)],
      ['+15–20% corridor throughput', 'same demand in both twins', fmtP(pct(a.throughput, b.throughput)), status(pct(a.throughput, b.throughput), 15, 4)],
      ['−25–30% vehicle stops', stopsNote,fmtP(pct(a.stops, b.stops)), status(cut(a.stops, b.stops), 25, 10)],
      ['−10–20% emissions & fuel', 'per trip, estimated', fmtP(pct(a.fuel, b.fuel)), status(cut(a.fuel, b.fuel), 10, 5)],
      ['~0 emergency-vehicle delay', 'SAARTHI vs fixed', `${dur(b.ev)} vs ${dur(a.ev)}`, status(b.ev == null ? 0 : b.ev <= 30 ? 2 : b.ev <= 90 ? 1 : 0, 2, 1)],
    ];
    $('#targets-body').innerHTML = rows.map(r => `<tr><td><b>${r[0]}</b>${r[1] ? `<span class="sub2">${r[1]}</span>` : ''}</td><td class="num">${r[2]}</td><td class="num">${r[3]}</td></tr>`).join('');

    benchChart.theme = th;
    const pts = sim => sim.series.filter(p => p.t >= B_FROM * 3600 - 900).map(p => ({ t: p.t, v: p.p95 == null ? null : p.p95 / 60 }));
    benchChart.setData([
      { name: 'Fixed', color: th.fixed, points: pts(bench.f) },
      { name: 'SAARTHI', color: th.smart, points: pts(bench.s) },
    ]);
    $('#hp-p95').textContent = `−${cut(a.p95, b.p95).toFixed(0)}%`;
    $('#hp-ev').textContent = `${dur(b.ev)} vs ${dur(a.ev)}`;
  }
  window.addEventListener('resize', () => { if (bench.done) benchChart.draw(); });
  document.addEventListener('themechange', () => { if (bench.done) setTimeout(renderBench, 0); });
  setTimeout(runBenchmark, 900);
})();
