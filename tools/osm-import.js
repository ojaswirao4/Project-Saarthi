/*
 * Project SAARTHI: build a twin road network from OpenStreetMap.
 *
 *   node tools/osm-import.js cp           # Connaught Place, New Delhi
 *   node tools/osm-import.js s62          # Sector 62, Noida (NH-9)
 *   node tools/osm-import.js all --refresh
 *
 * Pulls every motorway / trunk / primary / secondary / tertiary road and every slip road (*_link)
 * in the area from the Overpass API, plus turn restrictions, hospitals and metro stations. Then:
 *   - clips the roads to the area box; each road crossing the edge becomes an entry/exit
 *   - merges the 2–4 OSM nodes of a dual-carriageway crossing into one junction
 *   - keeps slip roads as their own links (diverge and merge points become priority junctions)
 *   - keeps flyovers and underpasses as grade-separated links (no junction where they cross)
 *   - finds U-turn movements (median openings and U-turns at junctions) and applies turn restrictions
 *   - marks a junction signalised when OSM maps a traffic signal there
 *   - estimates entry demand and an origin–destination matrix from road class and lanes
 * and writes js/networks/<id>.js, which the browser twin and the Node tools both load.
 *
 * Raw Overpass responses are cached in tools/osm-cache/ (pass --refresh to fetch again).
 * Map data © OpenStreetMap contributors, ODbL.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const AREAS = {
  cp: {
    name: 'Connaught Place, New Delhi', short: 'Connaught Place',
    center: [28.6312, 77.2195], half: [950, 800],
    ambulance: { from: /Barakhamba/i, toHospital: /Lady Hardinge|Kalawati|Sucheta|Ram Manohar|RML/i },
    parking: /Janpath/i, surge: /Minto|Bhagat Singh|Chelmsford/i,
    corridor: { from: /Barakhamba/i, to: /Janpath|Baba Kharak|Bhagat Singh/i },
    // Calibrated to Google Maps typical car times, Barakhamba Road → Shaheed Bhagat Singh Marg (Tue, Oct
    // 2026): 6 AM 4–6, 9 AM 8–14, 1 PM 6–10 min. In a continuous 07:00–10:30 run the fixed twin's middle
    // half of corridor trips is 6.9–10.7 min at 09:00 (was 0.6: 14.3–22.0, gridlocked by 10 AM). At 0.48
    // 9 AM fits better but it gridlocks by 10 AM. Few corridor trips (~20 per run): read as approximate.
    demandScale: 0.45,
  },
  fco: {
    name: 'Film City corridor, Noida', short: 'Film City',
    center: [28.5650, 77.3170], half: [1300, 1200],
    ambulance: { from: /DND/i, toHospital: /Kailash|Fortis|Max|Jaypee|Hospital/i },
    parking: /Dadri Main/i, surge: /Agrasen|Sector 18|Atta|DLF/i,
    corridor: { from: /DND/i, to: /Mahamaya|Greater Noida|Expressway/i },
    // Calibrated to Google Maps typical car times, DND Flyway → Lt. Vijyant Thapar Marg (Tue, Oct 2026):
    // 6 AM 5–7, 9 AM 10–18, 10 AM 12–20, 1 PM 7–12 min. Free-flow already matched at 6 AM. In a continuous
    // 07:00–10:30 run the fixed twin's middle half of corridor trips is 8.3–13.3 min at 09:00 (was 0.43:
    // 7.4–9.2) and 9.5–19.2 at 10:00. The area tips sharply: at 0.56 it gridlocks by 10 AM (12–35 min).
    // Re-calibrated 2026-11-17 with 3 inferred signals (Lt Vijyant Thapar Marg x2, Maharaja Agrasen Marg): at 0.52 the
    // fixed twin gridlocks from 09:30. At 0.42: 9 AM 10-15, 10 AM 11-13, 1 PM 7.4-10 min, no backlog; 6 AM 7-10 is
    // above Google (the inferred signals run one all-day plan; real ones may run shorter cycles early morning).
    demandScale: 0.42,
    inferCrossings: true, // OSM maps 1 signal at the 11 crossings: infer them until the signal survey (survey/fco-signals.html)

  },
  s62: {
    name: 'Sector 62, Noida', short: 'Sector 62 Noida',
    center: [28.6255, 77.3690], half: [1150, 1100],
    ambulance: { from: /NH|National Highway|Delhi.?Meerut|Flyover/i, toHospital: /Fortis/i },
    parking: /Vishwakarma/i, surge: /Sector 63|Sector 62/i,
    corridor: { from: /NH|National Highway|Delhi.?Meerut/i, to: /NH|National Highway|Delhi.?Meerut/i },
    // Calibrated to Google Maps typical car times, NH-24 Bypass Flyover → Vishwakarma Road (Tue, Oct 2026):
    // 6 AM 6–8, 9 AM 12–20, 1 PM 8–12 min. Only possible once zipper merging and long one-way loop
    // detection stopped the area flipping from free flow to gridlock. In a continuous 07:00–10:30 run the
    // fixed twin's middle half of corridor trips is 8.9–18.3 min at 09:00 and keeps moving at 10:00
    // (~9900 trips/h finishing); at ×1.5 of this it collapses.
    demandScale: 0.97,
    inferCrossings: true, // OSM maps no usable signal on the main crossings: infer them until the signal survey
  },
  s34: {
    name: 'Sector 34, Noida', short: 'Sector 34 Noida',
    center: [28.5820, 77.3620], half: [1100, 1000], // Sector 34 and its metro station (Noida Sector 34, 28.5803 N 77.3635 E)
    inferT: true, // OSM maps no signals here; at-grade junctions of main roads are signalised
    // Surbhi Hospital is inside the area, on Shaheed Captain Shashikant Sharma Marg, so the "exit nearest the
    // hospital" rule picks a far edge. Fixed by entry and exit id instead: from Main Road Gijhor through the main
    // crossing by the metro and down Shashikant Sharma Marg past the hospital.
    ambulance: { from: /Gijhor/i, toHospital: /Surbhi/i },
    ambulanceIds: { o: 'X8', d: 'X35' },
    parking: /Shashikant/i, surge: /City Center/i,
    corridorIds: { o: 'X34', d: 'X15' }, // Shashikant Sharma Marg (SW) → its underpass (NE), through the same crossing
    demandScale: 0.7, // provisional: not yet calibrated to Google Maps times
  },
};

const ROAD = /^(motorway|trunk|primary|secondary|tertiary)(_link)?$/;
const RANK = { motorway: 6, trunk: 5, primary: 4, secondary: 3, tertiary: 2 };
const KMH = { motorway: 70, trunk: 60, primary: 50, secondary: 40, tertiary: 30 };
const PER_LANE = { motorway: 650, trunk: 600, primary: 480, secondary: 360, tertiary: 220 }; // veh/h/lane entering at profile 1.0
const CLUSTER_PIECE = 38;   // m: OSM nodes this close along a road are one physical junction
const CLUSTER_DIAM = 75;    // m: but a junction is never wider than this
const UTURN_ANGLE = 150;    // deg: a movement turning back more than this is a U-turn

// ---------------------------------------------------------------- fetch
async function overpass(q) {
  const urls = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
  let err;
  for (let attempt = 0; attempt < 6; attempt++) {
    const url = urls[attempt % urls.length];
    if (attempt) await new Promise(r => setTimeout(r, 8000 * attempt));
    try {
      const res = await fetch(url, {
        method: 'POST', body: 'data=' + encodeURIComponent(q),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'SAARTHI-twin/1.0 (research prototype)', Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      return await res.json();
    } catch (e) { err = e; console.log(`  ${e.message}, retrying…`); }
  }
  throw err;
}

function bboxOf(A, padM) {
  const [lat, lon] = A.center, k = Math.cos(lat * Math.PI / 180) * 111320;
  const dLat = (A.half[1] + padM) / 110540, dLon = (A.half[0] + padM) / k;
  return [lat - dLat, lon - dLon, lat + dLat, lon + dLon];
}

async function load(id, refresh) {
  const A = AREAS[id];
  const file = path.join(__dirname, 'osm-cache', `${id}.json`);
  if (!refresh && fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const bb = bboxOf(A, 120).map(v => v.toFixed(6)).join(',');
  const big = bboxOf(A, 2500).map(v => v.toFixed(6)).join(',');
  const q = `[out:json][timeout:120];
(way["highway"~"^(motorway|trunk|primary|secondary|tertiary)(_link)?$"]["area"!="yes"](${bb}););
(._;>;);
out body;
relation["type"="restriction"](${bb});
out body;
nwr["amenity"="hospital"]["name"](${big});
out center tags;
nwr["station"="subway"]["name"](${bb});
out center tags;
nwr["railway"="station"]["name"](${bb});
out center tags;`;
  console.log(`fetching ${A.name} from Overpass…`);
  const data = await overpass(q);
  data.fetched = new Date().toISOString().slice(0, 10);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
  return data;
}

// ---------------------------------------------------------------- geometry helpers
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
function polyLen(pts) { let s = 0; for (let i = 1; i < pts.length; i++) s += dist(pts[i - 1], pts[i]); return s; }
function clipSeg(p, q, W, H) { // Liang–Barsky on [0,W]×[0,H]
  let t0 = 0, t1 = 1;
  const dx = q[0] - p[0], dy = q[1] - p[1];
  for (const [pp, qq] of [[-dx, p[0]], [dx, W - p[0]], [-dy, p[1]], [dy, H - p[1]]]) {
    if (pp === 0) { if (qq < 0) return null; continue; }
    const r = qq / pp;
    if (pp < 0) { if (r > t1) return null; if (r > t0) t0 = r; } else { if (r < t0) return null; if (r < t1) t1 = r; }
  }
  return [t0, t1];
}
const lerp = (p, q, t) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
function heading(a, b) { return Math.atan2(b[1] - a[1], b[0] - a[0]); }
function turnAngle(inPts, outPts) { // 0 = straight on, 180 = U-turn
  const n = inPts.length;
  const h1 = heading(inPts[Math.max(0, n - 2)], inPts[n - 1]);
  const h2 = heading(outPts[0], outPts[Math.min(1, outPts.length - 1)]);
  let d = Math.abs(h2 - h1) * 180 / Math.PI;
  if (d > 180) d = 360 - d;
  return d;
}
function side(p, W, H) {
  const c = [p[0] - W / 2, p[1] - H / 2];
  const a = (Math.atan2(c[0], -c[1]) * 180 / Math.PI + 360) % 360;
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(a / 45) % 8];
}

// ---------------------------------------------------------------- build
function build(id, data) {
  const A = AREAS[id];
  const [lat0, lon0] = A.center, kx = Math.cos(lat0 * Math.PI / 180) * 111320, ky = 110540;
  const W = 2 * A.half[0], H = 2 * A.half[1];
  const proj = (lat, lon) => [(lon - lon0) * kx + A.half[0], -(lat - lat0) * ky + A.half[1]];
  const unproj = (x, y) => [lat0 - (y - A.half[1]) / ky, lon0 + (x - A.half[0]) / kx];

  const N = new Map(), ways = [], restrictions = [], pois = [];
  for (const e of data.elements) {
    if (e.type === 'node' && e.lat != null && !(e.tags && (e.tags.amenity || e.tags.station || e.tags.railway === 'station'))) N.set(e.id, { p: proj(e.lat, e.lon), tags: e.tags || {} });
    if (e.type === 'node' && e.tags && e.tags.highway === 'traffic_signals') N.set(e.id, { p: proj(e.lat, e.lon), tags: e.tags });
  }
  for (const e of data.elements) {
    if (e.type === 'way' && e.tags && ROAD.test(e.tags.highway || '') && e.tags.area !== 'yes') ways.push(e);
    else if (e.type === 'relation' && e.tags && e.tags.type === 'restriction') restrictions.push(e);
    if (e.tags && (e.tags.amenity === 'hospital' || e.tags.station === 'subway' || e.tags.railway === 'station')) {
      const c = e.center || (e.lat != null ? { lat: e.lat, lon: e.lon } : null);
      if (c) pois.push({ kind: e.tags.amenity === 'hospital' ? 'hospital' : 'metro', name: e.tags.name, p: proj(c.lat, c.lon) });
    }
  }
  for (const e of data.elements) if (e.type === 'node' && N.has(e.id) === false && e.lat != null) N.set(e.id, { p: proj(e.lat, e.lon), tags: e.tags || {} });

  // --- way attributes
  const wayInfo = new Map();
  for (const w of ways) {
    const t = w.tags, m = t.highway.match(ROAD), cls = m[1], isLink = !!m[2];
    let oneway = 0;
    if (/^(yes|true|1)$/.test(t.oneway || '')) oneway = 1;
    else if (t.oneway === '-1') oneway = -1;
    else if (t.junction === 'roundabout' || t.junction === 'circular' || (cls === 'motorway' && t.oneway !== 'no')) oneway = 1;
    const tot = parseInt(t.lanes, 10);
    const defOne = { motorway: 3, trunk: 3, primary: 3, secondary: 2, tertiary: 2 }[cls];
    const defTwo = { motorway: 3, trunk: 3, primary: 2, secondary: 2, tertiary: 1 }[cls];
    let fw, bw;
    if (oneway) { fw = bw = tot > 0 ? tot : (isLink ? 1 : defOne); }
    else {
      fw = parseInt(t['lanes:forward'], 10) || (tot > 0 ? Math.max(1, Math.floor(tot / 2)) : (isLink ? 1 : defTwo));
      bw = parseInt(t['lanes:backward'], 10) || (tot > 0 ? Math.max(1, tot - Math.floor(tot / 2)) : (isLink ? 1 : defTwo));
    }
    let ms = parseInt(t.maxspeed, 10);
    if (!(ms > 0)) ms = isLink ? Math.min(30, KMH[cls]) : KMH[cls];
    const layer = parseInt(t.layer, 10) || 0;
    const bridge = (!!t.bridge && t.bridge !== 'no') || layer > 0;
    const tunnel = (!!t.tunnel && t.tunnel !== 'no') || layer < 0;
    wayInfo.set(w.id, { cls, isLink, oneway, fw: Math.min(4, fw), bw: Math.min(4, bw), vmax: ms / 3.6, layer: bridge ? Math.max(1, layer) : tunnel ? Math.min(-1, layer) : 0,
      bridge, tunnel, name: t.name || t['name:en'] || t.ref || '', ref: t.ref || '', roundabout: t.junction === 'roundabout' || t.junction === 'circular', rank: RANK[cls] - (isLink ? 1.5 : 0) });
  }

  // --- vertices: nodes used by 2+ ways, way ends, signals
  const use = new Map();
  for (const w of ways) for (const nid of new Set(w.nodes)) use.set(nid, (use.get(nid) || 0) + 1);
  const isSignal = nid => N.get(nid) && N.get(nid).tags.highway === 'traffic_signals';
  const V = new Map(); // id -> { id, p, signal, boundary, osm:[...] }
  const vtx = (nid) => {
    if (!V.has(nid)) V.set(nid, { id: nid, p: N.get(nid).p, signal: isSignal(nid), boundary: false });
    return V.get(nid);
  };
  let bN = 0;
  const pieces = []; // undirected: { a, b, pts, way }
  for (const w of ways) {
    const ns = w.nodes.filter(n => N.has(n));
    if (ns.length < 2) continue;
    // split at vertices
    const parts = [];
    let cur = [ns[0]];
    for (let k = 1; k < ns.length; k++) {
      cur.push(ns[k]);
      const isV = use.get(ns[k]) > 1 || isSignal(ns[k]);
      if (isV && k < ns.length - 1) { parts.push(cur); cur = [ns[k]]; }
    }
    parts.push(cur);
    for (const part of parts) {
      // a signal in the middle of a piece is a vertex too (mid-block pedestrian signal)
      const pts = part.map(n => N.get(n).p);
      // clip to the area box
      let run = null;
      const flush = () => {
        if (run && run.pts.length >= 2 && polyLen(run.pts) > 1) pieces.push(Object.assign(run, { way: w.id }));
        run = null;
      };
      for (let i = 0; i + 1 < pts.length; i++) {
        const p = pts[i], q = pts[i + 1], c = clipSeg(p, q, W, H);
        if (!c) { flush(); continue; }
        const [t0, t1] = c;
        if (!run || t0 > 0) {
          flush();
          if (t0 > 0) { const id = 'b' + (++bN); V.set(id, { id, p: lerp(p, q, t0), boundary: true, signal: false }); run = { a: id, pts: [V.get(id).p] }; }
          else { vtx(part[i]); run = { a: part[i], pts: [p] }; }
        }
        if (t1 < 1) {
          const id = 'b' + (++bN); V.set(id, { id, p: lerp(p, q, t1), boundary: true, signal: false });
          run.pts.push(V.get(id).p); run.b = id; flush();
        } else {
          run.pts.push(q);
          if (i + 1 === pts.length - 1) { vtx(part[i + 1]); run.b = part[i + 1]; flush(); }
        }
      }
      flush();
    }
  }
  for (const pc of pieces) pc.len = polyLen(pc.pts);

  // --- signals from a site survey (tools/signals/<area>.json). OSM under-maps signals in Indian cities, so
  // each junction is checked on the ground or on street imagery: a point marked "signal" makes the junction
  // nearest it (within 40 m) signalised; a point marked "no signal" removes an OSM signal there.
  const sfile = path.join(__dirname, 'signals', `${id}.json`);
  const survey = fs.existsSync(sfile) ? JSON.parse(fs.readFileSync(sfile, 'utf8')) : null;
  const surveyLog = { added: 0, removed: 0, missed: [], points: [] };
  if (survey) {
    const crossings = [...V.values()].filter(v => !v.boundary && use.get(v.id) > 1);
    for (const s of survey.points || []) {
      if (s.signal !== true && s.signal !== false) continue; // not checked yet
      const p = proj(s.lat, s.lon);
      const near = crossings.map(v => ({ v, d: dist(v.p, p) })).filter(x => x.d <= 40).sort((a, b) => a.d - b.d);
      if (!near.length) { surveyLog.missed.push(s.name || `${s.lat},${s.lon}`); continue; }
      if (s.signal) {
        for (const { v, d } of near) if (d <= near[0].d + 15) { v.signal = true; v.surveyed = true; } // all corners of a divided-road crossing
        surveyLog.added++;
        surveyLog.points.push({ name: s.name || `${s.lat},${s.lon}`, vs: near.filter(x => x.v.signal).map(x => x.v.id) });
      } else {
        for (const { v } of near) if (v.signal) { v.signal = false; v.surveyed = true; }
        surveyLog.removed++;
      }
    }
  }

  // --- cluster the OSM nodes of one physical junction
  const nb = new Map();
  for (const pc of pieces) for (const [x, y] of [[pc.a, pc.b], [pc.b, pc.a]]) { if (!nb.has(x)) nb.set(x, new Set()); nb.get(x).add(y); }
  const linkEnd = new Set();
  for (const pc of pieces) if (wayInfo.get(pc.way).isLink && pc.len > 15) { linkEnd.add(pc.a); linkEnd.add(pc.b); }
  const jlike = v => !V.get(v).boundary && ((nb.get(v) || new Set()).size >= 3 || V.get(v).signal);
  const parent = new Map(), members = new Map();
  const find = x => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  for (const v of V.keys()) { parent.set(v, v); members.set(v, [v]); }
  const diam = ms => { let d = 0; for (const a of ms) for (const b of ms) d = Math.max(d, dist(V.get(a).p, V.get(b).p)); return d; };
  for (const pc of pieces.slice().sort((p, q) => p.len - q.len)) {
    if (pc.len > CLUSTER_PIECE) break;
    const wi = wayInfo.get(pc.way);
    if (V.get(pc.a).boundary || V.get(pc.b).boundary) continue;
    const tiny = pc.len <= 16; // a stub this short is never a road of its own
    if (!tiny) {
      if (wi.layer !== 0) continue;
      if (!jlike(pc.a) || !jlike(pc.b)) continue;
      if (linkEnd.has(pc.a) || linkEnd.has(pc.b)) continue; // keep slip roads separate
    }
    const ra = find(pc.a), rb = find(pc.b);
    if (ra === rb) continue;
    const ms = members.get(ra).concat(members.get(rb));
    if (diam(ms) > CLUSTER_DIAM) continue;
    parent.set(rb, ra); members.set(ra, ms); members.delete(rb);
  }

  // how many junction points each surveyed signal ended up as (a divided-road crossing should be one)
  for (const sp of surveyLog.points) {
    sp.parts = new Set(sp.vs.map(find)).size;
    if (process.env.SURVEY_DEBUG && sp.parts > 1) {
      const vs = new Set(sp.vs);
      console.log('  split:', sp.name, sp.vs.length, 'vertices ->', sp.parts, 'points; pieces between them:',
        pieces.filter(pc => vs.has(pc.a) || vs.has(pc.b)).map(pc => `${Math.round(pc.len)}m${wayInfo.get(pc.way).isLink ? ' link' : ''}${wayInfo.get(pc.way).layer ? ' L' + wayInfo.get(pc.way).layer : ''}${vs.has(pc.a) && vs.has(pc.b) ? ' inner' : ''}${linkEnd.has(pc.a) || linkEnd.has(pc.b) ? ' linkEnd' : ''}`).join(', '));
    }
  }

  // --- directed edges between clusters
  let E = [];
  for (const pc of pieces) {
    const wi = wayInfo.get(pc.way);
    const A1 = find(pc.a), B1 = find(pc.b);
    if (A1 === B1) continue; // inside one junction
    const mk = (a, b, pts, lanes) => ({ a, b, pts, lanes, vmax: wi.vmax, cls: wi.cls, isLink: wi.isLink, name: wi.name, ref: wi.ref, rank: wi.rank,
      roundabout: wi.roundabout, oneway: !!wi.oneway, segLayer: pts.slice(1).map(() => wi.layer), wayFirst: pc.way, wayLast: pc.way,
      osmA: a === A1 ? pc.a : pc.b, osmB: b === B1 ? pc.b : pc.a, len: pc.len });
    if (wi.oneway >= 0) E.push(mk(A1, B1, pc.pts.slice(), wi.fw));
    if (wi.oneway <= 0) E.push(mk(B1, A1, pc.pts.slice().reverse(), wi.oneway ? wi.fw : wi.bw));
  }

  const centroid = c => {
    const ms = members.get(c) || [c];
    const sig = ms.filter(m => V.get(m).signal);
    const use2 = ms.length > 1 ? ms : sig.length ? sig : ms;
    return [use2.reduce((s, m) => s + V.get(m).p[0], 0) / use2.length, use2.reduce((s, m) => s + V.get(m).p[1], 0) / use2.length];
  };
  const isBoundary = c => V.get(c) && V.get(c).boundary;

  // --- simplify: dissolve shape vertices, prune dead ends, repeat until stable
  const signalCluster = c => (members.get(c) || [c]).some(m => V.get(m).signal);
  const surveyCluster = c => (members.get(c) || [c]).some(m => V.get(m).signal && V.get(m).surveyed);
  for (let pass = 0; pass < 20; pass++) {
    let changed = false;
    // prune edges not on any entry → exit path
    const outs = new Map(), ins = new Map();
    for (const e of E) { (outs.get(e.a) || outs.set(e.a, []).get(e.a)).push(e); (ins.get(e.b) || ins.set(e.b, []).get(e.b)).push(e); }
    const fwd = new Set(), bwd = new Set();
    const stack = [...new Set(E.filter(e => isBoundary(e.a)).map(e => e.a))];
    stack.forEach(s => fwd.add(s));
    while (stack.length) { const v = stack.pop(); for (const e of outs.get(v) || []) if (!fwd.has(e.b)) { fwd.add(e.b); stack.push(e.b); } }
    const st2 = [...new Set(E.filter(e => isBoundary(e.b)).map(e => e.b))];
    st2.forEach(s => bwd.add(s));
    while (st2.length) { const v = st2.pop(); for (const e of ins.get(v) || []) if (!bwd.has(e.a)) { bwd.add(e.a); st2.push(e.a); } }
    const kept = E.filter(e => fwd.has(e.a) && bwd.has(e.b) && !(isBoundary(e.a) && isBoundary(e.b)));
    if (kept.length !== E.length) { E = kept; changed = true; continue; }
    // dissolve a vertex that only joins two roads end to end
    const nbs = new Map();
    for (const e of E) { for (const [x, y] of [[e.a, e.b], [e.b, e.a]]) { if (!nbs.has(x)) nbs.set(x, new Set()); nbs.get(x).add(y); } }
    for (const [v, set] of nbs) {
      if (isBoundary(v) || (members.get(v) || []).length > 1 || signalCluster(v) || set.size !== 2) continue;
      const vi = E.filter(e => e.b === v), vo = E.filter(e => e.a === v);
      if (vi.length !== vo.length || !vi.length) continue;
      const pairs = vi.map(e => vo.filter(f => f.b !== e.a));
      if (pairs.some(p => p.length !== 1)) continue;
      const used = new Set(pairs.map(p => p[0]));
      if (used.size !== vo.length) continue;
      const merged = vi.map((e, k) => {
        const f = pairs[k][0];
        return Object.assign({}, e, { b: f.b, pts: e.pts.concat(f.pts.slice(1)), lanes: Math.min(e.lanes, f.lanes), vmax: Math.min(e.vmax, f.vmax),
          name: e.len >= f.len ? (e.name || f.name) : (f.name || e.name), cls: RANK[e.cls] >= RANK[f.cls] ? e.cls : f.cls,
          isLink: e.isLink && f.isLink, rank: Math.max(e.rank, f.rank), roundabout: e.roundabout && f.roundabout, oneway: e.oneway && f.oneway,
          segLayer: e.segLayer.concat(f.segLayer), wayLast: f.wayLast, osmB: f.osmB, len: e.len + f.len });
      });
      E = E.filter(e => e.a !== v && e.b !== v).concat(merged);
      changed = true;
      break;
    }
    if (!changed) break;
  }

  // --- nodes
  const vids = new Set(); for (const e of E) { vids.add(e.a); vids.add(e.b); }
  const insOf = new Map(), outsOf = new Map();
  for (const e of E) { (insOf.get(e.b) || insOf.set(e.b, []).get(e.b)).push(e); (outsOf.get(e.a) || outsOf.set(e.a, []).get(e.a)).push(e); }
  const nodes = [];
  let jN = 0, pN = 0, xN = 0;
  const idOf = new Map();
  // order: west→east so ids read naturally on the map
  const ordered = [...vids].map(v => ({ v, c: isBoundary(v) ? V.get(v).p : centroid(v) })).sort((a, b) => a.c[1] - b.c[1] || a.c[0] - b.c[0]);
  for (const { v, c } of ordered) {
    let type;
    const nin = (insOf.get(v) || []).length, nout = (outsOf.get(v) || []).length;
    if (isBoundary(v)) type = 'X';
    else {
      // signalised if OSM maps a signal there; otherwise inferred for a crossing of 3+ main roads
      // (or 4+ roads of any class) that isn't part of a roundabout
      const roadIns = (insOf.get(v) || []).filter(e => !e.isLink && !e.roundabout);
      const majorIns = roadIns.filter(e => RANK[e.cls] >= 3).length;
      // areas where OSM is known to under-map signals (inferT) also signalise at-grade T junctions of main roads
      const adj = (insOf.get(v) || []).concat(outsOf.get(v) || []);
      const atGrade = adj.every(e => e.segLayer.every(l => l === 0));
      const names = new Set(adj.map(e => e.name || e.wayFirst));
      const tee = A.inferT && atGrade && nout >= 2 && roadIns.length >= 3 && names.size >= 2 && roadIns.filter(e => RANK[e.cls] >= 2).length >= 3;
      type = signalCluster(v) || (nout >= 3 && (majorIns >= 3 || roadIns.length >= 4)) || tee ? 'J' : 'P';
    }
    const id = type === 'X' ? `X${++xN}` : type === 'J' ? `J${++jN}` : `P${++pN}`;
    idOf.set(v, id);
    const ms = members.get(v) || [v];
    nodes.push({ id, type, x: +c[0].toFixed(1), y: +c[1].toFixed(1), signal: !!signalCluster(v), osmSignal: !!signalCluster(v) && !surveyCluster(v), surveySignal: !!surveyCluster(v), nin, nout,
      spread: isBoundary(v) ? 0 : Math.round(diam(ms) / 2), _v: v });
  }
  const NB = new Map(nodes.map(n => [n._v, n]));

  // junction names from the roads that meet there
  for (const n of nodes) {
    const names = [...new Set((insOf.get(n._v) || []).concat(outsOf.get(n._v) || []).map(e => e.name).filter(Boolean))];
    n.name = n.type === 'X' ? '' : names.slice(0, 2).join(' × ') || 'Unnamed junction';
  }
  // junction radius: big enough for the junction, small enough to leave every road ≥ 12 m long
  for (const n of nodes) {
    if (n.type === 'X') { n.r = 0; continue; }
    const adj = (insOf.get(n._v) || []).concat(outsOf.get(n._v) || []);
    const shortest = Math.min(...adj.map(e => e.len));
    const want = n.type === 'J' ? Math.max(14, n.spread + 9) : Math.max(7, n.spread + 5);
    n.r = +Math.max(3, Math.min(want, (shortest - 10) / 2)).toFixed(1);
  }

  // --- links
  const links = [];
  const seen = new Map();
  for (const e of E) {
    const A1 = NB.get(e.a), B1 = NB.get(e.b);
    let lid = `${A1.id}>${B1.id}`;
    const k = (seen.get(lid) || 0) + 1; seen.set(lid, k);
    if (k > 1) lid += `~${k}`;
    const pts = e.pts.slice();
    if (A1.type !== 'X') pts[0] = [A1.x, A1.y]; // snap ends to the junction centre (the engine trims by the junction radius)
    if (B1.type !== 'X') pts[pts.length - 1] = [B1.x, B1.y];
    // light simplification: drop points that deviate < 1.5 m from a straight line
    const simp = [pts[0]], lay = [];
    let li = 0;
    for (let i = 1; i < pts.length - 1; i++) {
      const a = simp[simp.length - 1], b = pts[i], c = pts[i + 1];
      const dx = c[0] - a[0], dy = c[1] - a[1], L2 = Math.hypot(dx, dy) || 1;
      const off = Math.abs((b[0] - a[0]) * dy - (b[1] - a[1]) * dx) / L2;
      const layerChange = e.segLayer[i] !== e.segLayer[i - 1];
      if (off > 1.5 || layerChange) { simp.push(b); lay.push(e.segLayer[li]); li = i; }
    }
    simp.push(pts[pts.length - 1]); lay.push(e.segLayer[li]);
    const kind = A1.type === 'X' ? 'entry' : B1.type === 'X' ? 'exit' : e.isLink ? 'slip' : 'road';
    links.push({ id: lid, from: A1.id, to: B1.id, kind, lanes: e.lanes, vmax: +e.vmax.toFixed(1), cls: e.cls, rank: e.rank,
      name: e.name, roundabout: e.roundabout || undefined, oneway: e.oneway, layers: lay.some(l => l !== 0) ? lay : undefined,
      pts: simp.map(p => [+p[0].toFixed(1), +p[1].toFixed(1)]), _e: e });
  }

  // --- movements: which outgoing link each incoming link may take at a junction
  const turns = {};
  let uturnNodes = 0;
  const restr = [];
  for (const r of restrictions) {
    const t = r.tags.restriction || r.tags['restriction:motorcar'];
    if (!t) continue;
    const from = r.members.find(m => m.role === 'from' && m.type === 'way');
    const via = r.members.find(m => m.role === 'via' && m.type === 'node');
    const to = r.members.find(m => m.role === 'to' && m.type === 'way');
    if (from && via && to) restr.push({ t, from: from.ref, via: via.ref, to: to.ref });
  }
  let restrApplied = 0;
  for (const n of nodes) {
    if (n.type === 'X') continue;
    const ins = links.filter(L => L.to === n.id), outs = links.filter(L => L.from === n.id);
    const ms = new Set((members.get(n._v) || [n._v]).map(String));
    const tbl = {};
    let hasU = false;
    for (const L of ins) {
      let allowed = [];
      for (const O of outs) {
        const ang = turnAngle(L.pts, O.pts);
        const reverseSame = O.to === L.from && !L.oneway && !O.oneway && L._e.wayLast === O._e.wayFirst;
        if (reverseSame) continue; // no three-point turns in the middle of a two-way road
        if (ang > UTURN_ANGLE) { if (n.type === 'P' && ms.size < 2 && !(L.oneway && O.oneway)) continue; }
        allowed.push(O);
      }
      for (const r of restr) {
        if (!ms.has(String(r.via)) || L._e.wayLast !== r.from) continue;
        const match = O => O._e.wayFirst === r.to;
        const before = allowed.length;
        if (/^no_/.test(r.t)) allowed = allowed.filter(O => !match(O));
        else if (/^only_/.test(r.t)) { const keep = allowed.filter(match); if (keep.length) allowed = keep; }
        if (allowed.length !== before) restrApplied++;
      }
      if (!allowed.length) allowed = outs.filter(O => O.to !== L.from).slice(0, 1);
      tbl[L.id] = allowed.map(O => O.id);
      if (allowed.some(O => turnAngle(L.pts, O.pts) > UTURN_ANGLE)) hasU = true;
    }
    turns[n.id] = tbl;
    if (hasU) { uturnNodes++; n.uturn = true; }
  }

  // --- externals: entries/exits where roads cross the area edge, grouped into zones
  const X = nodes.filter(n => n.type === 'X');
  const zone = new Map();
  let zN = 0;
  for (const x of X) {
    if (zone.has(x.id)) continue;
    zone.set(x.id, ++zN);
    for (const y of X) if (!zone.has(y.id) && Math.hypot(x.x - y.x, x.y - y.y) < 70) zone.set(y.id, zN);
  }
  const externals = [];
  for (const x of X) {
    const en = links.find(L => L.from === x.id), ex = links.find(L => L.to === x.id);
    const road = (en || ex);
    const nm = road.name || `${road.cls[0].toUpperCase()}${road.cls.slice(1)} road`;
    const demand = en ? Math.round(en.lanes * PER_LANE[en.cls] * (en.kind === 'slip' || en._e.isLink ? 0.6 : 1) * A.demandScale) : 0;
    externals.push({ id: x.id, name: `${nm} (${side([x.x, x.y], W, H)})`, road: road.name, cls: road.cls, zone: zone.get(x.id), demand,
      inLanes: en ? en.lanes : 0, outLanes: ex ? ex.lanes : 0, x: x.x, y: x.y });
  }

  // --- reachability (link graph honouring the movement table) for OD and routing sanity
  const byId = new Map(links.map(L => [L.id, L]));
  function reach(fromLink) {
    const seenL = new Set([fromLink]), st = [fromLink];
    while (st.length) {
      const L = byId.get(st.pop());
      if (!turns[L.to]) continue;
      for (const o of turns[L.to][L.id] || []) if (!seenL.has(o)) { seenL.add(o); st.push(o); }
    }
    return seenL;
  }
  const od = {};
  for (const o of externals) {
    if (!o.demand) continue;
    const en = links.find(L => L.from === o.id);
    const r = reach(en.id);
    const cands = [];
    for (const d of externals) {
      if (!d.outLanes || d.zone === o.zone) continue;
      const ex = links.find(L => L.to === d.id);
      if (!r.has(ex.id)) continue;
      const dd = Math.hypot(o.x - d.x, o.y - d.y);
      cands.push({ d: d.id, w: d.outLanes * PER_LANE[d.cls] * Math.min(1, Math.max(0.12, dd / 900)) });
    }
    cands.sort((a, b) => b.w - a.w);
    const top = cands.slice(0, 12), tot = top.reduce((s, c) => s + c.w, 0);
    if (!top.length) { o.demand = 0; continue; }
    od[o.id] = Object.fromEntries(top.map(c => [c.d, +(c.w / tot).toFixed(3)]));
  }

  // --- scenario hooks: ambulance to the nearest hospital, a kerb for illegal parking, a surge origin
  const pickExt = (re, needIn, needOut, prefer) => {
    const c = externals.filter(x => (!needIn || x.demand > 0 && od[x.id]) && (!needOut || x.outLanes) && re.test(x.name));
    const all = c.length ? c : externals.filter(x => (!needIn || x.demand > 0 && od[x.id]) && (!needOut || x.outLanes));
    return all.sort(prefer || ((a, b) => RANK[b.cls] - RANK[a.cls] || (b.inLanes + b.outLanes) - (a.inLanes + a.outLanes)))[0];
  };
  const hospitals = pois.filter(p => p.kind === 'hospital');
  const hosp = hospitals.filter(h => A.ambulance.toHospital.test(h.name)).sort((a, b) => dist(a.p, [W / 2, H / 2]) - dist(b.p, [W / 2, H / 2]))[0]
    || hospitals.sort((a, b) => dist(a.p, [W / 2, H / 2]) - dist(b.p, [W / 2, H / 2]))[0];
  const extById = id => externals.find(e => e.id === id) || (() => { throw new Error(`no external ${id}`); })();
  const ambFrom = A.ambulanceIds ? extById(A.ambulanceIds.o) : pickExt(A.ambulance.from, true, false);
  let ambTo = A.ambulanceIds ? extById(A.ambulanceIds.d) : null;
  if (hosp && !ambTo) {
    const r = reach(links.find(L => L.from === ambFrom.id).id);
    ambTo = externals.filter(x => x.outLanes && x.zone !== ambFrom.zone && r.has(links.find(L => L.to === x.id).id))
      .sort((a, b) => dist([a.x, a.y], hosp.p) - dist([b.x, b.y], hosp.p))[0];
  }
  if (!ambTo) ambTo = externals.filter(x => x.outLanes && x.zone !== ambFrom.zone).sort((a, b) => dist([b.x, b.y], [ambFrom.x, ambFrom.y]) - dist([a.x, a.y], [ambFrom.x, ambFrom.y]))[0];
  const parkCands = links.filter(L => L.kind === 'road' && L.lanes >= 2 && L.lanes <= 3 && !L.layers && polyLen(L.pts) > 120); // a kerb lane lost hurts most on 2–3 lane roads
  const park = parkCands.filter(L => A.parking.test(L.name)).sort((a, b) => b.lanes - a.lanes || polyLen(b.pts) - polyLen(a.pts))[0]
    || parkCands.sort((a, b) => b.lanes - a.lanes || polyLen(b.pts) - polyLen(a.pts))[0];
  const surge = pickExt(A.surge, true, false, (a, b) => b.demand - a.demand);
  const sigJ = nodes.filter(n => n.type === 'J').map(n => ({ n, deg: (insOf.get(n._v) || []).length })).sort((a, b) => b.deg - a.deg);
  const fault = sigJ.length ? sigJ[0].n.id : null;

  // labels: hospitals and metro stations inside the area
  const labels = pois.filter(p => p.p[0] > 30 && p.p[0] < W - 30 && p.p[1] > 30 && p.p[1] < H - 30)
    .filter((p, i, a) => a.findIndex(q => q.name === p.name) === i).slice(0, 10)
    .map(p => ({ kind: p.kind, text: p.name, x: +p.p[0].toFixed(0), y: +p.p[1].toFixed(0) }));
  if (hosp) labels.push({ kind: 'hospital', text: hosp.name, x: +hosp.p[0].toFixed(0), y: +hosp.p[1].toFixed(0), offmap: !(hosp.p[0] > 0 && hosp.p[0] < W && hosp.p[1] > 0 && hosp.p[1] < H) });

  // --- statistics, for the twin's "what's in this network" line
  const flyLinks = links.filter(L => L.layers && L.layers.some(l => l > 0));
  const tunLinks = links.filter(L => L.layers && L.layers.some(l => l < 0));
  const flyNames = new Set(flyLinks.map(L => L.name || L.id));
  const stats = {
    junctions: nodes.filter(n => n.type !== 'X').length,
    signalised: nodes.filter(n => n.type === 'J').length,
    osmSignals: nodes.filter(n => n.osmSignal).length,
    inferredSignals: nodes.filter(n => n.type === 'J' && !n.osmSignal && !n.surveySignal).length,
    surveySignals: nodes.filter(n => n.surveySignal).length,
    priority: nodes.filter(n => n.type === 'P').length,
    uturns: uturnNodes,
    slipRoads: links.filter(L => L.kind === 'slip' || (L._e.isLink)).length,
    flyoverLinks: flyLinks.length, flyovers: flyNames.size, underpassLinks: tunLinks.length,
    roundabouts: links.filter(L => L.roundabout).length,
    restrictions: restrApplied,
    entries: externals.filter(x => x.demand > 0 && od[x.id]).length,
    exits: externals.filter(x => x.outLanes).length,
    links: links.length,
    roadKm: +(links.reduce((s, L) => s + polyLen(L.pts), 0) / 1000).toFixed(1),
    osmWays: ways.length,
  };

  const net = {
    id, name: A.name, short: A.short, source: 'OpenStreetMap', license: '© OpenStreetMap contributors, ODbL', fetched: data.fetched || null,
    center: A.center, size: { w: W, h: H }, laneW: 3.4, median: 0.8,
    nodes: nodes.map(({ _v, nin, nout, spread, ...n }) => n),
    links: links.map(({ _e, ...L }) => L),
    turns, externals, od, labels, stats,
    inferCrossings: !!A.inferCrossings,
    survey: survey ? { on: survey.surveyedOn || null, by: survey.by || null, method: survey.method || null, checked: (survey.points || []).filter(s => s.signal === true || s.signal === false).length } : null,
    hooks: {
      ambulance: { origin: ambFrom.id, dest: ambTo.id, label: `${ambFrom.road || ambFrom.name} → ${hosp ? hosp.name : ambTo.name}`, hospital: hosp ? hosp.name : null },
      parking: park ? park.id : null, parkingName: park ? (park.name || park.id) : null,
      surge: { origin: surge.id, label: surge.name },
      fault,
      corridor: A.corridorIds ? corridorOf(externals, A.corridorIds)
        : { o: ambFrom.id, d: ambTo.id, label: `${ambFrom.road || ambFrom.name} → ${ambTo.road || ambTo.name}` },
    },
  };
  if (survey) Object.defineProperty(net, '_surveyLog', { value: surveyLog }); // printed, not written
  return net;
}

// A corridor fixed by entry and exit id (an area's `corridorIds`) instead of the ambulance route.
function corridorOf(externals, { o, d }) {
  const x = id => externals.find(e => e.id === id) || (() => { throw new Error(`corridorIds: no external ${id}`); })();
  return { o, d, label: `${x(o).road || x(o).name} → ${x(d).road || x(d).name}` };
}

function write(net) {
  const file = path.join(__dirname, '..', 'js', 'networks', `${net.id}.js`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = `/* ${net.name}: road network built from OpenStreetMap by tools/osm-import.js. ${net.license}. Fetched ${net.fetched}. */\n`
    + `(function (root) {\n  const N = ${JSON.stringify(net)};\n`
    + `  if (typeof module !== 'undefined' && module.exports) module.exports = N;\n`
    + `  else (root.SAARTHI_NETWORKS = root.SAARTHI_NETWORKS || {})[N.id] = N;\n`
    + `})(typeof window !== 'undefined' ? window : globalThis);\n`;
  fs.writeFileSync(file, body);
  return file;
}

(async () => {
  const args = process.argv.slice(2);
  const refresh = args.includes('--refresh');
  const ids = args.filter(a => !a.startsWith('--'));
  const list = !ids.length || ids.includes('all') ? Object.keys(AREAS) : ids;
  for (const id of list) {
    if (!AREAS[id]) { console.error(`unknown area ${id}; one of ${Object.keys(AREAS).join(', ')}`); process.exit(1); }
    const data = await load(id, refresh);
    const net = build(id, data);
    const file = write(net);
    console.log(`${net.name}: ${JSON.stringify(net.stats)}`);
    if (net._surveyLog) console.log(`  survey: ${net._surveyLog.added} signal(s) added, ${net._surveyLog.removed} removed${net._surveyLog.missed.length ? `; no mapped junction within 40 m of: ${net._surveyLog.missed.join('; ')}` : ''}`);
    console.log(`  hooks: ${JSON.stringify(net.hooks)}`);
    console.log(`  wrote ${path.relative(process.cwd(), file)} (${(fs.statSync(file).size / 1024).toFixed(0)} KB)`);
  }
})().catch(e => { console.error(e); process.exit(1); });
