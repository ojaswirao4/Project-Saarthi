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
    features: { greenCorridor: true, signalPriority: true, metering: true, vms: true, enforcement: true, shaping: true, mergeControl: true },
    amb: null,          // the ambulance run shown in the panel above the maps
    autoApprove: false, // controller's standing choice: approve SAARTHI's light changes without pausing
    follow: false,      // maps follow the ambulances
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
    smart = new S.Sim(Object.assign({ mode: 'adaptive', scenario: sc && sc.smart, features: Object.assign({}, state.features), priorityApproval: true }, common));
    smart.autoApprove = state.autoApprove;
    state.amb = null; stopFollow(); renderAmb();
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
        + (fixed.inferredCount ? `<span>+ ${fixed.inferredCount} crossing${fixed.inferredCount === 1 ? '' : 's'} taken as signalised (inferred: OSM maps few signals here; to be confirmed by the signal survey)</span> ` : '')
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
    for (let i = 0; i < seconds / S.DT; i++) { if (waiting()) { suggestionRaised(); break; } fixed.step(); smart.step(); if (suggestionRaised()) break; }
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
  const BM = window.SAARTHI_BASEMAP;
  $$('#seg-map button').forEach(b => b.classList.toggle('on', b.dataset.v === BM.mode));
  seg('#seg-map', v => { BM.mode = v; });

  $('#sel-start').addEventListener('change', e => { state.startHour = +e.target.value; state.scenario = null; reset(false); renderLegend(); });

  // A what-if plan from the planner (on its area): today's approach in the fixed twin, the recommended plan in SAARTHI's.
  window.SAARTHI_LAB = {
    renderers: [rFixed, rSmart],
    state,
    sims: () => [fixed, smart],
    loadScenario(sc) {
      const area = sc.area || 'fc';
      if (state.area !== area) setArea(area);
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
  $('#ev-amb').addEventListener('click', () => dispatchAmbulance());
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
    ctl.innerHTML = '<button type="button" data-z="in" aria-label="Zoom in" title="Zoom in">+</button>'
      + '<button type="button" data-z="out" aria-label="Zoom out" title="Zoom out">−</button>'
      + '<button type="button" data-z="fit" aria-label="Show the whole area" title="Show the whole area">⌂</button>'
      + '<button type="button" data-z="full" class="fs-btn" aria-label="Full screen" title="Full screen (Esc to leave)">⤢</button>';
    ctl.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      const rc = cv.getBoundingClientRect(), cx = rc.left + rc.width / 2, cy = rc.top + rc.height / 2;
      if (b.dataset.z === 'full') toggleFullscreen();
      else if (b.dataset.z === 'fit') r.resetView();
      else r.zoomAt(cx, cy, b.dataset.z === 'in' ? 1.6 : 1 / 1.6);
    });
    cv.parentElement.appendChild(ctl);
  }
  wireMap(rFixed);
  wireMap(rSmart);

  // Full screen: both twins together, so the split view still compares them side by side. Where the browser
  // refuses (an embedded preview, a policy), the twins fill the window instead.
  const tw = $('#twins');
  const isFull = () => document.fullscreenElement === tw || tw.classList.contains('fs-window');
  function fsChanged() {
    const on = isFull();
    $$('.fs-btn').forEach(b => { b.textContent = on ? '⤡' : '⤢'; b.title = on ? 'Leave full screen (Esc)' : 'Full screen (Esc to leave)'; b.setAttribute('aria-label', on ? 'Leave full screen' : 'Full screen'); });
    document.body.style.overflow = tw.classList.contains('fs-window') ? 'hidden' : '';
    requestAnimationFrame(resizeAll);
  }
  function toggleFullscreen() {
    if (document.fullscreenElement || tw.classList.contains('fs-window')) {
      tw.classList.remove('fs-window');
      if (document.fullscreenElement) document.exitFullscreen(); else fsChanged();
      return;
    }
    const fallback = () => { if (!document.fullscreenElement && !tw.classList.contains('fs-window')) { tw.classList.add('fs-window'); fsChanged(); } };
    if (!tw.requestFullscreen) { fallback(); return; }
    // some embedded browsers neither grant nor refuse the request: don't wait on it for long
    const t = setTimeout(fallback, 600);
    tw.requestFullscreen().then(() => clearTimeout(t), () => { clearTimeout(t); fallback(); });
  }
  document.addEventListener('fullscreenchange', fsChanged);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && tw.classList.contains('fs-window')) { tw.classList.remove('fs-window'); fsChanged(); } });

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

  // ------------------------------------------------------------------ ambulance run
  // The controller's side of an ambulance: as it gets close to each signal, SAARTHI suggests turning that
  // light green for it; the controller presses the button (the twin waits for the answer), the light changes
  // and the ambulance goes through on green in its lane. Both twins show how it got through each junction.
  function dispatchAmbulance(auto) {
    if (state.amb && !state.amb.done) return; // one at a time, so the panel tells one story
    smart.autoApprove = !!(auto || state.autoApprove);
    fixed.triggerAmbulance();
    const ev = smart.triggerAmbulance();
    state.amb = { f: fixed.eventLog[fixed.eventLog.length - 1], s: smart.eventLog[smart.eventLog.length - 1], ev, at: smart.t, done: false, held: false };
    $('#ev-amb').classList.add('fired');
    setTimeout(() => $('#ev-amb').classList.remove('fired'), 1200);
    state.follow = true;
    renderAmb();
    updateUI();
    $('#amb').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  function setRunning(on) {
    state.running = on;
    $('#btn-play').textContent = on ? 'Pause' : 'Play';
    $('#btn-play').setAttribute('aria-pressed', String(on));
  }
  // An open suggestion: the twin does not move on until the controller answers it.
  const waiting = () => !!(state.amb && smart.pendingSuggestions().some(x => x.ev === state.amb.ev));
  // A new suggestion: the twin waits for the controller (true = stop stepping now).
  function suggestionRaised() {
    if (!smart.newSuggestion) return false;
    smart.newSuggestion = false;
    if (!state.amb || !smart.pendingSuggestions().length) return false;
    if (state.running) { state.amb.held = true; setRunning(false); }
    renderAmb();
    return true;
  }
  function answer(jId, turnGreen) {
    const a = state.amb;
    if (turnGreen) smart.changeLight(a.ev, jId); else smart.leaveLight(a.ev, jId);
    if (!smart.pendingSuggestions().length && a.held) { a.held = false; setRunning(true); }
    renderAmb(); updateLog();
  }
  const sec = v => `${Math.round(v)} s`;
  const kmFmt = m => `${(m / 1000).toFixed(1)} km`;
  function progress(e, sim) {
    const v = e.veh;
    let tot = 0, done = 0;
    v.route.forEach((id, i) => { const L = sim.links[id]; tot += L.length; if (i < v.ri) done += L.length; });
    if (e.arriveAt != null) done = tot;
    else if (v.state === 'link') done += v.pos;
    return { tot, done };
  }
  // What happened at one signal, in the controller's words.
  function outcome(r, p) {
    if (!r) return p && p.ok === false ? '<span class="muted">left on normal control · ahead</span>' : p && p.ok ? `<span class="good">${p.auto === 'green' ? 'already green, SAARTHI keeps it green' : 'you turned it green'} · ahead</span>` : p && p.asked != null ? '<span class="warn">SAARTHI suggests turning it green</span>' : '<span class="muted">ahead</span>';
    const lost = r.lost >= 5 ? ` · lost ${sec(r.lost)}` : '';
    switch (r.how) {
      case 'lane': return '<span class="good">Cross traffic held for a few seconds; crossed in its own lane</span>';
      case 'switched': return `<span class="good">Light turned green ${r.lead > 1 ? `${sec(r.lead)} before it arrived` : 'as it arrived'}${r.lane ? '; crossed in its own lane' : ''}</span>${lost}`;
      case 'kept': return `<span class="good">Already green; kept green for it${r.lane ? '; crossed in its own lane' : ''}</span>${lost}`;
      case 'green': return `Green on its own${lost}`;
      default: return `<span class="bad">${p && p.ok === false ? 'Left on normal control: ' : p && p.ok == null ? 'Light not changed in time: ' : ''}stood ${sec(r.wait)} at red</span>${lost}`;
    }
  }
  function column(e, sim, who) {
    const v = e.veh, pr = progress(e, sim), plan = who === 'smart' && v.plan;
    const sigs = [];
    // every signal on the route, in order: done ones from the trace, the rest still ahead
    const traced = v.trace.filter(r => r.sig);
    let k = 0;
    for (const id of v.route) {
      const L = sim.links[id], j = sim.ctrl(sim.nodes[L.to]);
      if (!(j && j.sig && !L.free)) continue;
      const r = traced[k] && traced[k].j === j.id ? traced[k++] : null;
      sigs.push({ name: sim.jName(j), r, p: plan ? plan.find(p => p.j === j.id) : null });
    }
    const other = v.trace.filter(r => !r.sig), otherWait = other.reduce((s, r) => s + r.wait, 0);
    const status = e.arriveAt != null
      ? `<b>Arrived in ${dur(e.tt)}</b> · ${e.delay < 5 ? 'about the empty-road time' : `${dur(e.delay)} slower than an empty road`}`
      : v.state === 'backlog' ? 'Waiting to enter the map…' : `En route · ${dur(sim.t - e.start)} so far`;
    return `<div class="amb-col">
      <div class="amb-ch"><span class="swatch ${who}"></span><strong>${who === 'smart' ? 'SAARTHI' : 'Fixed timers (today)'}</strong><span class="amb-st">${status}</span></div>
      <div class="amb-bar" title="${kmFmt(pr.done)} of ${kmFmt(pr.tot)}"><i style="width:${(pr.done / pr.tot * 100).toFixed(1)}%"></i></div>
      ${sigs.length ? `<ol class="amb-js">${sigs.map(x => `<li class="${x.r ? 'done' : ''}"><b>${esc(x.name)}</b><span>${outcome(x.r, x.p)}</span></li>`).join('')}</ol>` : '<p class="muted small">No traffic signals on this route. Pick Connaught Place or Sector 34 above to see the lights change for it.</p>'}
      ${other.length ? `<p class="muted small">${other.length} unsignalised junction${other.length === 1 ? '' : 's'} passed (merges, slip roads, U-turn points)${otherWait >= 2 ? `, stood ${sec(otherWait)} there` : ''}</p>` : ''}
    </div>`;
  }
  // Step by step in the SAARTHI twin, with the fixed-timer ambulance's red-light stops and arrival alongside.
  function timeline(a) {
    const rows = a.s.veh.story.map(x => Object.assign({ who: 'smart' }, x));
    for (const r of a.f.veh.trace) if (r.sig && r.how === 'red') rows.push({ who: 'fixed', t: r.t, msg: `Stood ${sec(r.wait)} at red at ${r.name}`, kind: 'bad' });
    if (a.f.arriveAt != null) rows.push({ who: 'fixed', t: a.f.arriveAt, msg: `Reached the hospital: ${dur(a.f.tt)} after it was reported`, kind: 'done' });
    rows.sort((p, q) => p.t - q.t);
    return `<div class="amb-tl"><div class="amb-tl-h">Step by step</div><ol>${rows.map(x => `<li class="k-${x.kind}"><time>${S.fmtClock(x.t)}</time><span class="who ${x.who}">${x.who === 'smart' ? 'SAARTHI' : 'FIXED'}</span><span>${esc(x.msg.replace(/ & Associated Hospitals/, ''))}</span></li>`).join('')}</ol></div>`;
  }
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  let lastAmb = '';
  function renderAmb() {
    const el = $('#amb'), a = state.amb;
    if (!el) return;
    el.hidden = !a;
    if (!a) { lastAmb = ''; return; }
    const ev = a.ev, plan = ev.plan || [], label = a.s.label.replace(/^Ambulance · /, '').replace(/ & Associated Hospitals/, '');
    let html;
    {
      const f = a.f, s = a.s, asked = plan.filter(p => p.asked != null).length, n = plan.filter(p => p.ok).length;
      const changed = s.veh.trace.filter(r => r.how === 'lane' || r.how === 'switched' || r.how === 'kept').length;
      const steps = [
        [true, `${hhmm(a.at)} Ambulance reported`],
        [asked === plan.length, plan.length ? `SAARTHI suggested ${asked} of ${plan.length} light change${plan.length === 1 ? '' : 's'}` : 'No signals on the route: nothing to change'],
        ...(plan.length ? [[asked > 0 && plan.every(p => p.asked == null || p.ok != null || p.rec), `You turned ${n} light${n === 1 ? '' : 's'} green`], [n > 0 && changed >= n, `Ambulance through on green: ${Math.min(changed, n)} of ${n}`]] : []),
        [s.arriveAt != null, s.arriveAt != null ? `${hhmm(s.arriveAt)} Arrived` : 'Arrival'],
      ];
      // the suggestion waiting for the controller, with the buttons
      const pend = smart.pendingSuggestions().filter(x => x.ev === ev);
      const ask = pend.map(({ p, d }) => `<div class="amb-ask">
          <div class="amb-ask-k">SAARTHI suggests${a.held ? '<span class="amb-wait">twin paused until you answer</span>' : ''}</div>
          <p>The ambulance is <b>${d == null ? 'close to' : `${Math.round(d / 10) * 10} m from`} ${esc(p.name)}</b>, coming in on ${esc(p.road)}. Turn this light green for it now${p.inferred ? ' (an inferred signal, to be confirmed by survey)' : ''}${p.lane ? '; it is in the green corridor lane, so nothing is in front of it' : ''}.</p>
          <div class="amb-acts"><button class="btn btn-primary btn-sm" data-amb="green" data-j="${p.j}">Turn light green</button><button class="btn btn-sm" data-amb="leave" data-j="${p.j}">Leave it on normal control</button></div>
        </div>`).join('');
      const auto = plan.length ? `<label class="amb-auto"><input type="checkbox" data-amb="auto"${state.autoApprove ? ' checked' : ''}> Change the lights for ambulances automatically (no asking)</label>` : '';
      a.done = f.arriveAt != null && s.arriveAt != null;
      let foot = '';
      if (a.done) {
        const red = e => e.veh.trace.reduce((x, r) => x + (r.how === 'red' ? r.wait : 0), 0);
        const gain = f.tt - s.tt;
        foot = `<p class="amb-sum">${gain > 5 ? `With SAARTHI it reached the hospital <b>${dur(gain)} sooner</b>` : gain < -5 ? `The fixed-timer ambulance got there ${dur(-gain)} sooner this time` : 'Both got there in about the same time'}: ${sec(red(s))} standing at red lights vs ${sec(red(f))} on fixed timers.</p>`;
      }
      html = `<div class="amb-h"><h4>Ambulance run · ${esc(label)}</h4>
          <span class="amb-btns"><button class="btn btn-sm${state.follow ? ' on' : ''}" data-amb="follow" aria-pressed="${state.follow}">${state.follow ? 'Following on the map' : 'Follow on the map'}</button>${a.done ? '<button class="btn btn-sm btn-ghost" data-amb="close">Close</button>' : ''}</span></div>
        <ol class="amb-steps">${steps.map(([ok, t]) => `<li class="${ok ? 'ok' : ''}">${t}</li>`).join('')}</ol>
        ${ask}${auto}
        ${timeline(a)}
        <div class="amb-cols">${column(f, fixed, 'fixed')}${column(s, smart, 'smart')}</div>${foot}
        <p class="fine">SAARTHI suggests each change when the ambulance is about 500 m from the signal; a light you turn green changes at once and stays green until it has crossed, then goes back to normal control. Fixed timers: nobody is asked and the lights run their timers. A junction policeman can wave an ambulance through if radioed in time; that is not modelled here.</p>`;
    }
    if (html !== lastAmb) {
      const tl = el.querySelector('.amb-tl ol'), atEnd = !tl || tl.scrollTop + tl.clientHeight >= tl.scrollHeight - 4;
      el.innerHTML = html; lastAmb = html;
      const n = el.querySelector('.amb-tl ol');
      if (n && atEnd) n.scrollTop = n.scrollHeight;
    }
    if (a.done && state.follow && !a.followEnd) { a.followEnd = true; setTimeout(stopFollow, 3000); }
  }
  $('#amb').addEventListener('click', e => {
    const b = e.target.closest('[data-amb]');
    if (!b || !state.amb) return;
    const k = b.dataset.amb;
    if (k === 'green' || k === 'leave') answer(b.dataset.j, k === 'green');
    else if (k === 'auto') {
      state.autoApprove = smart.autoApprove = b.checked;
      if (b.checked) for (const x of smart.pendingSuggestions()) answer(x.p.j, true);
    }
    else if (k === 'follow') { if (state.follow) stopFollow(); else { state.follow = true; renderAmb(); } }
    else if (k === 'close') { state.amb = null; stopFollow(); renderAmb(); }
  });

  // Follow: each map keeps its own ambulance in the middle (the two drift apart, so the views split while following).
  function stopFollow() {
    if (!state.follow && rSmart.view === rFixed.view) return;
    state.follow = false;
    rSmart.view = rFixed.view;
    rFixed.resetView();
    renderAmb();
  }
  function followStep() {
    if (!state.follow || !state.amb) return;
    if (rSmart.view === rFixed.view) rSmart.view = { z: rFixed.view.z, cx: rFixed.view.cx, cy: rFixed.view.cy };
    for (const [r, e] of [[rFixed, state.amb.f], [rSmart, state.amb.s]]) {
      const p = (r.evAt || []).find(x => x.veh === e.veh);
      if (!p) continue;
      const v = r.view;
      v.z = Math.max(v.z, 4);
      if (v.cx == null) { v.cx = p.x; v.cy = p.y; }
      v.cx += (p.x - v.cx) * 0.15; v.cy += (p.y - v.cy) * 0.15;
    }
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
    renderAmb();
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
      if (state.running && !waiting()) {
        acc += dt * state.speed;
        let n = 0;
        const t0 = performance.now();
        // big real networks can't always keep up at 60×: drop the backlog rather than freeze the page
        while (acc >= S.DT && n < 800 && performance.now() - t0 < 40) { fixed.step(); smart.step(); acc -= S.DT; n++; if (suggestionRaised()) { acc = 0; break; } }
        if (acc >= S.DT) acc = 0;
      }
      followStep();
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
  if (qs.get('amb')) { dispatchAmbulance(true); fastForward(60); }
  if (qs.get('park')) { both(s => s.triggerBlockage()); fastForward(+qs.get('park') > 1 ? +qs.get('park') * 60 : 60); }
  requestAnimationFrame(frame);
})();
