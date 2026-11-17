/* Plan ahead: scenario form + map, runs the what-if planner in the browser and renders its recommendation. */
(function () {
  'use strict';
  const S = window.SAARTHI, W = window.SAARTHI_PLANNER;
  const $ = sel => document.querySelector(sel);
  const NS = 'http://www.w3.org/2000/svg';
  const { hhmm } = W;
  const dur = S.fmtDur;
  const clock = t => S.fmtClock(t).slice(0, 5);
  const intFmt = v => (v == null ? '—' : Math.round(v).toLocaleString('en-IN'));

  // Real areas whose road network is loaded on this page, then the schematic loop.
  const AREA_IDS = Object.keys(W.AREAS).filter(id => W.AREAS[id].schematic || (window.SAARTHI_NETWORKS || {})[id]);

  function blurb(type, A) {
    if (type === 'protest') return A.schematic ? 'A rally blocks one side of the loop in both directions. Pick the road and the time window.'
      : 'A rally blocks a stretch of a main road in both directions. Pick the road and the time window.';
    if (type === 'vip') return 'A VIP or summit movement (G20-style) needs a secure route for its convoys while everyone else keeps moving. Schools and offices may be closed by order.';
    return A.schematic ? 'A concert, match or sale near Sector 18. Attendees park on the kerb during the event, then the crowd leaves all at once.'
      : `A concert, match or sale at ${A.venue.name}. Attendees park on the kerb nearby during the event, then the crowd drives off all at once.`;
  }

  // ------------------------------------------------------------------ form
  // The area is the one open in the control console (its Plan ahead tab).
  const CON = window.SAARTHI_CONSOLE;
  const st = { type: 'protest', area: CON && AREA_IDS.includes(CON.area) ? CON.area : AREA_IDS.includes(W.DEFAULT_AREA) ? W.DEFAULT_AREA : AREA_IDS[0], values: {} };
  const key = () => `${st.area}|${st.type}`;
  const vals = () => Object.assign(W.defaultsFor(st.type, st.area), st.values[key()]);
  const setVal = (k, v) => { st.values[key()] = Object.assign(st.values[key()] || {}, { [k]: v }); };

  const STARTS = [];
  for (let h = 7; h <= 21; h += 0.5) STARTS.push([h, hhmm(h)]);

  function select(k, label, options, cur, full) {
    return `<label class="wi-field${full ? ' full' : ''}"><span>${label}</span><select data-k="${k}">${options.map(([v, t]) =>
      `<option value="${v}"${String(v) === String(cur[k]) ? ' selected' : ''}>${t}</option>`).join('')}</select></label>`;
  }
  function range(k, label, min, max, step, cur, fmt) {
    return `<label class="wi-field full"><span>${label}</span><div class="rng"><input type="range" data-k="${k}" min="${min}" max="${max}" step="${step}" value="${cur[k]}">`
      + `<output data-for="${k}">${fmt(+cur[k])}</output></div></label>`;
  }
  const FMT = {
    holiday: v => (v > 0 ? `−${Math.round(v * 100)}% traffic` : 'open as usual'),
    surge: v => `+${Math.round(v * 100)}% leaving`,
    crowd: v => `${v.toLocaleString('en-IN')} vehicles`,
  };

  const areaSel = $('#wi-area');
  areaSel.innerHTML = AREA_IDS.map(id => `<option value="${id}"${id === st.area ? ' selected' : ''}>${W.AREAS[id].label}</option>`).join('');
  areaSel.addEventListener('change', () => { st.area = areaSel.value; renderFields(); inputsChanged(); });

  function renderFields() {
    const v = vals(), A = W.AREAS[st.area];
    let html = select('start', st.type === 'event' ? 'Event starts' : 'Starts at', STARTS, v)
      + select('duration', 'Lasts', [[1, '1 hour'], [1.5, '1.5 hours'], [2, '2 hours']], v);
    if (st.type === 'protest') {
      html += select('segment', 'Road blocked (both directions)', A.protest.map(s => [s.key, s.name]), v, true);
    } else if (st.type === 'vip') {
      html += select('vipRoute', 'VIP route', A.vip.map(r => [r.key, r.name]), v, true)
        + select('convoys', 'Convoys in the window', [[1, '1 convoy'], [2, '2 convoys'], [3, '3 convoys']], v)
        + '<span></span>'
        + range('holiday', 'Schools & offices closed by order', 0, 0.3, 0.05, v, FMT.holiday);
    } else if (A.schematic) {
      html += range('surge', 'Crowd leaving Sector 18 afterwards', 0.4, 1.2, 0.1, v, FMT.surge);
    } else {
      html += range('crowd', `Vehicles leaving ${A.venue.name} afterwards`, 300, 2000, 100, v, FMT.crowd);
    }
    $('#wi-fields').innerHTML = html;
    $('#wi-blurb').textContent = blurb(st.type, A);
  }

  function onField(e) {
    const k = e.target.dataset.k;
    if (!k) return;
    const raw = e.target.value;
    setVal(k, isNaN(+raw) ? raw : +raw);
    const out = $(`#wi-fields output[data-for="${k}"]`);
    if (out) out.textContent = FMT[k](+raw);
    inputsChanged();
  }
  $('#wi-fields').addEventListener('input', onField);
  $('#wi-fields').addEventListener('change', onField);
  $('#wi-dist').addEventListener('change', inputsChanged);

  $('#wi-type').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    $('#wi-type').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    st.type = b.dataset.v;
    renderFields();
    inputsChanged();
  });

  let last = null;
  function inputsChanged() {
    drawMap(last && sameInputs(last) ? last : null);
    if (last) $('#wi-out').style.opacity = sameInputs(last) ? '' : '0.5';
  }
  const currentInput = () => Object.assign({ type: st.type, disturbance: $('#wi-dist').checked }, vals());
  const sameInputs = res => JSON.stringify(res.P.input) === JSON.stringify(Object.assign(W.defaultsFor(st.type, st.area), currentInput()));

  // ------------------------------------------------------------------ map of the disruption
  function el(tag, attrs, parent, text) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (text != null) e.textContent = text;
    parent.appendChild(e);
    return e;
  }
  function label(g, x, y, text, color, size) {
    return el('text', { x, y, 'text-anchor': 'middle', 'font-size': size || 17, 'font-weight': 700, fill: color }, g, text);
  }

  function drawMap(res) {
    const svg = $('#wi-svg');
    svg.innerHTML = '';
    const P = res ? res.P : W.build(currentInput());
    if (P.schematic) drawLoop(svg, P, res); else drawReal(svg, P, res);
  }

  // The schematic Film City loop
  const N = Object.fromEntries(S.NETWORK.junctions.concat(S.NETWORK.externals).map(n => [n.id, n]));
  const C = (() => { const js = S.NETWORK.junctions; return [js.reduce((a, j) => a + j.x, 0) / 4, js.reduce((a, j) => a + j.y, 0) / 4]; })();

  function side(id, k) { // a directional link drawn on its own side of the road (India drives on the left)
    const [a, b] = id.split('>').map(n => N[n]);
    const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy), nx = dy / d * k, ny = -dx / d * k;
    return [a.x + nx, a.y + ny, b.x + nx, b.y + ny];
  }
  function mid(id, out) { // midpoint pushed away from Film City by `out`
    const [a, b] = id.split('>').map(n => N[n]);
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, dx = mx - C[0], dy = my - C[1], d = Math.hypot(dx, dy) || 1;
    return [mx + dx / d * out, my + dy / d * out];
  }

  function drawLoop(svg, P, res) {
    svg.setAttribute('viewBox', '0 0 1000 640');
    svg.style.setProperty('--halo', '5px');
    const R = S.NETWORK.ring;
    const gBase = el('g', {}, svg), gOver = el('g', {}, svg), gNode = el('g', {}, svg), gLab = el('g', {}, svg);
    for (let i = 0; i < R.length; i++) {
      const a = N[R[i]], b = N[R[(i + 1) % R.length]];
      el('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: 'var(--surface-3)', 'stroke-width': 30, 'stroke-linecap': 'round' }, gBase);
    }
    for (const x of S.NETWORK.externals) {
      const j = N[x.j];
      el('line', { x1: x.x, y1: x.y, x2: j.x, y2: j.y, stroke: 'var(--surface-3)', 'stroke-width': 24, 'stroke-linecap': 'round' }, gBase);
      el('circle', { cx: x.x, cy: x.y, r: 7, fill: 'var(--surface)', stroke: 'var(--line-2)', 'stroke-width': 2 }, gNode);
      el('text', { x: x.x + (x.x < 500 ? 14 : -14), y: x.y + (x.y < 320 ? 26 : -14), 'text-anchor': x.x < 500 ? 'start' : 'end', 'font-size': 17, fill: 'var(--muted)' }, gLab, x.name);
    }
    for (const j of S.NETWORK.junctions) {
      el('circle', { cx: j.x, cy: j.y, r: 22, fill: 'var(--surface)', stroke: 'var(--accent)', 'stroke-width': 3 }, gNode);
      el('text', { x: j.x, y: j.y + 6, 'text-anchor': 'middle', 'font-size': 15, 'font-weight': 700, fill: 'var(--ink)' }, gNode, j.id.replace('FC-', ''));
    }
    el('text', { x: C[0], y: C[1] + 6, 'text-anchor': 'middle', 'font-size': 18, 'font-weight': 600, fill: 'var(--muted)', 'letter-spacing': 3 }, gLab, 'FILM CITY');

    let cap = '';
    if (res) { // the main public diversions, under the event overlay
      for (const r of res.reco.routes.slice(0, 2)) {
        const ns = [r.ids[0].split('>')[0]].concat(r.ids.map(id => id.split('>')[1]));
        el('polyline', { points: ns.map(id => `${N[id].x},${N[id].y}`).join(' '), fill: 'none', stroke: 'var(--status-good)', 'stroke-width': 5, 'stroke-dasharray': '2 10', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: 0.9 }, gOver);
      }
    }
    if (P.type === 'protest') {
      const seg = P.site, a = N[seg.a], b = N[seg.b];
      el('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: 'var(--status-crit)', 'stroke-width': 30, opacity: 0.85 }, gOver);
      const [mx, my] = mid(`${seg.a}>${seg.b}`, 0);
      label(gLab, mx, my + 6, '✕ CLOSED', '#fff', 16);
      const [lx, ly] = mid(`${seg.a}>${seg.b}`, 46);
      label(gLab, lx, ly + 6, `Protest ${hhmm(P.start)}–${hhmm(P.end)}`, 'var(--bad-text)');
      cap = `Both directions of ${seg.name} closed ${hhmm(P.start)}–${hhmm(P.end)}.`;
    } else if (P.type === 'vip') {
      for (const id of P.vip.links) {
        const [x1, y1, x2, y2] = side(id, 9);
        el('line', { x1, y1, x2, y2, stroke: 'var(--vip)', 'stroke-width': 9, 'stroke-linecap': 'round' }, gOver);
      }
      const o = N[P.vip.origin], d = N[P.vip.dest];
      const first = P.vip.links[0], lastL = P.vip.links[P.vip.links.length - 1];
      for (const [x, id, end] of [[o, first, 0], [d, lastL, 1]]) {
        const j = N[id.split('>')[end]];
        el('line', { x1: x.x, y1: x.y, x2: j.x, y2: j.y, stroke: 'var(--vip)', 'stroke-width': 9, 'stroke-linecap': 'round', opacity: 0.55 }, gOver);
      }
      const [lx, ly] = mid(P.vip.links[0], 48);
      label(gLab, lx, ly + 6, `VIP route · convoys ${P.vip.times.map(hhmm).join(', ')}`, 'var(--vip)');
      cap = `VIP convoys ${P.vip.route}. ${+P.input.holiday > 0 ? `Schools and offices closed (−${Math.round(P.input.holiday * 100)}% traffic).` : ''}`;
    } else {
      for (const id of P.parkLinks) {
        const [x1, y1, x2, y2] = side(id, 12);
        el('line', { x1, y1, x2, y2, stroke: 'var(--status-warn)', 'stroke-width': 7, 'stroke-dasharray': '10 6' }, gOver);
      }
      const s18 = N.S18, j3 = N['FC-03'];
      el('line', { x1: s18.x, y1: s18.y, x2: j3.x, y2: j3.y, stroke: 'var(--status-crit)', 'stroke-width': 12, 'stroke-linecap': 'round', opacity: 0.55 }, gOver);
      label(gLab, (s18.x + j3.x) / 2 - 10, (s18.y + j3.y) / 2 + 44, `Crowd leaves +${Math.round(P.input.surge * 100)}% at ${hhmm(P.end)}`, 'var(--bad-text)');
      const [lx, ly] = mid(P.parkLinks[0], 46);
      label(gLab, lx, ly + 6, `Kerb parking ${hhmm(P.input.start)}–${hhmm(P.end + 0.5)}`, 'var(--status-warn)');
      cap = `Event ${hhmm(P.input.start)}–${hhmm(P.end)}: kerb lanes into FC-03 lost to parking, then the crowd leaves Sector 18.`;
    }
    if (res && res.P.incident) {
      const [mx, my] = mid(res.P.incident.link, 0), [x1, y1] = side(res.P.incident.link, 9);
      const cx = (mx + x1) / 2, cy = (my + y1) / 2;
      el('circle', { cx, cy, r: 15, fill: 'var(--status-crit)', stroke: '#fff', 'stroke-width': 3 }, gLab);
      label(gLab, cx, cy + 6, '!', '#fff', 17);
      const [lx, ly] = mid(res.P.incident.link, 52);
      label(gLab, lx, ly + 6, `Crash ${clock(res.P.dist.at)}`, 'var(--bad-text)', 16);
    }
    if (res && res.reco.routes.length) cap += ' Green dashes: main public diversions.';
    $('#wi-cap').textContent = cap;
  }

  // A real OpenStreetMap area: every mapped road drawn to scale, the disruption on top.
  function drawReal(svg, P, res) {
    const g = W.geoFor(P.area), { w, h } = g.net.size, k = w / 1000; // k: map metres per unit of the schematic's text sizes
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.style.setProperty('--halo', `${5 * k}px`);
    const BM = window.SAARTHI_BASEMAP, th = window.SAARTHI_THEME, withMap = BM && BM.mode !== 'off';
    const gMap = el('g', {}, svg), gBase = el('g', withMap ? { opacity: 0.55 } : {}, svg), gOver = el('g', {}, svg), gLab = el('g', {}, svg);
    if (withMap) BM.drawSvg(gMap, g.net, svg.getBoundingClientRect().width, th ? th.ground : getComputedStyle(document.documentElement).getPropertyValue('--map-ground'));
    const pts = id => g.links[id].pts.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
    const line = (id, attrs, parent) => el('polyline', Object.assign({ points: pts(id), fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, attrs), parent || gOver);
    const centre = ids => { // middle point of a set of links
      const ps = ids.map(id => { const L = g.links[id]; return L.pts[Math.floor(L.pts.length / 2)]; });
      const x = ps.reduce((s, p) => s + p[0], 0) / ps.length, y = ps.reduce((s, p) => s + p[1], 0) / ps.length;
      return [x, y];
    };
    const tag = (x, y, text, color, size) => label(gLab, Math.min(w - 40 * k, Math.max(40 * k, x)), Math.min(h - 10 * k, Math.max(24 * k, y)), text, color, (size || 17) * k);

    for (const L of g.linkList) {
      const wd = Math.max(5, 3.2 * g.generalLanes(L)) * k / 1.5;
      line(L.id, { stroke: L.level > 0 ? 'var(--muted)' : 'var(--line-2)', 'stroke-width': wd, opacity: L.level > 0 ? 0.55 : L.level < 0 ? 0.6 : 1 }, gBase);
    }
    // a few main road names, for orientation
    const named = {};
    for (const L of g.linkList) if (L.kind === 'road' && L.level === 0 && !/ road [PJ]\d/.test(L.name)) (named[L.name] = named[L.name] || []).push(L);
    Object.entries(named).map(([n, Ls]) => [n, Ls, Ls.reduce((s, L) => s + L.length, 0)]).sort((a, b) => b[2] - a[2]).slice(0, 6).forEach(([n, Ls]) => {
      const L = Ls.slice().sort((a, b) => b.length - a.length)[0], p = L.pts[Math.floor(L.pts.length / 2)];
      el('text', { x: p[0], y: p[1] - 14 * k, 'text-anchor': 'middle', 'font-size': 16 * k, fill: 'var(--ink-2)' }, gLab, n);
    });

    let cap = '';
    if (res) for (const r of res.reco.routes.filter(r => r.ids).slice(0, 2)) {
      for (const id of r.ids) line(id, { stroke: 'var(--status-good)', 'stroke-width': 7 * k, 'stroke-dasharray': `${2 * k} ${10 * k}`, opacity: 0.9 });
    }
    const pct = Math.round(P.stranded * 100);
    const strandText = pct > 0 ? ` On the mapped roads ${pct}% of the area's trips have no way round while it's closed, so they're signed to go round the area.` : '';
    if (P.type === 'protest') {
      for (const id of P.closed) line(id, { stroke: 'var(--status-crit)', 'stroke-width': 16 * k, opacity: 0.85 });
      const [x, y] = centre(P.closed);
      tag(x, y - 26 * k, `✕ Protest ${hhmm(P.start)}–${hhmm(P.end)}`, 'var(--bad-text)');
      cap = `Both directions of ${P.site.name} closed ${hhmm(P.start)}–${hhmm(P.end)}.${strandText}`;
    } else if (P.type === 'vip') {
      const all = g.routeOptions(P.vip.origin, P.vip.dest)[0].ids;
      for (const id of all) line(id, { stroke: 'var(--vip)', 'stroke-width': 9 * k, opacity: P.vip.links.includes(id) ? 1 : 0.55 });
      const [x, y] = centre(P.vip.links);
      tag(x, y - 24 * k, `VIP route · convoys ${P.vip.times.map(hhmm).join(', ')}`, 'var(--vip)');
      cap = `VIP convoys ${P.vip.route}. ${+P.input.holiday > 0 ? `Schools and offices closed (−${Math.round(P.input.holiday * 100)}% traffic).` : ''}`;
    } else {
      for (const id of P.parkLinks) line(id, { stroke: 'var(--status-warn)', 'stroke-width': 8 * k, 'stroke-dasharray': `${10 * k} ${6 * k}` });
      for (const id of P.venue.links) line(id, { stroke: 'var(--status-crit)', 'stroke-width': 8 * k, opacity: 0.55 });
      el('circle', { cx: P.venue.x, cy: P.venue.y, r: 14 * k, fill: 'var(--status-crit)', stroke: '#fff', 'stroke-width': 3 * k }, gLab);
      tag(P.venue.x, P.venue.y - 26 * k, `${P.venue.name}: ${Number(P.input.crowd).toLocaleString('en-IN')} vehicles leave at ${hhmm(P.end)}`, 'var(--bad-text)');
      cap = `Event ${hhmm(P.input.start)}–${hhmm(P.end)} at ${P.venue.name}: kerb lanes nearby lost to parking (amber), then the crowd drives off.`;
    }
    if (res && res.P.incident) {
      const L = g.links[res.P.incident.link], p = L.pts[Math.floor(L.pts.length / 2)];
      el('circle', { cx: p[0], cy: p[1], r: 15 * k, fill: 'var(--status-crit)', stroke: '#fff', 'stroke-width': 3 * k }, gLab);
      label(gLab, p[0], p[1] + 6 * k, '!', '#fff', 17 * k);
      tag(p[0], p[1] + 40 * k, `Crash ${clock(res.P.dist.at)}`, 'var(--bad-text)', 16);
    }
    if (res && res.reco.routes.some(r => r.ids)) cap += ' Green dashes: main public diversions.';
    cap += ` Simulated roads from OpenStreetMap; flyovers in a lighter shade.${withMap ? ` ${BM.credit()}.` : ''}`;
    $('#wi-cap').textContent = cap;
  }

  // ------------------------------------------------------------------ run
  let running = false;
  $('#wi-run').addEventListener('click', () => {
    if (running) return;
    running = true;
    const btn = $('#wi-run');
    btn.disabled = true;
    $('#wi-progress').hidden = false;
    const run = W.createRun(currentInput(), { seed: 7 });
    const slow = run.P.schematic ? '' : ' (a real map takes a few minutes)';
    const t0 = performance.now();
    function tick() {
      run.step(28);
      $('#wi-fill').style.width = `${(run.progress * 100).toFixed(1)}%`;
      $('#wi-status').textContent = `${run.label}${slow}… ${run.clock ? clock(run.clock) : ''}`;
      if (!run.done) { setTimeout(tick, 0); return; }
      running = false;
      btn.disabled = false;
      $('#wi-status').textContent = `✓ ${run.result.P.arms.length + (run.result.P.dist ? 2 : 0)} simulations in ${((performance.now() - t0) / 1000).toFixed(0)} s`;
      last = run.result;
      render(last);
    }
    setTimeout(tick, 30);
  });

  // ------------------------------------------------------------------ results
  const chart = new window.LineChart($('#wi-chart'), { fmt: intFmt, xfmt: clock });
  const dchart = new window.LineChart($('#wi-dchart'), { fmt: intFmt, xfmt: clock });
  const cut = (a, b) => (a ? (a - b) / a * 100 : 0);
  const pct = v => `${v >= 0 ? '−' : '+'}${Math.abs(v).toFixed(0)}%`;

  function render(res) {
    const { P, reco } = res, { rec, best, why, actions, routes } = reco;
    const today = P.arms.find(a => a.baseline);
    const hasClosures = P.type !== 'event';
    const wentRound = P.arms.some(a => a.m.avoided > 0);
    $('#wi-out').hidden = false;
    $('#wi-out').style.opacity = '';

    const kpi = (big, text, neutral) => `<div class="wi-kpi"><b class="${neutral ? 'neutral' : ''}">${big}</b><span>${text}</span></div>`;
    const kp = [
      kpi(pct(cut(today.m.p95, rec.m.p95)), `95th-percentile trip vs today (${dur(rec.m.p95)} vs ${dur(today.m.p95)})`),
      kpi(pct(cut(today.m.peakStopped, rec.m.peakStopped)), `peak vehicles stopped (${intFmt(rec.m.peakStopped)} vs ${intFmt(today.m.peakStopped)})`),
    ];
    if (P.type === 'vip') kp.push(kpi(dur(rec.m.vipDelay), `worst VIP convoy delay (today ${dur(today.m.vipDelay)})`, true));
    if (hasClosures) kp.push(kpi(intFmt(rec.m.turnedBack), `drivers turned back at barricades (today ${intFmt(today.m.turnedBack)})`, true));
    if (P.type !== 'vip') kp.push(kpi(pct(cut(today.m.avg, rec.m.avg)), `average trip vs today (${dur(rec.m.avg)} vs ${dur(today.m.avg)})`));
    if (P.type === 'event') kp.push(kpi(intFmt(rec.m.nudged), 'regular commuters shifted by departure advice', true));
    $('#wi-reco').innerHTML = `<div><div class="wi-reco-k">Recommended plan · ${P.areaLabel}</div><h3>${rec.name}</h3><p>${rec.desc}</p>`
      + `<ul class="wi-why">${why.map(w => `<li>${w}</li>`).join('')}</ul></div>`
      + `<div class="wi-kpis">${kp.join('')}</div>`
      + `<div class="wi-actions">${CON && !P.schematic ? '<button class="btn btn-primary" id="wi-sched">Schedule this plan <span aria-hidden="true">→</span></button>' : ''}`
      + `<button class="btn btn-ghost" id="wi-watch">Compare in the live twin</button>`
      + `<span class="fine">${CON && !P.schematic ? `Schedule: it runs in the console's live twin at ${hhmm(P.type === 'event' ? P.input.start : P.start)} (today, or tomorrow if that time has passed), with the plan's advance notice. ` : ''}Compare: today's approach and this plan side by side in section 03${P.dist ? ', crash included' : ''}.</span></div>`;
    $('#wi-watch').addEventListener('click', () => watch(res));
    const sb = $('#wi-sched');
    if (sb) sb.addEventListener('click', () => { if (CON.schedule(res)) { sb.disabled = true; sb.textContent = 'Scheduled ✓'; } });

    // options table
    const cols = [['95th pct trip', a => dur(a.m.p95)], ['Avg trip', a => dur(a.m.avg)], ['Peak stopped', a => intFmt(a.m.peakStopped)]];
    if (hasClosures) cols.push(['Turned back', a => intFmt(a.m.turnedBack)]);
    if (wentRound) cols.push(['Went round', a => intFmt(a.m.avoided)]);
    if (P.type === 'vip') cols.push(['Worst convoy delay', a => dur(a.m.vipDelay)]);
    cols.push(['Coordination', a => (a.plan ? `<span class="effort" title="how much coordination it needs">${'●'.repeat(a.effort)}<i>${'●'.repeat(3 - a.effort)}</i></span>` : '—')]);
    $('#wi-opts-h').innerHTML = `<tr><th>Option</th>${cols.map(c => `<th class="num">${c[0]}</th>`).join('')}</tr>`;
    $('#wi-opts').innerHTML = P.arms.map(a => {
      const tag = a === rec ? '<span class="tagp rec">recommended</span>' : a === best ? '<span class="tagp ref">best score</span>'
        : a.baseline ? '<span class="tagp base">baseline</span>' : !a.plan ? '<span class="tagp ref">reference</span>' : '';
      return `<tr class="${a === rec ? 'rec' : ''}"><td><b>${a.name}${tag}</b><span class="sub2">${a.desc}</span></td>`
        + cols.map(c => `<td class="num">${c[1](a)}</td>`).join('') + '</tr>';
    }).join('');

    // timeline + routes
    $('#wi-steps').innerHTML = actions.map(x => `<li><time>${x.when}</time><span>${x.what}</span></li>`).join('');
    let rh = '';
    if (P.type === 'vip') {
      const sig = P.vip.junctions.length ? `green wave at ${P.vip.junctions.join(', ')}` : 'right of way at every merge';
      rh += `<div class="wi-route vip"><b>VIP convoys</b><span>${P.vip.route}</span><small>${P.vip.times.map(hhmm).join(', ')}`
        + `${rec.key === 'lane' ? ' · in the reserved median lane' : rec.key === 'rolling' ? ' · road held 4 min before to 6 min after' : ' · VIP direction closed to the public'} · ${sig}</small></div>`;
    }
    if (routes.length) {
      const hold = rec.key === 'rolling' ? ' · only during each 10-min hold' : '';
      rh += routes.slice(0, 5).map(r => (r.noWay
        ? `<div class="wi-route noway"><b>${r.from} → ${r.to}</b><span>No way through on the mapped roads</span><small>signed to go round the area before reaching it${hold}</small></div>`
        : `<div class="wi-route"><b>${r.from} → ${r.to}</b><span>via ${r.via}</span><small>usual road closed${r.extra ? `; ${r.extra}` : ''}${hold}</small></div>`)).join('');
      if (routes.length > 5) rh += `<p class="wi-empty">…and ${routes.length - 5} smaller flows${P.schematic ? ', all sent the other way round the loop' : ''}.</p>`;
    } else {
      rh += `<p class="wi-empty">${P.type === 'vip'
        ? 'No diversions for the public: everyone keeps their usual route on the open lanes. Only the median lane is reserved.'
        : 'No closures. With designated parking the kerb lanes stay open for through traffic, and leaving attendees use their usual routes.'}</p>`;
    }
    $('#wi-routes-h').textContent = P.type === 'vip' ? 'VIP route and public diversions' : P.type === 'protest' ? 'Public diversions' : 'Routes';
    $('#wi-routes').innerHTML = rh;

    // disturbance
    const D = P.dist;
    $('#wi-dist-out').hidden = !D;
    if (D) {
      const c = D.corrected, u = D.uncorrected;
      $('#wi-dist-h').textContent = `Disturbance test: a crash blocks ${D.name} at ${clock(D.at)}`;
      const step = (cls, t, text) => `<li><span class="dot ${cls}"></span><time>${t}</time><span>${text}</span></li>`;
      $('#wi-flow').innerHTML = [
        step('bad', clock(D.at), `Crash blocks every lane of ${D.name}, the busiest open road under the plan.`),
        step('', clock(D.at), 'Captured within a minute: the edge camera sees the stopped traffic and logs it as a deviation from the plan.'),
        step('', clock(D.at), 'Corrected: tow dispatched; VMS, navigation and signal timings rebalance around the queue.'),
        step('ok', clock(c.clearedT), 'Carriageway cleared.'),
        step('ok', c.recoverT ? clock(c.recoverT) : '—', c.recoverT ? `Queues back on plan (they peaked ${intFmt(c.peak)} vehicles above it).`
          : `Queues still above plan at the end of the window (peak ${intFmt(c.peak)} over).`),
      ].join('');
      $('#wi-dist-note').innerHTML = `<b>Without the correction</b>, a patrol finds the crash and it is cleared at ${clock(u.clearedT)}. Queues peak ${intFmt(u.peak)} vehicles above plan`
        + `${u.recoverT ? ` and are back on plan at ${clock(u.recoverT)}` : ' and do not get back on plan within the window'}. `
        + `95th-percentile trip: ${dur(c.m.p95)} corrected, ${dur(u.m.p95)} uncorrected, ${dur(rec.m.p95)} if nothing had happened.`;
    }
    drawCharts(res);
    drawMap(res);
  }

  function drawCharts(res) {
    const th = window.SAARTHI_THEME;
    if (!th || !res) return;
    const { P, reco } = res;
    const today = P.arms.find(a => a.baseline), live = P.arms.find(a => a.key === 'live');
    const series = [{ name: 'Today', color: th.fixed, points: today.m.series }];
    if (live) series.push({ name: 'No notice', long: 'SAARTHI, not told in advance', color: th.muted, dash: true, points: live.m.series });
    series.push({ name: 'Plan', long: `Recommended: ${reco.rec.short}`, color: th.smart, points: reco.rec.m.series });
    const leg = (color, name, dash) => `<span><i style="background:${dash ? `repeating-linear-gradient(90deg, ${color} 0 5px, transparent 5px 8px)` : color}"></i>${name}</span>`;
    $('#wi-legend').innerHTML = series.map(s => leg(s.color, s.long || s.name, s.dash)).join('');
    chart.theme = th;
    chart.band = { from: (P.type === 'event' ? P.input.start : P.start) * 3600, to: P.end * 3600,
      label: P.type === 'protest' ? 'closure' : P.type === 'vip' ? 'VIP window' : 'event' };
    chart.setData(series);
    if (P.dist) {
      const D = P.dist;
      const ds = [
        { name: 'No crash', long: 'Plan, no crash', color: th.muted, dash: true, points: D.expected },
        { name: 'Corrected', long: 'Crash, SAARTHI corrects it', color: th.smart, points: D.corrected.m.series },
        { name: 'Uncorrected', long: 'Crash, found by patrol', color: th.fixed, points: D.uncorrected.m.series },
      ];
      $('#wi-dlegend').innerHTML = ds.map(s => leg(s.color, s.long, s.dash)).join('');
      dchart.theme = th;
      dchart.band = { from: D.at, to: D.uncorrected.clearedT, label: 'crash' };
      dchart.setData(ds);
    }
  }

  function watch(res) {
    const { P, reco } = res;
    const today = P.arms.find(a => a.baseline);
    const inc = P.incident ? { incidents: [P.incident] } : {};
    window.SAARTHI_LAB.loadScenario({
      label: P.title,
      area: P.area,
      startHour: (P.type === 'event' ? P.end : P.start) - 0.25,
      fixed: Object.assign({}, today.scenario, inc),
      smart: Object.assign({}, reco.rec.scenario, inc),
      seed: 7,
    });
    document.getElementById('twin').scrollIntoView({ behavior: 'smooth' });
  }

  const redraw = () => { if (last) setTimeout(() => drawCharts(last), 0); };
  const redrawMap = () => drawMap(last && sameInputs(last) ? last : null);
  document.addEventListener('themechange', redraw);
  document.addEventListener('themechange', () => setTimeout(redrawMap, 0)); // dark / light street tiles
  document.addEventListener('basemapchange', redrawMap);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', redraw);
  window.addEventListener('resize', () => { if (last) { chart.draw(); dchart.draw(); } });

  renderFields();
  drawMap(null);
  // ?whatif=protest|vip|event runs that scenario on load; &crash=1 adds the disturbance; &wiarea=fco|cp|s62|fc picks the area
  const qs = new URLSearchParams(location.search), qType = qs.get('whatif'), qArea = qs.get('wiarea');
  if (AREA_IDS.includes(qArea)) { st.area = qArea; areaSel.value = qArea; renderFields(); drawMap(null); }
  if (W.TYPES[qType]) {
    $(`#wi-type button[data-v="${qType}"]`).click();
    $('#wi-dist').checked = qs.get('crash') === '1';
    setTimeout(() => $('#wi-run').click(), 1500);
  }
})();
