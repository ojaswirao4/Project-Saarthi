#!/usr/bin/env node
/*
 * Signal survey sheet for one area: every at-grade crossing of two or more mapped roads, with links to
 * Google Maps and Street View, to be marked "signal" / "no signal" by someone checking it (street imagery,
 * a site visit or the traffic police's list). The sheet saves tools/signals/<area>.json, which
 * tools/osm-import.js then applies on top of OpenStreetMap (OSM under-maps signals in Indian cities).
 *
 *   node tools/signal-survey.js fco      → survey/fco-signals.html
 *
 * Only roads in the model (tertiary and above) are listed: a signal where a smaller sector road meets a
 * main road needs that road added to the area first.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const S = require('../js/engine.js');

const area = process.argv[2];
if (!area) { console.error('usage: node tools/signal-survey.js <area>'); process.exit(1); }
const sim = new S.Sim({ mode: 'adaptive', seed: 7, startHour: 9, warmup: false, network: area });
const net = sim.net;
const GEN = /^(motorway|trunk|primary|secondary|tertiary) road /;
const amb = new Set(sim.ambRoute ? sim.ambRoute.ids.map(i => sim.links[i].to) : []);
const prev = (() => { const f = path.join(__dirname, 'signals', `${area}.json`); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; })();

// One physical crossing of divided roads is several junction nodes: group ground-level nodes within 45 m.
const pts = sim.isects.filter(j => j.level === 0 && !j.circ);
const par = new Map(pts.map(j => [j.id, j.id]));
const find = a => (par.get(a) === a ? a : (par.set(a, find(par.get(a))), par.get(a)));
for (const a of pts) for (const b of pts) if (a.id < b.id && Math.hypot(a.x - b.x, a.y - b.y) < 45) par.set(find(a.id), find(b.id));
const groups = new Map();
for (const j of pts) { const r = find(j.id); (groups.get(r) || groups.set(r, []).get(r)).push(j); }

const [lat0, lon0] = net.center, kx = Math.cos(lat0 * Math.PI / 180) * 111320, ky = 110540;
const rows = [];
for (const js of groups.values()) {
  const inG = id => js.some(j => j.id === id);
  const ext = js.flatMap(j => j.ins.concat(j.outs || []))
    .filter(L => L.level === 0 && L.kind !== 'entry' && L.kind !== 'exit' && L.kind !== 'slip' && !(inG(L.from) && inG(L.to)));
  const roads = new Set(ext.map(L => (L.name && !GEN.test(L.name) ? L.name : `${L.cls || 'road'}:${L.rank}`)));
  const osmHere = js.some(j => (net.nodes.find(n => n.id === j.id) || {}).osmSignal);
  if ((roads.size < 2 || ext.length < 3) && !osmHere) continue; // a bend, a merge or a U-turn point, not a crossing (unless OSM maps a signal there: check it too)
  const x = js.reduce((s, j) => s + j.x, 0) / js.length, y = js.reduce((s, j) => s + j.y, 0) / js.length;
  const lat = +(lat0 - (y - net.size.h / 2) / ky).toFixed(6), lon = +(lon0 + (x - net.size.w / 2) / kx).toFixed(6);
  const named = [...roads].filter(r => !r.includes(':'));
  const p = prev && (prev.points || []).find(q => Math.hypot((q.lat - lat) * ky, (q.lon - lon) * kx) < 25);
  rows.push({ name: sim.jName(js[0]), roads: named.length ? named.join(', ') : 'unnamed roads', lat, lon,
    osm: osmHere, amb: js.some(j => amb.has(j.id)),
    signal: p ? p.signal : null, note: p ? p.note || '' : '' });
}
rows.sort((a, b) => b.amb - a.amb || a.lat - b.lat);

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Signal survey · ${esc(net.short || net.name)}</title>
<style>
  :root { --bg: #f6f7f9; --surface: #fff; --ink: #14181f; --muted: #5b6573; --line: #dde1e7; --accent: #1f5fbf; --good: #1d7a46; --bad: #b42318; --warn: #a15c00; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0f1216; --surface: #171b21; --ink: #e8ebef; --muted: #9aa4b1; --line: #2a313a; --accent: #6ea8ff; --good: #4cc38a; --bad: #ff7a6b; --warn: #f0b45a; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 1100px; margin: 0 auto; padding: 24px 16px 48px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  p { margin: 6px 0; } .muted { color: var(--muted); }
  .box { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 14px 16px; margin: 14px 0; }
  table { width: 100%; border-collapse: collapse; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { font-size: 12px; color: var(--muted); font-weight: 600; background: var(--bg); }
  td small { display: block; color: var(--muted); }
  .tag { display: inline-block; font-size: 11px; font-weight: 600; padding: 1px 6px; border-radius: 4px; border: 1px solid var(--line); margin-top: 3px; }
  .tag.amb { color: var(--bad); border-color: var(--bad); }
  a { color: var(--accent); }
  .ch { display: flex; gap: 4px; flex-wrap: wrap; }
  .ch label { border: 1px solid var(--line); border-radius: 6px; padding: 3px 8px; cursor: pointer; white-space: nowrap; }
  .ch input { margin: 0 4px 0 0; }
  .ch label:has(input[value="yes"]:checked) { border-color: var(--good); color: var(--good); font-weight: 600; }
  .ch label:has(input[value="no"]:checked) { border-color: var(--bad); color: var(--bad); font-weight: 600; }
  .ch label:has(input[value="unsure"]:checked) { border-color: var(--warn); color: var(--warn); font-weight: 600; }
  input[type=text], select { font: inherit; padding: 5px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); color: var(--ink); width: 100%; }
  .meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px; }
  .meta label { font-size: 12px; color: var(--muted); display: grid; gap: 3px; }
  button { font: inherit; padding: 8px 14px; border-radius: 6px; border: 1px solid var(--accent); background: var(--accent); color: #fff; cursor: pointer; }
  #count { margin-left: 10px; color: var(--muted); }
  @media (max-width: 760px) { .hide-sm { display: none; } table { font-size: 13px; } }
</style></head>
<body><main>
  <h1>Traffic signal survey · ${esc(net.name)}</h1>
  <p class="muted">For the SAARTHI digital twin. OpenStreetMap, which the twin's road network comes from, marks a signal at ${rows.filter(r => r.osm).length} of these ${rows.length} junctions. Mark each one as it is on the ground.</p>
  <div class="box">
    <p><b>How to check:</b> open <b>Street View</b> for the junction and look for signal heads (the light poles) on any arm. If the imagery is old or unclear, choose <i>Can't tell</i> and add a note; a site visit or the traffic police's list settles it.</p>
    <p class="muted">Junctions on the ambulance route in the twin are listed first. Only roads in the model (tertiary and above) are listed: if a signal is where a smaller sector road meets a main road, write it in the note on the nearest row.</p>
  </div>
  <div class="box meta">
    <label>Checked by<input type="text" id="by" placeholder="name, organisation"></label>
    <label>Date<input type="text" id="on" placeholder="YYYY-MM-DD"></label>
    <label>Method<select id="method"><option>Google Street View</option><option>Site visit</option><option>Traffic police list</option><option>Mixed</option></select></label>
  </div>
  <table>
    <thead><tr><th>#</th><th>Junction</th><th class="hide-sm">Map</th><th>On the ground</th><th class="hide-sm">Note</th></tr></thead>
    <tbody>
${rows.map((r, i) => `      <tr data-i="${i}">
        <td>${i + 1}</td>
        <td><b>${esc(r.name)}</b><small>${esc(r.roads)}</small><small>${r.lat}, ${r.lon} · OSM: ${r.osm ? 'signal' : 'no signal'}</small>${r.amb ? '<span class="tag amb">ambulance route</span>' : ''}</td>
        <td class="hide-sm"><a href="https://www.google.com/maps/@?api=1&amp;map_action=pano&amp;viewpoint=${r.lat},${r.lon}" target="_blank" rel="noopener">Street View</a><br><a href="https://www.google.com/maps/search/?api=1&amp;query=${r.lat},${r.lon}" target="_blank" rel="noopener">Google Maps</a></td>
        <td><div class="ch">
          <label><input type="radio" name="s${i}" value="yes"${r.signal === true ? ' checked' : ''}>Signal</label>
          <label><input type="radio" name="s${i}" value="no"${r.signal === false ? ' checked' : ''}>No signal</label>
          <label><input type="radio" name="s${i}" value="unsure">Can't tell</label></div></td>
        <td class="hide-sm"><input type="text" name="n${i}" value="${esc(r.note)}" placeholder="optional"></td>
      </tr>`).join('\n')}
    </tbody>
  </table>
  <p style="margin-top:14px"><button id="save">Download ${esc(area)}.json</button><span id="count"></span></p>
  <p class="muted">Put the downloaded file at <code>tools/signals/${esc(area)}.json</code> in the project and run <code>node tools/osm-import.js ${esc(area)}</code>. Junctions marked <i>Signal</i> become signalised in the twin; <i>No signal</i> removes an OSM signal; <i>Can't tell</i> leaves OSM as it is.</p>
</main>
<script>
  const ROWS = ${JSON.stringify(rows.map(({ name, roads, lat, lon }) => ({ name, roads, lat, lon })))};
  const KEY = 'saarthi-survey-${area}';
  const $ = s => document.querySelector(s);
  function read() {
    return ROWS.map((r, i) => {
      const v = (document.querySelector('input[name="s' + i + '"]:checked') || {}).value;
      const note = (document.querySelector('input[name="n' + i + '"]') || {}).value || '';
      return Object.assign({}, r, { signal: v === 'yes' ? true : v === 'no' ? false : null }, note ? { note } : {});
    });
  }
  function count() { const p = read(); $('#count').textContent = p.filter(x => x.signal !== null).length + ' of ' + p.length + ' marked'; }
  // keep progress in this browser until the file is downloaded
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (saved) {
      ['by', 'on', 'method'].forEach(k => { if (saved[k]) $('#' + k).value = saved[k]; });
      (saved.points || []).forEach((p, i) => {
        if (p.signal !== null) { const r = document.querySelector('input[name="s' + i + '"][value="' + (p.signal ? 'yes' : 'no') + '"]'); if (r) r.checked = true; }
        if (p.note) document.querySelector('input[name="n' + i + '"]').value = p.note;
      });
    }
  } catch (e) {}
  if (!$('#on').value) $('#on').value = new Date().toISOString().slice(0, 10);
  function doc() { return { area: '${area}', surveyedOn: $('#on').value, by: $('#by').value, method: $('#method').value, points: read() }; }
  document.addEventListener('change', () => { count(); try { localStorage.setItem(KEY, JSON.stringify(doc())); } catch (e) {} });
  document.addEventListener('input', () => { try { localStorage.setItem(KEY, JSON.stringify(doc())); } catch (e) {} });
  $('#save').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(doc(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = '${area}.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  count();
</script>
</body></html>
`;
const out = path.join(__dirname, '..', 'survey', `${area}-signals.html`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log(`${net.name}: ${rows.length} junctions to check (${rows.filter(r => r.amb).length} on the ambulance route, ${rows.filter(r => r.osm).length} with an OSM signal)`);
console.log(`wrote ${path.relative(process.cwd(), out)}`);
