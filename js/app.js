/* UI wiring: runs both twins in lockstep and keeps the dashboard in sync. */
(function () {
  'use strict';
  const S = window.SAARTHI;
  const $ = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));

  const state = {
    running: true, speed: 5, startHour: 8.5, demand: 1, view: 'split', colorBy: 'speed',
    seed: 7, selected: 'FC-01', approach: 0,
    features: { greenCorridor: true, metering: true, vms: true, enforcement: true },
  };
  let fixed = null, smart = null;

  const rFixed = new window.Renderer($('#cv-fixed'));
  const rSmart = new window.Renderer($('#cv-smart'));
  const minFmt = (v, axis) => (v == null ? '—' : axis ? v.toFixed(v < 10 ? 1 : 0) : `${v.toFixed(1)} min`);
  const intFmt = v => (v == null ? '—' : Math.round(v).toLocaleString('en-IN'));
  const hhmm = t => S.fmtClock(t).slice(0, 5);
  const chP95 = new window.LineChart($('#ch-p95'), { fmt: minFmt, xfmt: hhmm });
  const chQueue = new window.LineChart($('#ch-queue'), { fmt: intFmt, xfmt: hhmm });

  // ------------------------------------------------------------------ theme
  function readTheme() {
    const cs = getComputedStyle(document.documentElement);
    const v = n => cs.getPropertyValue(n).trim();
    const t = {
      ground: v('--map-ground'), block: v('--map-block'), blockText: v('--map-block-text'), road: v('--map-road'),
      median: v('--map-median'), lane: v('--map-lane'), kerb: v('--map-kerb'), parked: v('--map-parked'),
      label: v('--map-label'), label2: v('--map-label-2'), accent: v('--accent'),
      green: v('--status-good'), amber: v('--status-warn'), red: v('--status-crit'),
      types: { car: v('--t-car'), tw: v('--t-tw'), auto: v('--t-auto'), erick: v('--t-erick'), bus: v('--t-bus'), truck: v('--t-truck') },
      surface: v('--surface'), ink2: v('--ink-2'), muted: v('--muted'), grid: v('--grid'), axis: v('--axis'),
      fixed: v('--series-fixed'), smart: v('--series-smart'),
    };
    rFixed.theme = rSmart.theme = chP95.theme = chQueue.theme = t;
    return t;
  }
  let theme = readTheme();
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { theme = readTheme(); updateCharts(); renderLegend(); });

  // ------------------------------------------------------------------ setup
  function reset(newSeed) {
    if (newSeed) state.seed = (Math.random() * 1e9) >>> 0;
    const common = { seed: state.seed, startHour: state.startHour, demandMult: state.demand, warmup: true };
    fixed = new S.Sim(Object.assign({ mode: 'fixed' }, common));
    smart = new S.Sim(Object.assign({ mode: 'adaptive', features: Object.assign({}, state.features) }, common));
    rFixed.sim = fixed;
    rSmart.sim = smart;
    $$('.scen-btns .btn').forEach(b => b.classList.remove('fired'));
    buildJunctionTabs();
    updateUI();
    updateCharts();
  }

  function resizeAll() {
    rFixed.resize(); rSmart.resize();
    chP95.draw(); chQueue.draw();
  }
  window.addEventListener('resize', resizeAll);

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

  $('#sel-start').addEventListener('change', e => { state.startHour = +e.target.value; reset(false); });
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
  fire($('#ev-park'), s => s.triggerBlockage('FC-03>FC-04'));
  fire($('#ev-surge'), s => s.triggerSurge('S18', 1.6, 20));
  fire($('#ev-cam'), s => s.triggerCameraFault('FC-03', 5));

  $$('.toggles input').forEach(inp => inp.addEventListener('change', () => {
    state.features[inp.dataset.f] = inp.checked;
    if (smart) smart.features[inp.dataset.f] = inp.checked;
  }));

  function onCanvasClick(r) {
    return e => {
      const id = r.hit(e.clientX, e.clientY);
      if (id) selectJunction(id);
    };
  }
  $('#cv-fixed').addEventListener('click', onCanvasClick(rFixed));
  $('#cv-smart').addEventListener('click', onCanvasClick(rSmart));

  function buildJunctionTabs() {
    const el = $('#seg-junction');
    el.innerHTML = fixed.junctions.map(j =>
      `<button data-v="${j.id}" class="${j.id === state.selected ? 'on' : ''}" title="${j.name}">${j.id} · ${j.corner}</button>`).join('');
    el.onclick = e => { const b = e.target.closest('button'); if (b) selectJunction(b.dataset.v); };
  }

  function selectJunction(id) {
    state.selected = rFixed.selected = rSmart.selected = id;
    state.approach = 0;
    $$('#seg-junction button').forEach(b => b.classList.toggle('on', b.dataset.v === id));
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
    const marks = [
      ['#ffffff', 'Ambulance (flashing)'],
    ];
    $('#legend').innerHTML = items.concat(marks).map(([c, l]) => `<span><i style="background:${c};box-shadow:0 0 0 1px var(--border)"></i>${l}</span>`).join('')
      + `<span>Stop-line bar = signal state · click a junction to inspect it</span>`;
  }

  // ------------------------------------------------------------------ KPIs
  const dur = v => S.fmtDur(v);
  const METRICS = [
    { key: 'p95', label: '95th-percentile trip time', note: 'the bad-day measure the brief targets', fmt: dur, better: 'lower' },
    { key: 'avgTrip', label: 'Average trip time', fmt: dur, better: 'lower' },
    { key: 'corridor', label: 'DND → Greater Noida crossing', note: 'average', fmt: dur, better: 'lower' },
    { key: 'wait', label: 'Wait per junction', note: 'average stopped time', fmt: v => (v == null ? '—' : `${Math.round(v)} s`), better: 'lower' },
    { key: 'throughput', label: 'Throughput', fmt: v => (v == null ? '—' : `${intFmt(v)} veh/h`), better: 'higher' },
    { key: 'stops', label: 'Stops per vehicle', fmt: v => (v == null ? '—' : v.toFixed(1)), better: 'lower' },
    { key: 'backlog', label: 'Queued outside the loop', note: 'vehicles waiting to enter', fmt: intFmt, better: 'lower' },
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

  function updateKpis(kf, ks) {
    $('#kpi-body').innerHTML = METRICS.map(m => `<tr>
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
          : `Both systems are coping. Raise demand or start at a peak hour to stress the corridor.`;
    } else h.textContent = 'Collecting trips…';
  }

  function chips(el, sim, k) {
    const gl = sim.junctions.filter(j => j.inGridlock).length;
    el.innerHTML = `<span class="chip">${intFmt(k.inNet)} in loop</span>`
      + `<span class="chip ${k.backlog > 20 ? 'alert' : ''}">${intFmt(k.backlog)} queued upstream</span>`
      + (gl ? `<span class="chip alert">${gl} junction${gl > 1 ? 's' : ''} gridlocked</span>` : '');
  }

  // ------------------------------------------------------------------ inspector & log
  function updateInspector() {
    if (!fixed) return;
    const jf = fixed.nodes[state.selected], js = smart.nodes[state.selected];
    const af = fixed.approachInfo(jf), as = smart.approachInfo(js);
    if (state.approach >= af.length) state.approach = 0;
    const cell = (a, extra) => `${a.queue.toFixed(0)} PCU<span class="sig ${a.state}" title="${a.state === 'G' ? 'green' : a.state === 'Y' ? 'amber' : 'red'}"></span>${extra || ''}`;
    $('#insp-body').innerHTML = af.map((a, i) => `<tr data-i="${i}" class="${i === state.approach ? 'sel' : ''}">
      <td>${a.name}<span class="sub2">from ${a.approach} · fixed green ${a.plan}s</span></td>
      <td class="num">${cell(a)}</td>
      <td class="num">${cell(as[i])}</td></tr>`).join('');
    $('#edge-name').textContent = `${js.id} · ${js.approaches[state.approach].name}`;
    $('#edge-json').textContent = edgeJson(smart.edgeState(js, state.approach));
  }

  function edgeJson(o) { // same layout as the edge message on deck slide 7
    const lanes = o.lanes.map(l => `   ${JSON.stringify(l)}`).join(',\n');
    return `{ "junction_id":"${o.junction_id}", "approach":"${o.approach}",\n  "lanes":[\n${lanes}],\n`
      + `  "turning":${JSON.stringify(o.turning)},\n  "incident":${o.incident} }`;
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
    $('#clock-sub').textContent = `simulated time · ${state.running ? `${state.speed}× real time` : 'paused'}`;
    updateKpis(kf, ks);
    chips($('#chips-fixed'), fixed, kf);
    chips($('#chips-smart'), smart, ks);
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
  }

  // ------------------------------------------------------------------ main loop
  let last = performance.now(), acc = 0, uiT = 0, chartT = 0;
  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (state.running && fixed) {
      acc += dt * state.speed;
      let n = 0;
      while (acc >= S.DT && n < 800) { fixed.step(); smart.step(); acc -= S.DT; n++; }
      if (n >= 800) acc = 0;
    }
    if (state.view !== 'smart') rFixed.draw(now);
    if (state.view !== 'fixed') rSmart.draw(now);
    if (now - uiT > 300) { uiT = now; updateUI(); }
    if (now - chartT > 1000) { chartT = now; updateCharts(); }
    requestAnimationFrame(frame);
  }

  reset(false);
  renderLegend();
  resizeAll();
  // ?ff=N fast-forwards N × 15 min on load; ?amb=1 dispatches an ambulance afterwards (for demos/screenshots)
  const qs = new URLSearchParams(location.search);
  if (+qs.get('ff') > 0) fastForward(900 * +qs.get('ff'));
  if (qs.get('amb')) { both(s => s.triggerAmbulance()); fastForward(60); }
  requestAnimationFrame(frame);
})();
