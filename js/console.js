/* Control console: the traffic controller's workspace on one live SAARTHI twin of a real area.
 *
 * The controller logs an incident (road closure, crash, ambulance, event crowd). SAARTHI drafts an advisory:
 * who it reaches (drivers in the twin whose route crosses the affected roads), the way round for each
 * direction of travel, and an editable message. Nothing changes for drivers until the controller sends it:
 * before that a closed road is found at the barricade; after it, drivers who get the advice and follow it
 * (VMS_COMPLY, 70%) route round. Each incident card reports what the advisory actually did in the twin.
 * It is the website's control console section (04), next to the Fixed vs SAARTHI live twin (03). It runs only while on screen. */
(function () {
  'use strict';
  const S = window.SAARTHI, PL = window.SAARTHI_PLANNER, BM = window.SAARTHI_BASEMAP;
  const $ = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const clock = t => S.fmtClock(t).slice(0, 5);

  const NETS = Object.values(window.SAARTHI_NETWORKS || {});
  const qs = new URLSearchParams(location.search);
  const state = {
    area: NETS.some(n => n.id === qs.get('area')) ? qs.get('area') : 'fco',
    type: 'closure',
    visible: false,      // on screen (it only runs then)
    pick: null,          // { mode: 'many' | 'one', ids: [] } while choosing roads on the map
    draft: null,         // incident whose advisory is open
    showRoute: null,     // link ids of the way round shown on the map
    tab: 'live',         // 'live' | 'plan'
  };
  let sim = null, incidents = [], nextInc = 1;

  // ------------------------------------------------------------------ map
  const cv = $('#c-cv'), host = cv.parentElement;
  const R = new window.Renderer(cv);
  R.selected = null;
  R.colorBy = 'speed';

  function readTheme() {
    const cs = getComputedStyle(document.documentElement), v = n => cs.getPropertyValue(n).trim();
    R.theme = window.SAARTHI_THEME = {
      ground: v('--map-ground'), block: v('--map-block'), blockText: v('--map-block-text'), road: v('--map-road'),
      median: v('--map-median'), lane: v('--map-lane'), kerb: v('--map-kerb'), parked: v('--map-parked'),
      label: v('--map-label'), label2: v('--map-label-2'), accent: v('--accent'),
      green: v('--status-good'), amber: v('--status-warn'), red: v('--status-crit'),
      types: { car: v('--t-car'), tw: v('--t-tw'), auto: v('--t-auto'), erick: v('--t-erick'), bus: v('--t-bus'), truck: v('--t-truck') },
      surface: v('--surface'), ink2: v('--ink-2'), muted: v('--muted'), grid: v('--grid'), axis: v('--axis'),
      fixed: v('--series-fixed'), smart: v('--series-smart'), vip: v('--vip'),
    };
  }
  readTheme();
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', readTheme);
  document.addEventListener('themechange', readTheme);
  new ResizeObserver(() => R.resize()).observe(host);

  $('#c-map').value = BM.mode;
  $('#c-map').addEventListener('change', e => { BM.mode = e.target.value; });

  // Map controls: drag to pan, wheel to zoom, buttons.
  let down = null;
  // Choosing roads to close is drawn freehand: drag along the roads (Draw) or over chosen ones (Erase).
  // "Move map" (or the crash's single pick) leaves dragging to pan.
  const drawing = () => !!state.pick && state.pick.mode === 'many' && state.pick.tool !== 'pan' && !!sim;
  let stroke = null;
  cv.addEventListener('pointerdown', e => {
    down = { x: e.clientX, y: e.clientY, moved: false };
    cv.setPointerCapture(e.pointerId);
    if (drawing()) { stroke = { pts: [R.toWorld(e.clientX, e.clientY)], added: [], removed: [], last: null, cx: e.clientX, cy: e.clientY }; paintAt(e.clientX, e.clientY); }
  });
  cv.addEventListener('pointermove', e => {
    if (!down) return;
    if (stroke) { // sample the pen path every few pixels so a quick stroke doesn't skip a road
      const dx = e.clientX - stroke.cx, dy = e.clientY - stroke.cy, n = Math.ceil(Math.hypot(dx, dy) / 6);
      for (let i = 1; i <= n; i++) paintAt(stroke.cx + dx * i / n, stroke.cy + dy * i / n);
      stroke.cx = e.clientX; stroke.cy = e.clientY;
      stroke.pts.push(R.toWorld(e.clientX, e.clientY));
      down.moved = true;
      return;
    }
    const dx = e.clientX - down.x, dy = e.clientY - down.y;
    if (!down.moved && Math.hypot(dx, dy) < 4) return;
    down.moved = true;
    if (R.view.z > 1) { R.pan(dx, dy); down.x = e.clientX; down.y = e.clientY; }
  });
  const endStroke = () => {
    if (stroke && (stroke.added.length || stroke.removed.length)) state.pick.history.push({ added: stroke.added, removed: stroke.removed });
    const had = !!stroke; stroke = null; down = null;
    if (had) updateChosen();
  };
  cv.addEventListener('pointerup', e => {
    if (!stroke && down && !down.moved && state.pick && (state.pick.mode === 'one' || state.pick.mode === 'point')) pickAt(e.clientX, e.clientY);
    endStroke();
  });
  cv.addEventListener('pointercancel', endStroke);

  // Links that join `a` to `b` within a few short hops, either way round (a stroke that skipped the short
  // links inside a junction, or crossed to the other carriageway, is joined up).
  function bridge(a, b) {
    const hop = (from, to) => {
      const prev = new Map([[from.id, null]]), q = [[from, 0, 0]];
      while (q.length) {
        const [L, d, len] = q.shift();
        for (const M of sim.moves[L.id] || []) {
          if (prev.has(M.id) || M.kind === 'exit') continue;
          prev.set(M.id, L.id);
          if (M === to) { const out = []; for (let id = prev.get(M.id); id && id !== from.id; id = prev.get(id)) out.push(id); return out; }
          if (d < 4 && len + M.length < 250) q.push([M, d + 1, len + M.length]);
        }
      }
      return null;
    };
    return hop(a, b) || hop(b, a) || [];
  }

  function paintAt(cx, cy) {
    const L = linkAt(cx, cy, 12);
    const p = state.pick;
    if (!L) return;
    if (p.tool === 'erase') {
      if (p.ids.includes(L.id)) { p.ids = p.ids.filter(id => id !== L.id); stroke.removed.push(L.id); updateChosen(); }
      return;
    }
    if (stroke.last && stroke.last !== L && !p.ids.includes(L.id)) {
      for (const id of bridge(stroke.last, L)) if (!p.ids.includes(id)) { p.ids.push(id); stroke.added.push(id); }
    }
    if (!p.ids.includes(L.id)) { p.ids.push(L.id); stroke.added.push(L.id); updateChosen(); }
    stroke.last = L;
  }

  function undoStroke() {
    const p = state.pick, h = p && p.history.pop();
    if (!h) return;
    p.ids = p.ids.filter(id => !h.added.includes(id)).concat(h.removed.filter(id => !p.ids.includes(id)));
    updateChosen();
  }
  cv.addEventListener('wheel', e => {
    if (!(e.ctrlKey || e.metaKey)) return; // plain scrolling keeps scrolling the page
    e.preventDefault(); R.zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.002)); }, { passive: false });
  const ctl = document.createElement('div');
  ctl.className = 'map-ctl';
  ctl.innerHTML = '<button type="button" data-z="in" title="Zoom in">+</button><button type="button" data-z="out" title="Zoom out">−</button>'
    + '<button type="button" data-z="fit" title="Show the whole area">⌂</button>';
  cv.addEventListener('dblclick', e => { R.zoomAt(e.clientX, e.clientY, R.view.z >= 8 ? 1 / 64 : 2); });
  ctl.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    const rc = cv.getBoundingClientRect();
    if (b.dataset.z === 'fit') R.resetView();
    else R.zoomAt(rc.left + rc.width / 2, rc.top + rc.height / 2, b.dataset.z === 'in' ? 1.6 : 1 / 1.6);
  });
  host.appendChild(ctl);

  // Nearest drivable road to a click (not the stubs at the map's edge).
  function linkAt(clientX, clientY, radiusPx) {
    const [x, y] = R.toWorld(clientX, clientY);
    let best = null, bd = radiusPx ? Math.max(4, radiusPx / R.scale) : Math.max(25, 14 / R.scale);
    for (const L of sim.linkList) {
      if (L.kind === 'entry' || L.kind === 'exit') continue;
      const off = L.base + L.lanes * L.lw / 2;
      for (let s = 0; s <= L.length; s += Math.max(4, L.length / 40)) {
        const f = S.frameAt(L, s), px = f[0] + f[3] * off, py = f[1] - f[2] * off;
        const d = Math.hypot(px - x, py - y);
        if (d < bd) { bd = d; best = L; }
      }
    }
    return best;
  }
  const reverseOf = L => sim.linkList.find(M => M.from === L.to && M.to === L.from && M.kind === L.kind);

  function pickAt(cx, cy) {
    const p = state.pick;
    if (p.mode === 'point') { // a place: an event venue, or where an ambulance sets off
      const [x, y] = R.toWorld(cx, cy), L = linkAt(cx, cy, 40);
      if (p.purpose === 'venue') { p.pt = [x, y]; p.venue = PL.venueAt(sim, x, y); updateVenue(); }
      else if (L) { p.pt = [x, y]; p.ids = [L.id]; updateAmbRoute(); }
      return;
    }
    const L = linkAt(cx, cy);
    if (!L) return;
    p.ids = [L.id];
    updateChosen();
  }

  // Road overlays the console adds: roads being picked, unsent incidents, the way round on show.
  function strokeLinks(ids, color, wPx, dash) {
    const ctx = R.ctx, px = 1 / R.scale;
    ctx.strokeStyle = color; ctx.lineWidth = wPx * px; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.setLineDash(dash ? dash.map(d => d * px) : []);
    for (const id of ids) {
      const L = sim.links[id];
      if (!L) continue;
      const lane = (L.lanes - 1) / 2;
      ctx.beginPath();
      for (let s = 0, k = 0; ; s += Math.max(3, L.length / 30), k++) {
        const [x, y] = S.lanePoint(L, lane, Math.min(s, L.length));
        if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        if (s >= L.length) break;
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }
  // The suggested way round: blue (green is the ambulance's corridor lane), with arrows for the direction
  // of travel and a label at its middle.
  const WAY = '#1d9bf0';
  function drawWayRound(ids) {
    const ctx = R.ctx, px = 1 / R.scale;
    strokeLinks(ids, 'rgba(0,0,0,0.55)', 9);
    strokeLinks(ids, WAY, 5);
    ctx.fillStyle = '#ffffff';
    const step = Math.max(60, 110 * px); // an arrow every ~110 screen px, never closer than 60 m
    let run = 0;
    for (const id of ids) {
      const L = sim.links[id];
      if (!L) continue;
      for (let s = (step - run % step) % step; s < L.length; s += step) {
        const [x, y] = S.lanePoint(L, (L.lanes - 1) / 2, s), f = S.frameAt(L, s), a = 3.2 * px;
        ctx.beginPath(); // chevron pointing the way to drive
        ctx.moveTo(x + f[2] * a, y + f[3] * a);
        ctx.lineTo(x - f[2] * a - f[3] * a, y - f[3] * a + f[2] * a);
        ctx.lineTo(x - f[2] * a * 0.4, y - f[3] * a * 0.4);
        ctx.lineTo(x - f[2] * a + f[3] * a, y - f[3] * a - f[2] * a);
        ctx.closePath(); ctx.fill();
      }
      run += L.length;
    }
    const mid = sim.links[ids[Math.floor(ids.length / 2)]];
    if (mid) { const [x, y] = S.lanePoint(mid, 0, mid.length / 2); R.pill('Way round', x, y - 14 * px, '#ffffff', WAY, 'center'); }
  }

  function drawMarks() {
    if (!R.scale) return;
    R.world();
    if (state.showRoute) drawWayRound(state.showRoute);
    for (const inc of incidents) if (!inc.done && !inc.sent && inc.ids.length && inc.type !== 'ambulance') strokeLinks(inc.ids, R.theme.amber, 5, [6, 5]);
    const p = state.pick;
    for (const inc of incidents) { // an ambulance on its way: its route in solid red until it arrives
      if (inc.type !== 'ambulance' || inc.done) continue;
      strokeLinks(inc.ids, 'rgba(0,0,0,0.45)', 7);
      strokeLinks(inc.ids, R.theme.red, 3.5);
      const Ln = sim.links[inc.ids[inc.ids.length - 1]];
      if (Ln) { const [bx, by] = S.lanePoint(Ln, 0, Ln.length); R.pill(inc.hospital, bx, by - 14 / R.scale, '#fff', R.theme.red, 'center'); }
    }
    for (const { p } of sim.pendingSuggestions()) { // a light SAARTHI suggests turning green: amber ring until answered
      const j = sim.nodes[p.j], ctx = R.ctx, pulse = 0.55 + 0.45 * Math.sin(performance.now() / 200);
      ctx.strokeStyle = R.theme.amber; ctx.globalAlpha = pulse; ctx.lineWidth = 4 / R.scale; ctx.setLineDash([]);
      ctx.beginPath(); ctx.arc(j.x, j.y, Math.max(j.r + 10, 16 / R.scale), 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 1;
      R.pill('turn green?', j.x, j.y - Math.max(j.r + 14, 22 / R.scale), '#000', R.theme.amber, 'center');
    }
    if (state.ambPreview && state.ambShow) {
      strokeLinks(state.ambPreview, 'rgba(0,0,0,0.5)', 8);
      strokeLinks(state.ambPreview, R.theme.red, 4, [8, 6]);
      const L0 = sim.links[state.ambPreview[0]], Ln = sim.links[state.ambPreview[state.ambPreview.length - 1]];
      const [ax, ay] = S.lanePoint(L0, 0, Math.min(20, L0.length / 2)), [bx, by] = S.lanePoint(Ln, 0, Ln.length);
      R.pill('Ambulance starts', ax, ay - 14 / R.scale, '#fff', R.theme.red, 'center');
      R.pill(state.ambTo || 'Hospital', bx, by - 14 / R.scale, '#fff', R.theme.red, 'center');
    }
    if (p && p.mode === 'point' && p.pt) {
      const ctx = R.ctx, [x, y] = p.pt;
      ctx.fillStyle = R.theme.accent; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2 / R.scale;
      ctx.beginPath(); ctx.arc(x, y, 7 / R.scale, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      if (p.purpose === 'venue') {
        if (p.venue) strokeLinks(p.venue.links, R.theme.accent, 6);
        R.pill('Event venue', x, y - 16 / R.scale, '#fff', R.theme.accent, 'center');
      }
    } else if (p) strokeLinks(p.ids, R.theme.accent, 7);
    if (stroke && stroke.pts.length > 1) { // the pen trail while drawing
      const ctx = R.ctx;
      ctx.strokeStyle = state.pick.tool === 'erase' ? R.theme.red : R.theme.accent;
      ctx.globalAlpha = 0.35; ctx.lineWidth = 14 / R.scale; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.setLineDash([]);
      ctx.beginPath(); stroke.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  // ------------------------------------------------------------------ twin
  const sel = $('#c-area');
  sel.innerHTML = NETS.map(n => `<option value="${n.id}">${esc(n.short || n.name)}</option>`).join('');
  sel.value = state.area;
  sel.addEventListener('change', () => { state.area = sel.value; build(); syncPlanArea(); });
  // The Plan ahead tab plans for the area open in the console.
  function syncPlanArea() {
    const w = $('#wi-area');
    if (w && w.value !== state.area && [...w.options].some(o => o.value === state.area)) { w.value = state.area; w.dispatchEvent(new Event('change')); }
  }

  // ------------------------------------------------------------------ tabs
  function setTab(v) {
    state.tab = v;
    $('#c-tabs').querySelectorAll('button').forEach(b => { b.classList.toggle('on', b.dataset.v === v); b.setAttribute('aria-selected', String(b.dataset.v === v)); });
    $('#console-app .cmain').hidden = v !== 'live';
    $('#c-plan').hidden = v !== 'plan';
    if (v === 'live') requestAnimationFrame(() => R.resize());
  }
  $('#c-tabs').addEventListener('click', e => { const b = e.target.closest('button[data-v]'); if (b) setTab(b.dataset.v); });
  // The controller works in real time: the twin runs on the wall clock (this computer's local time).
  // There is no live detector feed yet, so the traffic in it is typical traffic for this time of day.
  const wallT = () => { const d = new Date(); return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds() + d.getMilliseconds() / 1000; };
  let dayOffset = 0; // past midnight the wall clock wraps; the twin's clock keeps counting

  function build() {
    sim = null; R.sim = null;
    incidents = []; state.draft = null; state.pick = null; state.showRoute = null; state.ambPreview = null; state.ambChoice = null;
    $('#c-load').textContent = 'loading the area…';
    $('#p-draft').hidden = true;
    renderList(); renderForm();
    setTimeout(() => { // let the "loading" text paint: a real area takes a few seconds to warm up
      sim = new S.Sim({ mode: 'adaptive', seed: 7, startHour: wallT() / 3600, warmup: true, network: state.area, controllerMarshals: true, priorityApproval: true });
      sim.autoApprove = !!state.autoAmb;
      camAlerts.clear();
      dayOffset = 0; nextStatus = -Infinity;
      R.sim = sim; R.resetView(); R.resize();
      $('#c-load').textContent = '';
      for (const it of scheduled) if (it.area === state.area && !it.cancelled) applyPlan(it); // a rebuilt twin keeps its plans
      renderSched();
      renderForm();
    }, 30);
  }

  // Drivers in the twin whose remaining route crosses any of `ids` (on the roads, in junctions, queued at the edge).
  function heading(ids) {
    const set = new Set(ids);
    let n = 0;
    const test = v => { if (v.isEV) return; for (let k = v.ri; k < v.route.length; k++) if (set.has(v.route[k])) { n++; return; } };
    for (const L of sim.linkList) for (const arr of L.lane) arr.forEach(test);
    for (const j of sim.isects) j.box.forEach(test);
    for (const x of sim.externals) x.backlog.forEach(test);
    for (const s of sim.sources) s.backlog.forEach(test);
    return n;
  }

  // ------------------------------------------------------------------ new incident form
  $$('.ctypes button').forEach(b => b.addEventListener('click', () => {
    state.type = b.dataset.type; state.ambPreview = null;
    state.pick = null;
    $$('.ctypes button').forEach(x => x.classList.toggle('on', x === b));
    renderForm();
  }));

  const opt = (v, label, on) => `<option value="${v}"${on ? ' selected' : ''}>${esc(label)}</option>`;
  const area = () => PL.AREAS[state.area] || {};

  function roadsChosen() {
    const ids = state.pick ? state.pick.ids : [];
    if (!ids.length) return `<span class="muted">No road chosen yet. ${state.pick && state.pick.mode === 'one' ? 'Click the road on the map.' : 'Draw along a road on the map.'}</span>`;
    const names = PL.roadNames(sim, ids);
    return `${esc(names.join(', ') || 'unnamed road')} <span class="muted">(${ids.length} section${ids.length > 1 ? 's' : ''})</span>`;
  }

  function renderForm() {
    const f = $('#f-new');
    fillForm(f);
    updateHint();
  }

  function updateHint() {
    const hint = $('#c-pick'), p = state.pick, tool = p && (p.mode === 'many' ? p.tool : p.mode === 'point' ? p.purpose : 'one');
    host.classList.toggle('picking', !!tool && tool !== 'pan' && tool !== 'erase');
    host.classList.toggle('erasing', tool === 'erase');
    hint.hidden = !p || tool === 'pan';
    hint.textContent = tool === 'one' ? 'Click the road where the crash is'
      : tool === 'venue' ? 'Click where the event is'
      : tool === 'amb' ? 'Click where the ambulance sets off'
      : tool === 'erase' ? 'Drag over chosen roads to remove them'
      : 'Draw along the roads to close: press and drag';
  }

  // Refresh just the chosen-roads line (re-rendering the form would reset the other fields).
  function updateChosen() {
    const el = $('#f-new .sel-roads');
    if (el) el.innerHTML = roadsChosen();
    const u = $('#f-new [data-act="undo"]');
    if (u) u.disabled = !state.pick || !state.pick.history.length;
  }

  function fillForm(f) {
    if (!sim) { f.innerHTML = '<p class="fnote">Loading the area…</p>'; return; }
    const A = area(), t = state.type;
    if (t === 'closure') {
      if (!state.pick || state.pick.mode !== 'many') state.pick = { mode: 'many', ids: [], tool: 'draw', history: [] };
      f.innerHTML = `
        <label>Known site<select name="site">${opt('', 'Choose a site, or draw the roads on the map', true)}${(A.protest || []).map(p => opt(p.key, p.name)).join('')}</select></label>
        <div class="ptools">
          <div class="pseg" role="group" aria-label="Map tool">
            ${[['draw', '✎ Draw'], ['erase', 'Erase'], ['pan', 'Move map']].map(([k, l]) => `<button type="button" data-tool="${k}" class="${state.pick.tool === k ? 'on' : ''}">${l}</button>`).join('')}
          </div>
          <button type="button" class="btn btn-sm btn-ghost" data-act="undo"${state.pick.history.length ? '' : ' disabled'}>Undo</button>
          <button type="button" class="btn btn-sm btn-ghost" data-act="clear">Clear</button>
        </div>
        <div class="sel-roads">${roadsChosen()}</div>
        <label class="row" style="display:flex;align-items:center;gap:6px"><input type="checkbox" name="both" checked style="flex:none"> Close both directions</label>
        <div class="row">
          <label>Reason<select name="reason">${['Protest', 'Procession', 'Road works', 'VIP movement', 'Waterlogging', 'Other'].map(r => opt(r, r)).join('')}</select></label>
          <label>For<select name="mins">${[30, 60, 90, 120, 180].map(m => opt(m, `${m} min`, m === 60)).join('')}</select></label>
        </div>
        <button class="btn btn-primary btn-sm" type="submit">Close the road now</button>`;
      f.site.addEventListener('change', () => {
        const p = (A.protest || []).find(q => q.key === f.site.value), pk = state.pick;
        const ids = p ? PL.siteLinks(sim, p) : [];
        pk.history.push({ added: ids.filter(id => !pk.ids.includes(id)), removed: pk.ids.filter(id => !ids.includes(id)) });
        pk.ids = ids;
        updateChosen();
      });
      f.querySelectorAll('[data-tool]').forEach(b => b.addEventListener('click', () => {
        state.pick.tool = b.dataset.tool;
        f.querySelectorAll('[data-tool]').forEach(x => x.classList.toggle('on', x === b));
        updateHint();
      }));
      f.querySelector('[data-act="undo"]').addEventListener('click', undoStroke);
      f.querySelector('[data-act="clear"]').addEventListener('click', () => {
        const pk = state.pick;
        if (pk.ids.length) pk.history.push({ added: [], removed: pk.ids.slice() });
        pk.ids = []; f.site.value = '';
        updateChosen();
      });
    } else if (t === 'crash') {
      if (!state.pick || state.pick.mode !== 'one') state.pick = { mode: 'one', ids: [], history: [] };
      f.innerHTML = `
        <div class="sel-roads">${roadsChosen()}</div>
        <div class="row">
          <label>Blocking<select name="lanes">${opt('1', 'one lane')}${opt('all', 'all lanes')}</select></label>
          <label>Expected to clear in<select name="mins">${[15, 30, 45, 60].map(m => opt(m, `${m} min`, m === 30)).join('')}</select></label>
        </div>
        <button class="btn btn-primary btn-sm" type="submit">Log the crash</button>`;
    } else if (t === 'ambulance') {
      state.pick = null;
      const a = sim.hooks.ambulance, starts = edges(), hs = hospitals();
      const ch = state.ambChoice || (state.ambChoice = { from: a.origin, to: a.hospital, pick: null }); // kept after a dispatch
      if (!hs.some(h => h.text === ch.to) && hs.length) ch.to = hs[0].text;
      // only the edges with a way to the chosen hospital on the mapped roads
      const fromOpts = () => {
        const ok = starts.filter(x => x.reaches.has(ch.to));
        if (ch.from !== 'map' && !ok.some(x => x.id === ch.from)) ch.from = ok.length ? ok[0].id : 'map';
        return ok.map(x => opt(x.id, x.name, x.id === ch.from)).join('') + opt('map', 'A point on the map (click it)', ch.from === 'map');
      };
      f.innerHTML = `
        <label>Going to<select name="to">${hs.map(h => opt(h.text, h.text, h.text === ch.to)).join('')}</select></label>
        <label>Sets off from<select name="from">${fromOpts()}</select></label>
        <div class="sel-roads" id="amb-route"></div>
        <p class="fnote">As it gets close to each signal, SAARTHI suggests turning that light green and you press the button (or tick automatic in its card). A green corridor is set up along its whole route: the median lane is cleared for it (the built lane where there is one), and each road opens again once it has passed. Single-lane roads cannot be cleared.</p>
        <button class="btn btn-primary btn-sm" type="submit">Dispatch ambulance</button>`;
      const onFrom = () => {
        ch.from = f.from.value;
        if (ch.from === 'map') state.pick = ch.pick || (ch.pick = { mode: 'point', purpose: 'amb', ids: [], pt: null, history: [] });
        else state.pick = null;
        updateHint(); updateAmbRoute();
      };
      f.from.addEventListener('change', onFrom);
      f.to.addEventListener('change', () => { ch.to = f.to.value; f.from.innerHTML = fromOpts(); onFrom(); });
      onFrom();
    } else {
      state.pick = { mode: 'point', purpose: 'venue', ids: [], pt: null, venue: null, history: [] };
      f.innerHTML = `
        <label>Venue<select name="venue">${opt('map', 'Click the venue on the map', true)}${A.venue ? opt('preset', A.venue.name) : ''}</select></label>
        <div class="sel-roads" id="ev-venue"></div>
        <label>Event<input name="name" maxlength="60" placeholder="e.g. Concert at Worlds of Wonder"></label>
        <div class="row">
          <label>Crowd leaving<select name="rate">${[[400, 'small (~400 vehicles/h)'], [800, 'large (~800 vehicles/h)'], [1200, 'very large (~1,200 vehicles/h)']].map(([v, l]) => opt(v, l, v === 800)).join('')}</select></label>
          <label>For<select name="mins">${[30, 60, 90].map(m => opt(m, `${m} min`, m === 60)).join('')}</select></label>
        </div>
        <button class="btn btn-primary btn-sm" type="submit">Crowd is leaving now</button>`;
      f.venue.addEventListener('change', () => {
        const pk = state.pick;
        if (f.venue.value === 'preset') { pk.venue = PL.venueOf(sim, A); pk.pt = [pk.venue.x, pk.venue.y]; pk.preset = A.venue.name; }
        else { pk.venue = null; pk.pt = null; pk.preset = null; }
        updateVenue();
      });
      updateVenue();
    }
  }

  // Ambulance: map edges it can come in by, and the hospitals on the map.
  // Only edges with a way to a hospital on the mapped roads (some side roads are cut off at the map edge
  // and only lead off the map again). Unnamed side roads are named by the first named road they lead to.
  let edgeCache = null;
  function edges() {
    if (edgeCache && edgeCache.sim === sim) return edgeCache.list;
    const hs = hospitals(), list = [];
    for (const x of sim.externals.filter(e => e.entry)) {
      const ok = hs.filter(h => PL.routeToPoint(sim, x.entry.id, h.x, h.y));
      if (!ok.length) continue;
      let name = x.name;
      const m = /^(Motorway|Trunk|Primary|Secondary|Tertiary) road \((\w+)\)$/.exec(name);
      if (m) {
        const r = PL.routeToPoint(sim, x.entry.id, ok[0].x, ok[0].y), road = r && PL.roadNames(sim, r)[0];
        name = road ? `Side road to ${road} (${m[2]})` : `Side road (${m[2]})`;
      }
      list.push({ id: x.id, name, entry: x.entry, reaches: new Set(ok.map(h => h.text)) });
    }
    list.sort((p, q) => p.name.localeCompare(q.name));
    const count = {};
    for (const e of list) count[e.name] = (count[e.name] || 0) + 1;
    const k = {};
    for (const e of list) {
      const base = e.name;
      if (count[base] < 2) continue;
      k[base] = (k[base] || 0) + 1;
      e.name = base.replace(/ \((\w+)\)$/, (_, d) => ` ${k[base]} (${d})`);
    }
    edgeCache = { sim, list };
    return list;
  }
  function hospitals() {
    const seen = new Set();
    return (sim.net.labels || []).filter(l => l.kind === 'hospital' && !l.offmap && !seen.has(l.text) && seen.add(l.text));
  }
  function updateAmbRoute() {
    const f = $('#f-new'), out = $('#amb-route');
    if (!out || !f.to) return;
    const quiet = state.ambJustSent; // the form refilled right after a dispatch: don't redraw the old preview
    state.ambJustSent = false;
    const a = sim.hooks.ambulance, h = hospitals().find(q => q.text === f.to.value);
    let from = null, fromName = '';
    if (f.from.value === 'map') { from = state.pick && state.pick.ids[0]; fromName = from ? (PL.roadNames(sim, [from])[0] || 'a point on the map') : ''; }
    else { const x = edges().find(e => e.id === f.from.value); from = x.entry.id; fromName = x.name.replace(/ \((N|S|E|W|NE|NW|SE|SW)\)$/, ''); }
    state.ambPreview = null; state.ambTo = h ? h.text : '';
    if (!h) { out.innerHTML = '<span class="muted">No hospital on this map.</span>'; return; }
    if (!from) { out.innerHTML = '<span class="muted">Click where the ambulance sets off.</span>'; return; }
    const ids = f.from.value === a.origin && h.text === a.hospital && sim.ambRoute ? sim.ambRoute.ids : PL.routeToPoint(sim, from, h.x, h.y);
    if (!ids) { out.innerHTML = '<span class="muted">No way from there to this hospital on the mapped roads.</span>'; return; }
    state.ambPreview = ids; state.ambFrom = fromName;
    state.ambShow = !quiet;
    const km = ids.reduce((s2, id) => s2 + sim.links[id].length, 0) / 1000;
    const gcKm = ids.reduce((s2, id) => s2 + (sim.links[id].gc != null ? sim.links[id].length : 0), 0) / 1000;
    out.innerHTML = `${esc(PL.roadNames(sim, ids).join(' → '))} <span class="muted">(${km.toFixed(1)} km${gcKm > 0.05 ? `, ${gcKm.toFixed(1)} km in the green corridor lane` : ''})</span>`;
  }

  // Event crowd: where it is, and a name for the advisory.
  function updateVenue() {
    const out = $('#ev-venue'), pk = state.pick;
    if (!out) return;
    if (!pk.venue) { out.innerHTML = '<span class="muted">Not placed yet. Click the venue on the map.</span>'; return; }
    out.innerHTML = `Crowd joins ${esc(PL.roadNames(sim, pk.venue.links).join(' and ') || 'the nearest road')}`;
  }
  function venueName(pk) {
    if (pk.preset) return `at ${pk.preset}`;
    const [x, y] = pk.pt;
    const near = (sim.net.labels || []).filter(l => !l.offmap).map(l => ({ l, d: Math.hypot(l.x - x, l.y - y) })).sort((p, q) => p.d - q.d)[0];
    if (near && near.d < 300) return `near ${near.l.text}`;
    return `on ${PL.roadNames(sim, pk.venue.links)[0] || 'the main road'}`;
  }

  $('#f-new').addEventListener('submit', e => {
    e.preventDefault();
    if (!sim) return;
    const f = e.target, t = state.type, now = sim.t;
    let inc = null;
    if (t === 'closure') {
      let ids = state.pick.ids.slice();
      if (!ids.length) return flash('Choose a site or click the roads to close first.');
      if (f.both.checked) for (const id of state.pick.ids) { const M = reverseOf(sim.links[id]); if (M && !ids.includes(M.id)) ids.push(M.id); }
      const mins = +f.mins.value, reason = f.reason.value;
      const site = (area().protest || []).find(p => p.key === f.site.value);
      const where = site ? site.name : PL.roadNames(sim, ids).join(', ');
      const c = { ids, from: now, until: now + mins * 60, label: reason, where, knownAt: Infinity, on: false, detectLogged: true };
      sim.closures.push(c);
      inc = { type: 'closure', title: `${reason}: road closed`, where, ids, closure: c, until: c.until, reason };
    } else if (t === 'crash') {
      const id = state.pick.ids[0];
      if (!id) return flash('Click the road where the crash is first.');
      const L = sim.links[id], mins = +f.mins.value;
      const lanes = f.lanes.value === 'all' ? [...Array(sim.generalLanes(L)).keys()] : [0];
      sim.triggerBlockage(id, 'Crash', lanes, mins);
      const c = { ids: [id], from: now, until: now + mins * 60, label: 'Crash', knownAt: Infinity, on: false, detectLogged: true, soft: true };
      sim.closures.push(c);
      inc = { type: 'crash', title: 'Crash', where: PL.roadNames(sim, [id])[0] || 'unnamed road', ids: [id], closure: c, until: c.until, link: L, lanes: lanes.length === sim.generalLanes(L) ? 'all lanes' : 'one lane' };
    } else if (t === 'ambulance') {
      const ids = state.ambPreview;
      if (!ids) return flash(f.from.value === 'map' ? 'Click where the ambulance sets off first.' : 'No route to that hospital.');
      const label = `${state.ambFrom} → ${state.ambTo}`;
      const ev = sim.dispatchAmbulance(ids, label);
      inc = { type: 'ambulance', title: 'Ambulance', where: label, hospital: state.ambTo, ids: ids.filter(i => !/^X/.test(i.split('>')[0])), ev, until: null };
      state.ambPreview = null; state.ambShow = false; state.ambJustSent = true;
    } else {
      const pk = state.pick, mins = +f.mins.value, rate = +f.rate.value, v = pk.venue, until = now + mins * 60;
      if (!v) return flash('Click the venue on the map first.');
      const name = f.name.value.trim(), place = venueName(pk), where = name ? `${name}, ${place}` : `Event ${place}`;
      for (const id of v.links) sim.addSource(sim.links[id], where, now, until, rate / v.links.length);
      const ids = [...new Set(v.links.concat(v.park))];
      sim.laneRules.push({ ids: v.park, from: now, until, use: 'closed', label: 'Event parking', where: `the roads round ${where}`, on: false });
      const c = { ids, from: now, until, label: 'Event crowd', where, knownAt: Infinity, on: false, detectLogged: true, soft: true };
      sim.closures.push(c);
      inc = { type: 'event', title: 'Event crowd', where, ids, closure: c, until, rate, name, place };
      sim.addLog(`Controller: crowd leaving ${where} (~${rate} vehicles/h) until ${clock(until)}`, 'info');
    }
    Object.assign(inc, { id: nextInc++, at: now, sent: null, done: false });
    incidents.unshift(inc);
    state.pick = null;
    renderForm();
    openDraft(inc);
  });

  // A notice over the map for the controller (e.g. an ambulance arrived); it goes after 8 s or on ×.
  // SAARTHI's suggestion for an ambulance's next signal, over the map, with the controller's buttons. The
  // console runs in real time: an unanswered suggestion stays until the ambulance reaches that signal.
  function askHTML({ ev, p, d }, inCard) {
    return `<div class="c-ask-k">SAARTHI suggests</div>
      <p>Ambulance ${inCard ? 'approaching' : `<b class="ask-d" data-j="${p.j}">${d == null ? 'close to' : `${Math.round(d / 10) * 10} m from`}</b>`} <b>${esc(p.name)}</b>, coming in on ${esc(p.road)}. Turn this light green for it now.${p.inferred ? ' <span class="muted">(inferred signal, to be confirmed by survey)</span>' : ''}</p>
      <div class="acts"><button class="btn btn-primary btn-sm" data-ask="green" data-j="${p.j}" data-ev="${ev.id}">Turn light green</button><button class="btn btn-sm btn-ghost" data-ask="leave" data-j="${p.j}" data-ev="${ev.id}">Leave it</button>${inCard ? '' : `<button class="btn btn-sm btn-ghost" data-ask="show" data-j="${p.j}">Show</button>`}</div>`;
  }
  let askEl = null, lastAsk = '';
  function updateAsk() {
    const pend = sim ? sim.pendingSuggestions() : [];
    const key = pend.map(x => x.ev.id + ':' + x.p.j).join(',');
    if (key === lastAsk) { // same suggestions: just the distance, so a button press is never lost to a redraw
      if (askEl) for (const x of pend) { const b = askEl.querySelector(`.ask-d[data-j="${x.p.j}"]`); if (b) b.textContent = x.d == null ? 'close to' : `${Math.round(x.d / 10) * 10} m from`; }
      return;
    }
    lastAsk = key;
    const html = pend.map(x => `<div class="c-ask">${askHTML(x)}</div>`).join('');
    if (!askEl) { askEl = document.createElement('div'); askEl.className = 'c-asks'; host.appendChild(askEl); askEl.addEventListener('click', onAsk); }
    askEl.innerHTML = html;
  }
  function onAsk(e) {
    const b = e.target.closest('button[data-ask]');
    if (!b || !sim) return;
    const j = sim.nodes[b.dataset.j];
    if (b.dataset.ask === 'show') { showJunction(j); return; }
    const ev = sim.evs.find(v => v.id === +b.dataset.ev);
    if (b.dataset.ask === 'green') sim.changeLight(ev, b.dataset.j); else sim.leaveLight(ev, b.dataset.j);
    updateAsk(); renderList(); renderLog();
  }

  function toast(title, body) {
    const t = document.createElement('div');
    t.className = 'c-toast'; t.setAttribute('role', 'status');
    t.innerHTML = `<div><b>${esc(title)}</b><span>${esc(body)}</span></div><button type="button" aria-label="Dismiss">×</button>`;
    t.querySelector('button').addEventListener('click', () => t.remove());
    host.appendChild(t);
    setTimeout(() => t.remove(), 8000);
  }

  function flash(msg) {
    const p = document.createElement('p');
    p.className = 'fnote'; p.style.color = 'var(--bad-text)'; p.textContent = msg;
    $('#f-new').appendChild(p);
    setTimeout(() => p.remove(), 3000);
  }

  // ------------------------------------------------------------------ advisory draft
  function diversions(inc) {
    if (inc.type === 'ambulance') return [];
    return PL.publicDiversions({ area: state.area }, inc.ids);
  }

  function draftText(inc, rows) {
    const roads = PL.roadNames(sim, inc.ids), main = roads.slice(0, 2).join(' and ') || inc.where;
    // Traveller wording: no compass tags, and the way round without the roads they start and end on.
    const plain = n => n.replace(/ \((N|S|E|W|NE|NW|SE|SW)\)$/, '');
    const via = r => {
      const v = r.via.split(' → ');
      if (v.length > 1 && v[0] === plain(r.from)) v.shift();
      if (v.length > 1 && v[v.length - 1] === plain(r.to)) v.pop();
      return v.join(' → ');
    };
    const ways = rows.slice(0, 2).map(r => (r.noWay ? `From ${plain(r.from)} to ${plain(r.to)}: no way through, avoid the area.`
      : `From ${plain(r.from)} to ${plain(r.to)}: go via ${via(r)}.`)).join('\n');
    const tail = ways ? `\n${ways}` : '';
    if (inc.type === 'closure') {
      return { title: `${main} closed until ${clock(inc.until)}`, body: `${inc.reason}: ${roads.join(', ') || inc.where} closed to traffic until ${clock(inc.until)}.${tail}` };
    }
    if (inc.type === 'crash') {
      return { title: `Crash on ${main}: expect delays`, body: `A crash is blocking ${inc.lanes} on ${main}. Expected to clear by ${clock(inc.until)}. Avoid it if you can.${tail}` };
    }
    if (inc.type === 'event') {
      return { title: inc.name ? `${inc.name}: expect queues ${inc.place}` : `Event traffic ${inc.place}`, body: `${inc.name || 'An event'} ${inc.place}: a crowd is leaving until ${clock(inc.until)}. Expect queues on ${roads.join(', ')}.${tail}` };
    }
    const hosp = inc.hospital || sim.hooks.ambulance.hospital;
    return { title: `Ambulance on ${main}`, body: `An ambulance is heading to ${hosp} along ${roads.join(' → ')}. If you're on this road, keep left and don't stop in junctions.` };
  }

  function openDraft(inc) {
    state.draft = inc;
    const rows = inc.rows || (inc.rows = diversions(inc));
    const txt = draftText(inc, rows);
    $('#p-draft').hidden = false;
    $('#d-for').textContent = `· ${inc.title}, ${inc.where}`;
    $('#d-title').value = txt.title;
    $('#d-body').value = txt.body;
    $('#d-routes').innerHTML = rows.length ? `<table><tbody>${rows.map((r, i) => `<tr data-i="${i}" class="${r.noWay ? 'noway' : ''}"${i >= 3 ? ' hidden' : ''}>
        <td>${esc(r.from)} → ${esc(r.to)}</td><td>${r.noWay ? 'no way through on the main roads' : `via ${esc(r.via)} <span class="muted">(${esc(r.extra)})</span>`}</td></tr>`).join('')}</tbody></table>
        <p class="fnote">Busiest directions first. Click one to show its way round on the map.${rows.length > 3 ? ` <a href="#" id="d-more">Show all ${rows.length}</a>` : ''}</p>`
      : inc.type === 'ambulance' ? '' : '<p class="fnote">No through traffic uses these roads, so there is no way round to suggest.</p>';
    $$('#d-routes tr').forEach(tr => tr.addEventListener('click', () => {
      const r = rows[+tr.dataset.i];
      state.showRoute = r.ids || null;
      $$('#d-routes tr').forEach(x => x.classList.toggle('shown', x === tr && !!r.ids));
    }));
    const more = $('#d-more');
    if (more) more.addEventListener('click', e => { e.preventDefault(); $$('#d-routes tr').forEach(tr => { tr.hidden = false; }); more.remove(); });
    const first = rows.find(r => r.ids);
    state.showRoute = first ? first.ids : null;
    const tr0 = first && $(`#d-routes tr[data-i="${rows.indexOf(first)}"]`);
    if (tr0) tr0.classList.add('shown');
    $('#d-assume').textContent = inc.type === 'ambulance'
      ? 'In the twin this message is informational: drivers\' response to it is not modelled. The ambulance\'s own lane and signal priority are what clear its way.'
      : 'Twin assumptions: every driver heading this way receives the advisory; 7 in 10 follow it. Drivers who know before setting off and have no way through go round outside the mapped area.';
    updatePreview();
    updateDraftReach();
    const side = $('.cside');
    side.scrollTop = $('#p-draft').offsetTop - 4;
  }

  function updateDraftReach() {
    const inc = state.draft;
    if (!inc || !sim) return;
    const n = heading(inc.ids);
    $('#d-reach').innerHTML = `Reaches <b>${n}</b> driver${n === 1 ? '' : 's'} now heading ${inc.type === 'ambulance' ? 'along the ambulance route' : 'for these roads'}`
      + (inc.until ? `, and drivers setting off that way until ${clock(inc.until)}.` : '.');
  }

  function updatePreview() {
    $('#d-preview .notif-t').textContent = $('#d-title').value;
    $('#d-preview .notif-b').textContent = $('#d-body').value;
  }
  $('#d-title').addEventListener('input', updatePreview);
  $('#d-body').addEventListener('input', updatePreview);

  function closeDraft() { state.draft = null; state.showRoute = null; $('#p-draft').hidden = true; renderList(); }

  $('#d-send').addEventListener('click', () => {
    const inc = state.draft;
    if (!inc || !sim) return;
    const n = heading(inc.ids);
    inc.sent = { t: sim.t, n, title: $('#d-title').value.trim(), body: $('#d-body').value.trim(), turnedBack: (inc.closure && inc.closure.turnedBack) || 0 };
    if (inc.closure) inc.closure.knownAt = sim.t; // drivers act on it from now
    sim.addLog(`Advisory sent to ${n} drivers: "${inc.sent.title}"`, 'sent');
    closeDraft();
  });
  $('#d-hold').addEventListener('click', closeDraft);

  // ------------------------------------------------------------------ incident list
  function endIncident(inc) {
    const t = sim.t;
    if (inc.closure) inc.closure.until = Math.min(inc.closure.until, t);
    if (inc.type === 'crash' && inc.link.blockage) inc.link.blockage.until = t;
    if (inc.type === 'event') {
      for (const s of sim.sources) if (s.name === inc.where && s.until > t) s.until = t;
      for (const r of sim.laneRules) if (r.label === 'Event parking' && r.until > t) r.until = t;
    }
    inc.until = t;
    sim.addLog(`Controller: ${inc.title.toLowerCase()} at ${inc.where} cleared`, 'info');
  }

  function cardHTML(inc) {
    const c = inc.closure, rows = [];
    let st = '';
    let sig = '';
    if (inc.type === 'ambulance') {
      const e = inc.ev.evEntry, plan = inc.ev.plan || [];
      st = e && e.tt != null ? `Arrived in ${S.fmtDur(e.tt)} (${S.fmtDur(e.delay)} slower than an empty road)` : 'En route';
      // each signal on its route: what SAARTHI suggested, what the controller did, how it got through
      const how = p => {
        const r = p.rec;
        if (r) return r.how === 'red' ? [`stood ${Math.round(r.wait)} s at red${p.ok === false ? ' (left)' : p.ok == null ? ' (not changed in time)' : ''}`, 'bad']
          : r.how === 'green' ? ['through on green (it was green)', ''] : ['through on green', 'ok'];
        if (p.ok) return [p.auto === 'green' ? 'already green, kept green · ahead' : p.auto ? 'turned green automatically · ahead' : 'turned green by you · ahead', 'ok'];
        if (p.ok === false) return ['left on normal control · ahead', ''];
        if (p.asked != null) return ['SAARTHI suggests turning it green', 'wait'];
        return ['ahead', ''];
      };
      if (plan.length && !inc.done) {
        const pend = sim.pendingSuggestions().filter(x => x.ev === inc.ev);
        sig = pend.map(x => `<div class="c-ask in-card">${askHTML(x, true)}</div>`).join('')
          + `<ol class="sig-list">${plan.map(p => { const [t, k] = how(p); return `<li><span>${esc(p.name)}</span><span class="${k}">${esc(t)}</span></li>`; }).join('')}</ol>`
          + `<label class="sig-auto"><input type="checkbox" data-a="auto"${state.autoAmb ? ' checked' : ''}> Change the lights for ambulances automatically (no asking)</label>`;
      } else if (plan.length) sig = `<ol class="sig-list">${plan.map(p => { const [t, k] = how(p); return `<li><span>${esc(p.name)}</span><span class="${k}">${esc(t)}</span></li>`; }).join('')}</ol>`;
      else if (!inc.done) sig = '<div class="muted">No traffic signals on its route (flyovers, merges and slip roads), so there are no lights to change.</div>';
    } else st = inc.done ? `Cleared at ${clock(inc.until)}` : `Active until ${clock(inc.until)}`;
    if (inc.sent) {
      rows.push(['Advisory', `sent ${clock(inc.sent.t)} to ${inc.sent.n} driver${inc.sent.n === 1 ? '' : 's'} ${inc.type === 'ambulance' ? 'on its route' : 'heading for these roads'}`]);
      if (c) {
        rows.push(['Took the way round', c.followed || 0]);
        if (!c.soft) rows.push(['Went round before setting off', c.wentRound || 0]);
      }
    }
    if (c && !c.soft) {
      const tb = c.turnedBack || 0;
      if (inc.sent) {
        const before = inc.sent.turnedBack, mins = Math.max(1, (inc.sent.t - inc.at) / 60), since = Math.max(1, ((inc.done ? inc.until : sim.t) - inc.sent.t) / 60);
        rows.push(['Turned back before sending', `${before} (${(before / mins).toFixed(1)}/min)`]);
        rows.push(['Turned back since', `${tb - before} (${((tb - before) / since).toFixed(1)}/min)`]);
      } else rows.push(['Turned back at the barricade', tb]);
    }
    if (!inc.done && inc.type !== 'ambulance') rows.push(['Heading for it now', heading(inc.ids)]);
    const unsent = !inc.sent && !inc.done;
    return `<div class="inc-h"><b>${esc(inc.title)}</b><span>${clock(inc.at)}</span></div>
      <div class="muted">${esc(inc.where)}</div>
      <div class="st">${esc(st)}</div>
      ${unsent ? `<div class="st wait">Advisory not sent: ${inc.type === 'closure' ? 'drivers find out at the barricade' : 'drivers find out when they get there'}</div>` : ''}
      ${sig}
      ${rows.length ? `<dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : ''}
      <div class="acts">
        ${unsent ? `<button class="btn btn-sm" data-a="draft" data-id="${inc.id}">Draft advisory</button>` : ''}
        ${!inc.done && inc.type !== 'ambulance' ? `<button class="btn btn-sm btn-ghost" data-a="end" data-id="${inc.id}">Mark cleared</button>` : ''}
      </div>`;
  }

  function renderList() {
    const ol = $('#c-list');
    if (!incidents.length) { ol.innerHTML = '<li class="empty">None logged.</li>'; ol._html = ''; return; }
    const html = incidents.map(inc => `<li class="inc${inc.done ? ' done' : ''}">${cardHTML(inc)}</li>`).join('');
    if (html !== ol._html) { ol.innerHTML = html; ol._html = html; } // only when something changed, so clicks are not lost
  }
  $('#c-list').addEventListener('click', e => {
    if (e.target.closest('button[data-ask]')) { onAsk(e); return; }
    const box = e.target.closest('input[data-a="auto"]');
    if (box) {
      state.autoAmb = sim.autoApprove = box.checked;
      if (box.checked) for (const x of sim.pendingSuggestions()) sim.changeLight(x.ev, x.p.j, true);
      updateAsk(); renderList(); renderLog();
      return;
    }
    const b = e.target.closest('button[data-a]');
    if (!b) return;
    const inc = incidents.find(i => i.id === +b.dataset.id);
    if (b.dataset.a === 'draft') openDraft(inc);
    else { endIncident(inc); renderList(); }
  });

  // ------------------------------------------------------------------ activity log, header
  function renderLog() {
    const items = sim.log.filter(l => l.kind !== 'decision').slice(-40).reverse(); // routine signal decisions are not the controller's business
    $('#c-log').innerHTML = items.map(l => `<li class="${l.kind === 'alert' ? 'alert' : l.kind === 'sent' ? 'sent' : l.kind === 'status' ? 'status' : ''}${l.at ? ' at' : ''}"${l.at ? ` data-at="${esc(l.at)}" title="Show on the map"` : ''}><time>${S.fmtClock(l.t)}</time><span>${esc(l.msg)}</span></li>`).join('');
  }
  // Click a log line about a junction: the map zooms to it and rings it for a few seconds.
  let ringTimer = 0;
  $('#c-log').addEventListener('click', e => {
    const li = e.target.closest('li[data-at]'), j = li && sim && sim.nodes[li.dataset.at];
    if (!j) return;
    showJunction(j);
    host.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });

  // Every 5 min a plain status line in the activity log, so a quiet console still shows it is watching.
  const STATUS_EVERY = 300;
  let nextStatus = -Infinity;
  function statusLine(vc) {
    const blocked = sim.isects.filter(j => j.boxBlocked && j.blockedT >= CAM_CONFIRM).length;
    let slow = null; // the slowest main road with traffic on it
    for (const L of sim.linkList) {
      if (L.kind !== 'road' || L.length < 150 || !L.name || /^(motorway|trunk|primary|secondary|tertiary) road /.test(L.name)) continue;
      if (L.lane.reduce((s, a) => s + a.length, 0) < 4) continue;
      if (!slow || L.meanSpeed < slow.meanSpeed) slow = L;
    }
    const open = incidents.filter(i => !i.done).length;
    sim.addLog(`Status: ${vc.inNet.toLocaleString('en-IN')} vehicles on the roads, ${(vc.queued + vc.backlog).toLocaleString('en-IN')} standing still (red lights and queues); `
      + (blocked ? `${blocked} junction${blocked === 1 ? '' : 's'} blocked` : 'no junction blocked')
      + (open ? `; ${open} open incident${open === 1 ? '' : 's'}` : '')
      + (slow ? `; slowest road ${slow.name} at ${Math.round(slow.meanSpeed * 3.6)} km/h` : '') + '.', 'status');
  }

  function tick() {
    if (!sim) return;
    $('#c-clock').textContent = S.fmtClock(sim.t);
    const vc = sim.vehicleCounts();
    $('#c-veh').textContent = vc.inNet.toLocaleString('en-IN');
    $('#c-queued').textContent = (vc.queued + vc.backlog).toLocaleString('en-IN');
    if (sim.t >= nextStatus) { nextStatus = (Math.floor(sim.t / STATUS_EVERY) + 1) * STATUS_EVERY; statusLine(vc); }
    for (const inc of incidents) {
      if (inc.done) continue;
      if (inc.type === 'ambulance') {
        const e = inc.ev.evEntry;
        if (e && e.tt != null) {
          inc.done = true;
          toast(`Ambulance arrived at ${inc.hospital}`, `${inc.where.split(' → ')[0]} to ${inc.hospital} in ${S.fmtDur(e.tt)}, ${S.fmtDur(e.delay)} slower than on an empty road.`);
        }
      }
      else if (sim.t >= inc.until) inc.done = true;
    }
    if (sim.newSuggestion) sim.newSuggestion = false;
    updateAsk();
    renderList();
    renderSched();
    updateCam();
    renderLog();
    updateDraftReach();
  }

  // ------------------------------------------------------------------ camera alerts
  // A junction camera flags a box blocked for 20 s or more. The alert stays until the junction is clear, then
  // shows who cleared it for 2 min. (The camera feed is assumed connected; in the twin it is the simulation.)
  const camAlerts = new Map(); // junction id → { j, since, clearedAt, by }
  const CAM_CONFIRM = 20; // shorter blocks clear on their own: alerting on them would bury the controller
  function updateCam() {
    for (const j of sim.isects) {
      const a = camAlerts.get(j.id);
      if (j.boxBlocked && j.blockedT >= CAM_CONFIRM) {
        if (!a || a.clearedAt != null) camAlerts.set(j.id, { j, since: sim.t - j.blockedT, clearedAt: null });
      } else if (j.boxBlocked && a && a.clearedAt == null) {
        // a marshal cleared some vehicles and the count restarted: keep the open alert
      } else if (a && a.clearedAt == null && !j.boxBlocked) {
        a.clearedAt = sim.t;
        a.by = j.lastCleared && sim.t - j.lastCleared.t < 3 ? j.lastCleared.by : 'itself';
      }
    }
    for (const [id, a] of camAlerts) if (a.clearedAt != null && sim.t - a.clearedAt > 120) camAlerts.delete(id);
    const list = [...camAlerts.values()].sort((p, q) => (p.clearedAt != null) - (q.clearedAt != null) || p.since - q.since);
    const BY = { controller: 'the marshal you sent', auto: 'a marshal', ground: 'a marshal on the ground', itself: 'traffic moving again' };
    $('#c-cam').innerHTML = list.length ? list.map(a => {
      const j = a.j, open = a.clearedAt == null;
      const st = !open ? `<div class="st ok">Clear at ${clock(a.clearedAt)}, by ${BY[a.by] || 'a marshal'}</div>`
        : j.marshalAt != null ? `<div class="st wait">Marshal ${sim.t < j.marshalAt ? `on the way, there in ~${Math.ceil(j.marshalAt - sim.t)} s` : 'there, clearing it'}</div>`
        : `<div class="st bad">Blocked for ${S.fmtDur(sim.t - a.since)}${sim.t - a.since >= 30 ? ' · gridlock' : ''}</div>`;
      return `<li class="inc cam${open ? '' : ' done'}"><div class="inc-h"><b>${esc(sim.jName(j))}</b><time>${clock(a.since)}</time></div>
        <div class="st">${j.box.length} vehicle${j.box.length === 1 ? '' : 's'} in the junction</div>${st}
        <div class="acts"><button class="btn btn-sm btn-ghost" data-cam="show" data-j="${esc(j.id)}">Show on map</button>${open && j.marshalAt == null ? `<button class="btn btn-sm btn-primary" data-cam="marshal" data-j="${esc(j.id)}">Send marshal</button>` : ''}</div></li>`;
    }).join('') : `<li class="empty">No junction blocked · checked ${S.fmtClock(sim.t)}</li>`;
  }
  function showJunction(j) {
    R.view.z = Math.max(R.view.z, 5); R.view.cx = j.x; R.view.cy = j.y; R.layout();
    R.selected = j.id;
    clearTimeout(ringTimer); ringTimer = setTimeout(() => { R.selected = null; }, 6000);
  }
  $('#c-cam').addEventListener('click', e => {
    const b = e.target.closest('button[data-cam]'), j = b && sim && sim.nodes[b.dataset.j];
    if (!j) return;
    if (b.dataset.cam === 'show') showJunction(j);
    else { sim.sendMarshal(j); updateCam(); renderLog(); }
  });

  // ------------------------------------------------------------------ scheduled plans
  // A plan from the Plan ahead tab, put on the live twin's clock for the day it is for: today if it has not
  // started yet, otherwise tomorrow. Closures, VIP lanes and convoys, office-hour changes and the event crowd
  // then happen in the twin at those times, with the plan's advance notice.
  const scheduled = [];
  let nextSched = 1;
  const DAY_MS = 86400e3;
  const midnight = ms => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
  function planWindow(sc, P) {
    const fr = [], to = [];
    for (const x of (sc.closures || []).concat(sc.lanes || [], sc.demand || [], sc.venues || [])) { fr.push(x.from); to.push(x.until); }
    for (const x of sc.convoys || []) { fr.push(x.at); to.push(x.at + 0.25); }
    const a = P.type === 'event' ? P.input.start : P.start;
    return [Math.min(a, ...fr), Math.max(P.end, ...to)];
  }
  function applyPlan(it) {
    if (!sim) return;
    it.off = sim.t + (it.day - Date.now()) / 1000; // the plan day's midnight on the twin's clock
    it.handle = sim.addScenario(it.scenario, it.off);
  }
  const planT = (it, h) => h * 3600 + it.off; // a plan hour on the twin's clock
  function schedulePlan(res) {
    const { P, reco } = res;
    if (P.area !== state.area) return null;
    const sc = JSON.parse(JSON.stringify(Object.assign({}, reco.rec.scenario, { incidents: [] })));
    const [h0, h1] = planWindow(sc, P), now = Date.now(), today = midnight(now);
    const day = today + h0 * 3600e3 > now + 60e3 ? today : today + DAY_MS;
    const it = { id: nextSched++, area: P.area, title: P.title, plan: reco.rec.name, h0, h1, day, scenario: sc, actions: reco.actions, cancelled: false };
    scheduled.push(it);
    applyPlan(it);
    if (sim) sim.addLog(`Plan scheduled: ${it.plan} for "${it.title}" (${day === today ? 'today' : 'tomorrow'})`, 'sent');
    setTab('live');
    renderSched();
    toast('Plan scheduled', `${it.plan}, ${day === today ? 'today' : 'tomorrow'} ${W_hhmm(h0)}–${W_hhmm(h1)}. It runs in the live twin at those times.`);
    return it;
  }
  const W_hhmm = h => { const m = Math.round(((h % 24) + 24) % 24 * 60); return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
  const inFor = s => { const m = Math.round(s / 60); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`; };
  function renderSched() {
    const mine = scheduled.filter(it => it.area === state.area && !it.cancelled);
    $('#p-sched').hidden = !mine.length;
    if (!mine.length || !sim) return;
    const today = midnight(Date.now());
    $('#c-sched').innerHTML = mine.map(it => {
      const a = planT(it, it.h0), b = planT(it, it.h1);
      const day = it.day === today ? 'Today' : it.day === today + DAY_MS ? 'Tomorrow' : new Date(it.day).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
      const st = sim.t < a ? `<div class="st">Starts in ${inFor(a - sim.t)}</div>` : sim.t < b ? `<div class="st bad">Under way · until ${W_hhmm(it.h1)}</div>` : '<div class="st ok">Finished</div>';
      return `<li class="inc${sim.t >= b ? ' done' : ''}"><div class="inc-h"><b>${esc(it.title)}</b><span>${day} ${W_hhmm(it.h0)}–${W_hhmm(it.h1)}</span></div>
        <div class="st">Plan: ${esc(it.plan)}</div>${st}
        <details class="sched-steps"><summary>Action timeline</summary><ol>${it.actions.map(x => `<li><time>${esc(x.when)}</time><span>${esc(x.what)}</span></li>`).join('')}</ol></details>
        ${sim.t < b ? `<div class="acts"><button class="btn btn-sm btn-ghost" data-sched="cancel" data-id="${it.id}">${sim.t < a ? 'Cancel plan' : 'Call it off now'}</button></div>` : ''}</li>`;
    }).join('');
  }
  $('#c-sched').addEventListener('click', e => {
    const b = e.target.closest('button[data-sched]'), it = b && scheduled.find(x => x.id === +b.dataset.id);
    if (!it || !sim) return;
    it.cancelled = true;
    if (it.handle) sim.removeScenario(it.handle);
    sim.addLog(`Plan cancelled: ${it.plan} for "${it.title}"`, 'sent');
    renderSched(); renderLog();
  });
  window.SAARTHI_CONSOLE = { get area() { return state.area; }, schedule: schedulePlan, setTab };

  // ------------------------------------------------------------------ loop
  let lastUi = 0;
  function frame(now) {
    if (sim && state.visible) {
      let target = wallT() + dayOffset;
      if (target < sim.t - 43200) { dayOffset += 86400; target += 86400; } // midnight passed
      const lag = target - sim.t;
      if (lag > 1800 && !incidents.some(i => !i.done)) { build(); requestAnimationFrame(frame); return; } // away a long time: start again at now
      const t0 = performance.now();
      while (sim.t + S.DT <= target && performance.now() - t0 < 35) sim.step();
      const behind = target - sim.t;
      $('#c-load').textContent = behind > 5 ? `catching up: ${Math.ceil(behind / 60)} min behind` : 'typical traffic for this time of day';
    }
    if (sim && state.visible && state.tab === 'live') { R.draw(now); drawMarks(); }
    if (state.visible && now - lastUi > 400) { lastUi = now; tick(); }
    requestAnimationFrame(frame);
  }

  new IntersectionObserver(es => { state.visible = es[es.length - 1].isIntersecting; }).observe($('#console-app'));

  build();
  if (qs.get('whatif')) setTab('plan');
  requestAnimationFrame(frame);
})();
