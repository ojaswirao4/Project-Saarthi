/* Live twin lab: runs both twins in lockstep and keeps the dashboard in sync. */
(function () {
  'use strict';
  const S = window.SAARTHI;
  const $ = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));

  const REAL = Object.values(window.SAARTHI_NETWORKS || {}).map(n => ({ id: n.id, label: `${n.short} · OpenStreetMap` }));
  const AREAS = REAL.concat([{ id: 'fc', label: 'Film City loop · schematic' }]);
  const qs = new URLSearchParams(location.search);
  const DEFAULT_AREA = REAL.some(a => a.id === 'fco') ? 'fco' : 'fc'; // the real Film City corridor

  const state = {
    running: true, speed: 5, startHour: 8.5, demand: 1, view: 'split', colorBy: 'speed',
    seed: 7, selected: null, approach: 0, visible: false, scenario: null,
    area: AREAS.some(a => a.id === qs.get('area')) ? qs.get('area') : DEFAULT_AREA,
    features: { greenCorridor: true, metering: true, vms: true, enforcement: true, shaping: true, mergeControl: true },
  };
  let fixed = null, smart = null;

  const rFixed = new window.Renderer($('#cv-fixed'));
  const rSmart = new window.Renderer($('#cv-smart'));
  rSmart.view = rFixed.view; // zoom and pan move both maps together
  const minFmt = (v, axis) => (v == null ? '—' : axis ? v.toFixed(v < 10 ? 1 : 0) : `${v.toFixed(1)} min`);
  const intFmt = v => (v == null ? '—' : Math.round(v).toLocaleString('en-IN'));
  const pctFmt = v => (v == null ? '—' : `${Math.round(v * 100)}%`);
  const hhmm = t => S.fmtClock(t).slice(0, 5);
  const chP95 = new window.LineChart($('#ch-p95'), { fmt: minFmt, xfmt: hhmm });
  const chQueue = new window.LineChart($('#ch-queue'), { fmt: intFmt, xfmt: hhmm });
  const chFc = new window.LineChart($('#ch-forecast'), { fmt: pctFmt, xfmt: hhmm, ref: { v: 0.93, label: 'advice threshold' } });

  // ------------------------------------------------------------------ theme
  let theme;
  function readTheme() {
    const cs = getComputedStyle(document.documentElement);
    const v = n => cs.getPropertyValue(n).trim();
    theme = {
      ground: v('--map-ground'), block: v('--map-block'), blockText: v('--map-block-text'), road: v('--map-road'),
      median: v('--map-median'), lane: v('--map-lane'), kerb: v('--map-kerb'), parked: v('--map-parked'),
      label: v('--map-label'), label2: v('--map-label-2'), accent: v('--accent'),
      green: v('--status-good'), amber: v('--status-warn'), red: v('--status-crit'),
      types: { car: v('--t-car'), tw: v('--t-tw'), auto: v('--t-auto'), erick: v('--t-erick'), bus: v('--t-bus'), truck: v('--t-truck') },
      surface: v('--surface'), ink2: v('--ink-2'), muted: v('--muted'), grid: v('--grid'), axis: v('--axis'),
      fixed: v('--series-fixed'), smart: v('--series-smart'), vip: v('--vip'),
    };
    rFixed.theme = rSmart.theme = chP95.theme = chQueue.theme = chFc.theme = theme;
    window.SAARTHI_THEME = theme;
  }
  readTheme();
  const onTheme = () => { readTheme(); renderLegend(); updateCharts(); };
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', onTheme);
  document.addEventListener('themechange', onTheme);

  // ------------------------------------------------------------------ setup
  function reset(newSeed) {
    if (newSeed) state.seed = (Math.random() * 1e9) >>> 0;
    const sc = state.scenario;
    const common = { seed: state.seed, startHour: sc ? sc.startHour : state.startHour, demandMult: state.demand, warmup: true, network: state.area };
    fixed = new S.Sim(Object.assign({ mode: 'fixed', scenario: sc && sc.fixed }, common));
    smart = new S.Sim(Object.assign({ mode: 'adaptive', scenario: sc && sc.smart, features: Object.assign({}, state.features) }, common));
    $('#scen-banner').hidden = !sc;
    if (sc) $('#scen-label').textContent = sc.label;
    rFixed.sim = fixed;
    rSmart.sim = smart;
    if (!fixed.nodes[state.selected] || fixed.nodes[state.selected].type !== 'J') state.selected = fixed.junctions[0].id;
    rFixed.selected = rSmart.selected = state.selected;
    $$('.scen-btns .btn').forEach(b => b.classList.remove('fired'));
    describeArea();
    buildJunctionTabs();
    updateUI();
    updateCharts();
  }

  function resizeAll() {
    rFixed.resize(); rSmart.resize();
    chP95.draw(); chQueue.draw(); chFc.draw();
  }
  window.addEventListener('resize', resizeAll);

  // ------------------------------------------------------------------ area
  const sel = $('#sel-area');
  sel.innerHTML = AREAS.map(a => `<option value="${a.id}"${a.id === state.area ? ' selected' : ''}>${a.label}</option>`).join('');
  sel.addEventListener('change', () => setArea(sel.value));

  function setArea(id) {
    state.area = id;
    sel.value = id;
    state.scenario = null;
    state.selected = null;
    rFixed.resetView();
    const net = S.networkById(id);
    const ar = Math.min(1.6, Math.max(1.15, net.size.w / net.size.h));
    $$('.cv-wrap').forEach(w => { w.style.aspectRatio = String(ar); });
    reset(false);
    renderLegend();
    requestAnimationFrame(resizeAll);
  }

  function describeArea() {
    const net = fixed.net, h = fixed.hooks;
    $('#ev-amb small').textContent = h.ambulance.label.replace(/ & Associated Hospitals/, '');
    $('#ev-park small').textContent = h.parkingName || h.parking;
    $('#ev-surge small').textContent = `${h.surge.label.replace(/ \([A-Z]+\)$/, '')} +60%, 20 min`;
    $('#ev-cam small').textContent = `${h.fault} for 5 min`;
    const st = net.stats;
    $('#net-info').innerHTML = net.schematic
      ? '<b>Film City loop, Noida</b> · schematic: 4 signalised junctions, 5 entries. Pick "Film City · OpenStreetMap" above for the same corridor on its actual road network.'
      : `<b>${net.name}</b> · real road network from OpenStreetMap${net.fetched ? ` (pulled ${net.fetched})` : ''}: `
        + `<span>${st.junctions} junctions</span> <span>${st.signalised} signalised${st.inferredSignals ? ` (${st.inferredSignals} inferred)` : ''}</span> `
        + `<span>${st.uturns} U-turn points</span> <span>${st.slipRoads} slip roads</span> `
        + `<span>${st.flyovers} flyover${st.flyovers === 1 ? '' : 's'} (${st.flyoverLinks} links)</span>${st.underpassLinks ? ` <span>${st.underpassLinks} underpass links</span>` : ''} `
        + `<span>${st.roadKm} road-km</span> <span>${st.entries} entries</span>`;
    const gc = smart.gcBuilt ? smart.gcLinks.filter(L => L.kind !== 'entry' && L.kind !== 'exit') : [];
    const gcKm = smart.gcLinks.reduce((s, L) => s + L.length, 0) / 1000;
    $('#gc-note').textContent = smart.gcBuilt
      ? `SAARTHI twin: ${gcKm.toFixed(1)} km dedicated lane, ${h.ambulance.label}, through ${gc.length + 1} junctions`
      : 'Switched off: the SAARTHI twin has no dedicated lane and no signal pre-emption';
  }

  // ------------------------------------------------------------------ controls
  $('#btn-play').addEventListener('click', e => {
    state.running = !state.running;
    e.currentTarget.textContent = state.running ? 'Pause' : 'Play';
    e.currentTarget.setAttribute('aria-pressed', String(state.running));
  });
  $('#btn-reset').addEventListener('click', () => reset(true));

  function fastForward(seconds) {
    for (let i = 0; i < seconds / S.DT; i++) { fixed.step(); smart.step(); }
    updateUI();
    updateCharts();
  }
  $('#btn-ff').addEventListener('click', () => fastForward(900));

  function seg(id, fn) {
    const el = $(id);
    el.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      el.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
      fn(b.dataset.v);
    });
  }
  seg('#seg-speed', v => { state.speed = +v; });
  seg('#seg-view', v => {
    state.view = v;
    $('#twins').className = `twins view-${v}`;
    requestAnimationFrame(resizeAll);
  });
  seg('#seg-color', v => { state.colorBy = rFixed.colorBy = rSmart.colorBy = v; renderLegend(); });

  $('#sel-start').addEventListener('change', e => { state.startHour = +e.target.value; state.scenario = null; reset(false); renderLegend(); });

  // A what-if plan from the planner (Film City): today's approach in the fixed twin, the recommended plan in SAARTHI's.
  window.SAARTHI_LAB = {
    renderers: [rFixed, rSmart],
    state,
    sims: () => [fixed, smart],
    loadScenario(sc) {
      if (state.area !== 'fc') setArea('fc');
      state.scenario = sc;
      if (sc.seed) state.seed = sc.seed;
      reset(false);
      renderLegend();
      if (!state.running) $('#btn-play').click();
    },
  };
  $('#scen-clear').addEventListener('click', () => { state.scenario = null; reset(false); renderLegend(); });
  $('#rng-demand').addEventListener('input', e => {
    state.demand = +e.target.value;
    $('#out-demand').textContent = `${Math.round(state.demand * 100)}%`;
    if (fixed) { fixed.demandMult = state.demand; smart.demandMult = state.demand; }
  });

  const both = fn => { fn(fixed); fn(smart); };
  function fire(btn, fn) {
    btn.addEventListener('click', () => {
      both(fn);
      btn.classList.add('fired');
      setTimeout(() => btn.classList.remove('fired'), 1200);
      updateUI();
    });
  }
  fire($('#ev-amb'), s => s.triggerAmbulance());
  fire($('#ev-park'), s => s.triggerBlockage());
  fire($('#ev-surge'), s => s.triggerSurge(null, 1.6, 20));
  fire($('#ev-cam'), s => s.triggerCameraFault(null, 5));

  // Presenter shortcuts while the twin is on screen: Space pause, F +15 min, A/P/E/C fire an event.
  const KEYS = { ' ': '#btn-play', f: '#btn-ff', a: '#ev-amb', p: '#ev-park', e: '#ev-surge', c: '#ev-cam' };
  document.addEventListener('keydown', e => {
    const tag = document.activeElement.tagName;
    if (e.ctrlKey || e.metaKey || e.altKey || /^(INPUT|SELECT|TEXTAREA)$/.test(tag) || (e.key === ' ' && tag === 'BUTTON')) return;
    const sel = KEYS[e.key.toLowerCase()], r = $('#twin').getBoundingClientRect();
    if (!sel || r.bottom < 0 || r.top > innerHeight) return;
    e.preventDefault();
    $(sel).click();
  });

  $$('.toggles input').forEach(inp => inp.addEventListener('change', () => {
    state.features[inp.dataset.f] = inp.checked;
    if (inp.dataset.f === 'greenCorridor') { reset(false); renderLegend(); return; } // the lane is built or not: new twin
    if (smart) smart.features[inp.dataset.f] = inp.checked;
  }));

  // ------------------------------------------------------------------ map: click, drag to pan, Ctrl+wheel / buttons to zoom
  function wireMap(r) {
    const cv = r.canvas;
    let down = null;
    cv.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY, moved: false }; cv.setPointerCapture(e.pointerId); });
    cv.addEventListener('pointermove', e => {
      if (!down) return;
      const dx = e.clientX - down.x, dy = e.clientY - down.y;
      if (!down.moved && Math.hypot(dx, dy) < 4) return;
      down.moved = true;
      if (r.view.z > 1) { r.pan(dx, dy); down.x = e.clientX; down.y = e.clientY; cv.style.cursor = 'grabbing'; }
    });
    cv.addEventListener('pointerup', e => {
      if (down && !down.moved) { const id = r.hit(e.clientX, e.clientY); if (id) selectJunction(id); }
      down = null; cv.style.cursor = '';
    });
    cv.addEventListener('wheel', e => {
      if (!(e.ctrlKey || e.metaKey)) return; // plain scrolling keeps scrolling the page
      e.preventDefault();
      r.zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.002));
    }, { passive: false });
    cv.addEventListener('dblclick', e => { r.zoomAt(e.clientX, e.clientY, r.view.z >= 8 ? 1 / 64 : 2); });
    const ctl = document.createElement('div');
    ctl.className = 'map-ctl';
    ctl.innerHTML = '<button type="button" data-z="in" aria-label="Zoom in">+</button><button type="button" data-z="out" aria-label="Zoom out">−</button><button type="button" data-z="fit" aria-label="Show the whole area">⤢</button>';
    ctl.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      const rc = cv.getBoundingClientRect(), cx = rc.left + rc.width / 2, cy = rc.top + rc.height / 2;
      if (b.dataset.z === 'fit') r.resetView(); else r.zoomAt(cx, cy, b.dataset.z === 'in' ? 1.6 : 1 / 1.6);
    });
    cv.parentElement.appendChild(ctl);
  }
  wireMap(rFixed);
  wireMap(rSmart);

  function buildJunctionTabs() {
    const el = $('#seg-junction');
    const js = fixed.junctions;
    if (js.length <= 6) {
      el.innerHTML = js.map(j =>
        `<button data-v="${j.id}" class="${j.id === state.selected ? 'on' : ''}" title="${j.name}">${j.id}${j.corner ? ` · ${j.corner}` : ''}</button>`).join('');
      el.className = 'seg';
      el.onclick = e => { const b = e.target.closest('button'); if (b) selectJunction(b.dataset.v); };
    } else {
      el.className = 'seg-sel';
      el.innerHTML = `<select aria-label="Junction">${js.map(j => `<option value="${j.id}"${j.id === state.selected ? ' selected' : ''}>${j.id} · ${j.name}</option>`).join('')}</select>`
        + '<span class="hint">or click a junction on the map</span>';
      el.onclick = null;
      el.querySelector('select').onchange = e => selectJunction(e.target.value);
    }
  }

  function selectJunction(id) {
    state.selected = rFixed.selected = rSmart.selected = id;
    state.approach = 0;
    $$('#seg-junction button').forEach(b => b.classList.toggle('on', b.dataset.v === id));
    const s = $('#seg-junction select');
    if (s) s.value = id;
    updateInspector();
  }

  $('#insp-body').addEventListener('click', e => {
    const tr = e.target.closest('tr');
    if (!tr) return;
    state.approach = +tr.dataset.i;
    updateInspector();
  });

  // ------------------------------------------------------------------ legend
  function renderLegend() {
    const items = state.colorBy === 'speed'
      ? [[theme.green, 'Moving'], [theme.amber, 'Slow'], [theme.red, 'Stopped']]
      : ['car', 'tw', 'auto', 'erick', 'bus', 'truck'].map(k => [theme.types[k], S.VTYPES[k].label]);
    const extra = state.scenario ? [[theme.vip, 'VIP convoy'], [theme.red, 'Closed road'], [theme.amber, 'Lane lost to parking']] : [];
    if (state.features.greenCorridor) extra.push(['#16a34a', 'Green corridor lane (SAARTHI twin)']);
    $('#legend').innerHTML = items.concat([['#ffffff', 'Ambulance (flashing)']], extra)
      .map(([c, l]) => `<span><i style="background:${c};box-shadow:0 0 0 1px var(--line-2)"></i>${l}</span>`).join('')
      + `<span>Stop-line bar = signal state · click a junction to inspect it${state.area !== 'fc' ? ' · Ctrl + scroll or the + / − buttons to zoom, drag to pan' : ''}</span>`;
  }

  // ------------------------------------------------------------------ KPIs
  const dur = v => S.fmtDur(v);
  const METRICS = () => [
    { key: 'p95', label: '95th-percentile trip time', note: 'the bad-day measure the brief targets', fmt: dur, better: 'lower' },
    { key: 'avgTrip', label: 'Average trip time', fmt: dur, better: 'lower' },
    { key: 'corridor', label: fixed.hooks.corridor.label, note: 'average', fmt: dur, better: 'lower' },
    { key: 'wait', label: 'Wait per junction', note: 'average stopped time', fmt: v => (v == null ? '—' : `${Math.round(v)} s`), better: 'lower' },
    { key: 'throughput', label: 'Throughput', fmt: v => (v == null ? '—' : `${intFmt(v)} veh/h`), better: 'higher' },
    { key: 'stops', label: 'Stops per vehicle', fmt: v => (v == null ? '—' : v.toFixed(1)), better: 'lower' },
    { key: 'backlog', label: `Queued outside the ${fixed.net.schematic ? 'loop' : 'area'}`, note: 'vehicles waiting to enter', fmt: intFmt, better: 'lower' },
    { key: 'gridlockEvents', label: 'Gridlock events', note: 'since start', fmt: intFmt, better: 'lower' },
    { key: 'evDelay', label: 'Ambulance delay', note: 'last dispatch', fmt: dur, better: 'lower' },
    { key: 'fuel', label: 'Fuel per trip', note: 'estimate', fmt: v => (v == null ? '—' : `${(v * 1000).toFixed(0)} mL`), better: 'lower' },
  ];

  function delta(f, s, better) {
    if (f == null || s == null) return '<span class="delta flat">—</span>';
    if (f === 0 && s === 0) return '<span class="delta flat">none</span>';
    if (f === 0) return better === 'lower' ? '<span class="delta bad">▲ worse</span>' : '<span class="delta good">▲ better</span>';
    const pct = (s - f) / f * 100;
    if (Math.abs(pct) < 2) return '<span class="delta flat">≈ same</span>';
    const good = better === 'lower' ? pct < 0 : pct > 0;
    return `<span class="delta ${good ? 'good' : 'bad'}">${pct < 0 ? '▼' : '▲'} ${Math.abs(pct).toFixed(0)}%</span>`;
  }

  const SCEN_METRICS = [
    { key: 'turnedBack', label: 'Turned back at barricades', note: 'since start', fmt: intFmt, better: 'lower' },
    { key: 'vipDelay', label: 'Worst VIP convoy delay', fmt: dur, better: 'lower' },
  ];

  function updateKpis(kf, ks) {
    $('#kpi-body').innerHTML = METRICS().concat(state.scenario ? SCEN_METRICS : []).map(m => `<tr>
      <td>${m.label}${m.note ? `<span class="sub2">${m.note}</span>` : ''}</td>
      <td class="num">${m.fmt(kf[m.key])}</td>
      <td class="num">${m.fmt(ks[m.key])}</td>
      <td class="num">${delta(kf[m.key], ks[m.key], m.better)}</td></tr>`).join('');
    const h = $('#headline');
    if (kf.p95 != null && ks.p95 != null) {
      const pct = (kf.p95 - ks.p95) / kf.p95 * 100;
      h.innerHTML = pct >= 2
        ? `Right now SAARTHI is cutting the 95th-percentile trip by <em>${pct.toFixed(0)}%</em>: ${dur(ks.p95)} vs ${dur(kf.p95)} on fixed timers.`
        : pct <= -2
          ? `Right now the fixed timers are ahead on 95th-percentile trip time (${dur(kf.p95)} vs ${dur(ks.p95)}).`
          : `Both systems are coping. Raise demand or start at a peak hour to stress the ${fixed.net.schematic ? 'corridor' : 'network'}.`;
    } else h.textContent = 'Collecting trips…';
  }

  function chips(el, sim, k) {
    const gl = sim.isects.filter(j => j.inGridlock).length;
    el.innerHTML = `<span class="chip">${intFmt(k.inNet)} ${sim.net.schematic ? 'in loop' : 'on the roads'}</span>`
      + `<span class="chip ${k.backlog > 20 ? 'alert' : ''}">${intFmt(k.backlog)} queued upstream</span>`
      + (gl ? `<span class="chip alert">${gl} gridlocked</span>` : '')
      + (k.turnedBack ? `<span class="chip alert">${intFmt(k.turnedBack)} turned back</span>` : '')
      + (sim.evs.some(v => v.vip) ? '<span class="chip vip">VIP convoy en route</span>' : '')
      + (sim.evs.some(v => !v.vip) ? `<span class="chip ${sim.gcBuilt ? 'gc' : 'alert'}">ambulance en route${sim.gcBuilt ? ' · own lane' : ''}</span>` : '')
      + (sim.shapingActive ? '<span class="chip info">departure advice on</span>' : '');
  }

  // ------------------------------------------------------------------ event stopwatch
  // Each injected event is timed in both twins from the same instant: when it was spotted, cleared,
  // and when traffic got back to normal, plus the vehicle-minutes it cost.
  const ICON = { parking: '⛔', crash: '💥', ambulance: '🚑', surge: '🎬', camera: '📷' };
  function measures(e) {
    if (e.kind === 'ambulance') return [
      { label: 'Reached the hospital', note: 'dispatch to arrival', at: 'arriveAt', kind: 'time' },
      { label: 'Delay vs an empty road', key: 'delay', kind: 'dur' },
    ];
    if (e.kind === 'camera') return [{ label: 'Running on the fixed fallback plan', at: 'clearAt', kind: 'time', fixedNA: 'no cameras to lose' }];
    const rows = [];
    if (e.kind !== 'surge') rows.push({ label: 'Spotted', note: 'camera vs patrol / complaint', at: 'detectAt', kind: 'time' });
    rows.push({ label: e.kind === 'surge' ? 'Surge over' : 'Lane cleared', note: e.kind === 'surge' ? '' : 'tow / clearance done', at: 'clearAt', kind: 'time' });
    rows.push({ label: 'Traffic back to normal', note: e.kind === 'surge' ? 'whole network' : 'this road and its approaches', at: 'normalAt', kind: 'time' });
    rows.push({ label: 'Vehicle-minutes lost', note: 'extra stopped time it caused', key: 'lost', kind: 'num' });
    return rows;
  }
  function cell(sim, e, m) {
    if (m.kind === 'num') return { v: e[m.key], done: e.normalAt != null, txt: intFmt(e[m.key]) + (e.normalAt == null ? '<i class="run">…</i>' : '') };
    if (m.kind === 'dur') return e[m.key] == null ? { v: null, txt: '<span class="run">en route…</span>' } : { v: e[m.key], done: true, txt: dur(e[m.key]) };
    const at = e[m.at];
    if (at != null && sim.t >= at) return { v: at - e.start, done: true, txt: dur(at - e.start) };
    return { v: sim.t - e.start, done: false, txt: `<span class="run">${dur(sim.t - e.start)}…</span>` };
  }
  function saved(f, s, m) {
    if (f.v == null || s.v == null) return '<span class="delta flat">—</span>';
    if (!s.done) return '<span class="delta flat">timing…</span>';
    const d = f.v - s.v;
    if (!f.done) return d > 0 ? `<span class="delta good">≥ ${m.kind === 'num' ? intFmt(d) : dur(d)}</span>` : '<span class="delta flat">timing…</span>';
    if (Math.abs(d) < (m.kind === 'num' ? 1 : 5)) return '<span class="delta flat">≈ same</span>';
    const pct = f.v ? Math.round(d / f.v * 100) : 0;
    return `<span class="delta ${d > 0 ? 'good' : 'bad'}">${d > 0 ? '−' : '+'}${m.kind === 'num' ? intFmt(Math.abs(d)) : dur(Math.abs(d))}${pct ? ` (${d > 0 ? '−' : '+'}${Math.abs(pct)}%)` : ''}</span>`;
  }
  let lastSw = '';
  function updateStopwatch() {
    const evs = fixed.eventLog.map((f, i) => [f, smart.eventLog[i]]).filter(p => p[1]).slice(-4).reverse();
    if (!evs.length) {
      if (lastSw !== 'empty') $('#sw-body').innerHTML = '<tr><td colspan="5" class="sw-empty">Inject an event above. Both twins get it at the same instant, and this panel times what happens next in each: when it is spotted, when it is cleared, and when traffic is back to normal.</td></tr>';
      lastSw = 'empty';
      return;
    }
    lastSw = '';
    $('#sw-body').innerHTML = evs.map(([f, s]) => {
      const ms = measures(f);
      const head = `<tr class="sw-h"><td colspan="5"><span class="sw-ico">${ICON[f.kind] || '•'}</span>${f.label.replace(/ & Associated Hospitals/, '')}<span class="sub2">started ${hhmm(f.start)}${f.kind === 'ambulance' && s.usedLane ? ' · SAARTHI twin uses the green corridor lane' : ''}</span></td></tr>`;
      return head + ms.map(m => {
        const a = m.fixedNA ? { v: null, txt: `<span class="na">${m.fixedNA}</span>` } : cell(fixed, f, m), b = cell(smart, s, m);
        return `<tr><td>${m.label}${m.note ? `<span class="sub2">${m.note}</span>` : ''}</td><td class="num">${a.txt}</td><td class="num">${b.txt}</td><td class="num">${m.fixedNA ? '' : saved(a, b, m)}</td></tr>`;
      }).join('');
    }).join('');
  }

  // ------------------------------------------------------------------ inspector & log
  function edgeJson(o) { // same layout as the edge message on deck slide 7
    const lanes = o.lanes.map(l => `   ${JSON.stringify(l)}`).join(',\n');
    return `{ "junction_id":"${o.junction_id}", "approach":"${o.approach}",\n  "lanes":[\n${lanes}],\n`
      + `  "turning":${JSON.stringify(o.turning)},\n  "incident":${o.incident} }`;
  }

  function updateInspector() {
    if (!fixed || !state.selected) return;
    const jf = fixed.nodes[state.selected], js = smart.nodes[state.selected];
    const af = fixed.approachInfo(jf), as = smart.approachInfo(js);
    if (state.approach >= af.length) state.approach = 0;
    const cellQ = a => `${a.queue.toFixed(0)} PCU<span class="sig ${a.state}" title="${a.state === 'G' ? 'green' : a.state === 'Y' ? 'amber' : 'red'}"></span>`;
    $('#insp-body').innerHTML = af.map((a, i) => `<tr data-i="${i}" class="${i === state.approach ? 'sel' : ''}">
      <td>${a.name}<span class="sub2">from ${a.approach} · fixed green ${a.plan}s</span></td>
      <td class="num">${cellQ(a)}</td>
      <td class="num">${cellQ(as[i])}</td></tr>`).join('');
    $('#edge-name').textContent = `${js.id} · ${js.approaches[state.approach].name}`;
    $('#edge-json').textContent = edgeJson(smart.edgeState(js, state.approach));
  }

  let lastLogKey = '';
  function updateLog() {
    const items = fixed.log.map(l => Object.assign({ who: 'fixed' }, l)).concat(smart.log.map(l => Object.assign({ who: 'smart' }, l)))
      .sort((a, b) => b.t - a.t).slice(0, 60);
    const key = items.length + ':' + (items[0] ? items[0].t + items[0].msg : '');
    if (key === lastLogKey) return;
    lastLogKey = key;
    $('#log').innerHTML = items.length ? items.map(l => `<li class="k-${l.kind}">
      <time>${S.fmtClock(l.t)}</time><span class="who ${l.who}">${l.who === 'smart' ? 'SAARTHI' : 'FIXED'}</span><span>${l.msg}</span></li>`).join('')
      : '<li class="empty">No events yet. Inject one above, or wait for the peak to build.</li>';
  }

  function updateUI() {
    if (!fixed) return;
    const kf = fixed.kpis(), ks = smart.kpis();
    $('#clock').textContent = S.fmtClock(fixed.t);
    $('#clock-sub').textContent = state.running ? `simulated · ${state.speed}×` : 'paused';
    updateKpis(kf, ks);
    chips($('#chips-fixed'), fixed, kf);
    chips($('#chips-smart'), smart, ks);
    updateStopwatch();
    updateInspector();
    updateLog();
  }

  function updateCharts() {
    if (!fixed) return;
    const pts = (sim, fn) => sim.series.map(p => ({ t: p.t, v: fn(p) }));
    chP95.setData([
      { name: 'Fixed', color: theme.fixed, points: pts(fixed, p => (p.p95 == null ? null : p.p95 / 60)) },
      { name: 'SAARTHI', color: theme.smart, points: pts(smart, p => (p.p95 == null ? null : p.p95 / 60)) },
    ]);
    chQueue.setData([
      { name: 'Fixed', color: theme.fixed, points: pts(fixed, p => p.queued + p.backlog) },
      { name: 'SAARTHI', color: theme.smart, points: pts(smart, p => p.queued + p.backlog) },
    ]);
    chFc.setData([{ name: 'Forecast', color: theme.smart, points: smart.forecastSeries(60, 5) }]);
  }

  // ------------------------------------------------------------------ main loop
  // Only simulate while the lab is on screen, so the rest of the page stays smooth.
  new IntersectionObserver(es => {
    state.visible = es[es.length - 1].isIntersecting; // entries can arrive batched: the newest one counts
    if (state.visible) requestAnimationFrame(resizeAll);
  }, { rootMargin: '200px' }).observe($('#twin'));

  let last = performance.now(), acc = 0, uiT = 0, chartT = 0;
  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (state.visible && fixed) {
      if (state.running) {
        acc += dt * state.speed;
        let n = 0;
        const t0 = performance.now();
        // big real networks can't always keep up at 60×: drop the backlog rather than freeze the page
        while (acc >= S.DT && n < 800 && performance.now() - t0 < 40) { fixed.step(); smart.step(); acc -= S.DT; n++; }
        if (acc >= S.DT) acc = 0;
      }
      if (state.view !== 'smart') rFixed.draw(now);
      if (state.view !== 'fixed') rSmart.draw(now);
      if (now - uiT > 300) { uiT = now; updateUI(); }
      if (now - chartT > 1000) { chartT = now; updateCharts(); }
    }
    requestAnimationFrame(frame);
  }

  setArea(state.area);
  // ?ff=N fast-forwards N × 15 min on load; ?amb=1 dispatches an ambulance afterwards; ?park=1 adds illegal parking
  if (+qs.get('ff') > 0) fastForward(900 * +qs.get('ff'));
  if (qs.get('amb')) { both(s => s.triggerAmbulance()); fastForward(60); }
  if (qs.get('park')) { both(s => s.triggerBlockage()); fastForward(+qs.get('park') > 1 ? +qs.get('park') * 60 : 60); }
  requestAnimationFrame(frame);
})();
