/*
 * Project SAARTHI — corridor digital twin: simulation engine.
 * DOM-free so it runs in the browser and in Node (see tools/calibrate.js).
 *
 * Model: microscopic, agent-based. Vehicles follow an Intelligent Driver Model per lane,
 * stop at signals, cross a shared junction "box" and can get stuck in it when the exit
 * road is full (box-blocking) — which is how gridlock cascades emerge around the loop.
 * Indian-road friction: drivers differ in temperament and hesitate at random, slow down for turns
 * (v = √(a_lat·r)), some run fresh reds, buses dwell at kerbside stops and autos pull over for fares,
 * and two-wheelers ride two abreast and filter between lanes past crawling traffic.
 * Geometry is schematic: 1 logical px = 1 m along a road; lane widths are exaggerated.
 */
(function (root) {
  'use strict';

  const DT = 0.25;              // simulation step (s)
  const JR = 30;                // junction box radius (m)
  const LANE_W = 5.5;           // drawn lane width (px)
  const MEDIAN = 2;             // drawn median half-gap (px)
  const BOX_CAP_PCU = 14;       // traffic that fits inside one junction box at once
  const AMBER = 3, ALL_RED = 2; // inter-green (s)
  // Signal priority for an ambulance: a light changes for it within EV_REACH along its route. When the
  // controller is asked first, SAARTHI suggests each change at EV_ASK and an approved light changes at once
  // (up to EV_REACH_ASKED away), then holds green until it has crossed.
  const EV_REACH = 350, EV_ASK = 500, EV_REACH_ASKED = 600;
  const GROUP_R = 80;    // m: signalised points this close may be one crossing, run by one signal
  const OVR_MIN_GREEN = 5; // s: a manual switch never cuts the current green shorter than this
  const GROUP_SPAN = 70; // m: but one crossing is never wider than this (nearby crossings stay separate)
  // Points within `near` m of each other, grouped so that no group is wider than `span` (no chaining along a road).
  function clusterPoints(pts, near, span) {
    const G = pts.map(j => [j]), of = new Map(pts.map((j, i) => [j.id, G[i]]));
    const pairs = [];
    for (let a = 0; a < pts.length; a++) for (let b = a + 1; b < pts.length; b++) {
      const d = Math.hypot(pts[a].x - pts[b].x, pts[a].y - pts[b].y);
      if (d <= near) pairs.push([d, pts[a], pts[b]]);
    }
    pairs.sort((p, q) => p[0] - q[0]);
    for (const [, a, b] of pairs) {
      const ga = of.get(a.id), gb = of.get(b.id);
      if (ga === gb) continue;
      if (ga.some(x => gb.some(y => Math.hypot(x.x - y.x, x.y - y.y) > span))) continue;
      ga.push(...gb); gb.length = 0;
      for (const x of ga) of.set(x.id, ga);
    }
    return G.filter(g => g.length);
  }
  // Approaches of the same road from opposite directions share a green (the usual phasing of a divided-road
  // crossing); the rest go one at a time. partner[i] = the approach that runs with i, or -1.
  function pairApproaches(ap) {
    const GEN = /^(motorway|trunk|primary|secondary|tertiary) road /;
    const key = L => (L.name && !GEN.test(L.name) ? L.name : `${L.cls || 'road'}:${L.rank}`);
    const partner = ap.map(() => -1);
    for (let a = 0; a < ap.length; a++) for (let b = a + 1; b < ap.length; b++) {
      if (partner[a] >= 0 || partner[b] >= 0 || key(ap[a]) !== key(ap[b])) continue;
      let d = Math.abs(ap[a].bearing - ap[b].bearing) % (2 * Math.PI); if (d > Math.PI) d = 2 * Math.PI - d;
      if (Math.abs(d - Math.PI) < 0.6) { partner[a] = b; partner[b] = a; }
    }
    return partner.some(p => p >= 0) ? partner : null;
  }
  // the phase an approach belongs to: the lower index of a pair
  const canon = (j, i) => (j.partner && j.partner[i] >= 0 && j.partner[i] < i ? j.partner[i] : i);
  const greenFor = (j, i) => j.sig.phase === i || (!!j.partner && j.partner[j.sig.phase] === i);
  const MIN_GREEN = 15, MAX_GREEN = 60, MAX_RED = 100; // tuned in the twin: fewer, longer greens cut stops
  const WINDOW = 900;           // rolling KPI window (s)
  const METER_HEADWAY = 2.5;    // s between vehicles released at a metered entry
  const FILTER_START_V = 2;     // m/s: a two-wheeler starts filtering past a leader crawling slower than this…
  const FILTER_GAP = 8;         // …when it is within this many metres of it
  const FILTER_DV = 4;          // m/s faster than the traffic alongside that a filtering bike will go
  const FILTER_END_V = 5;       // m/s the traffic ahead must reach before a filtering bike rejoins the lane
  const LOOP_MAX_LINKS = 14;    // one-way loops up to this many roads…
  const LOOP_MAX_LEN = 1500;    // …and this long (m) work like a roundabout: circulating traffic first,
                                // joiners wait for space (e.g. both carriageways of Vishwakarma Rd, 1.1 km)
  const LOOP_XOVER_LEN = 60;    // m: a two-way road this short can be part of such a loop (a crossover)
  const DEADLOCK_T = 240;      // s a vehicle may sit stuck in a junction box on a real map before it is squeezed out
  const ZIP_V = 3;             // m/s: main-road traffic slower than this takes turns with a side road (zipper merge)
  const MERGE_EVERY = 10;      // s: SAARTHI re-picks which road goes first where a flyover slip gives way…
  const MERGE_HYST = 0.1;      // …switching only when the other road's queue is this much fuller (occupancy)
  const KEEP_CLEAR_V = 2;      // m/s: a full exit road whose tail moves faster than this doesn't hold drivers at the line
  const DETOUR_MAX = 1.5;      // a marshal only waves stuck vehicles onto a way round at most this much longer…
  const DETOUR_SLACK = 60;      // …plus this many seconds at free flow
  const BACKLOG_STALL = 10;  // s the off-map queue must stand still before moving again counts as a fresh stop
  const SAT_FLOW = 1800;        // veh/h/lane assumed by the fixed-time (Webster) plan
  const WARMUP = 600;           // s simulated before the clock is shown
  const CORRIDOR_CAP = 5400;   // veh/h the loop sustains under adaptive control (measured in the twin)
  const DETECT = 90;            // s for edge cameras to spot an unannounced closure
  const VMS_COMPLY = 0.7;       // share of drivers who follow VMS / navigation advice
  const VMS_ALT_GAIN = 0.8;     // real maps: the alternative route is signed only when it takes under 80% as long…
  const VMS_ALT_OCC = 0.5;      // …and no road on it is more than half full
  // Real maps leave out residential and sector roads, so a closure can leave a trip with no way through on the
  // mapped roads. Such a trip leaves the map and finishes on roads the twin doesn't model, paying a penalty:
  const DETOUR_AVOID = 300;     // s: the driver knew in advance (or read the VMS at the edge) and went round
  const DETOUR_TURNBACK = 600;  // s: the driver found out at the barricade and was turned back

  // ---------------------------------------------------------------- vehicles (IRC-106 PCUs)
  // alat: lateral acceleration a driver accepts in a turn (m/s²); dawdle: random hesitation, as a share of
  // `a` (SUMO's sigma); redRun: share of drivers who carry on through a fresh red rather than stop.
  const VTYPES = {
    car:   { label: 'Car',           len: 4.4, pcu: 1.0, vmax: 13.9, a: 2.0, s0: 1.6, T: 1.1, share: 0.40, fuel: 1.0,  alat: 2.5, dawdle: 0.15, redRun: 0.08 },
    tw:    { label: '2-wheeler',     len: 2.0, pcu: 0.5, vmax: 13.9, a: 2.6, s0: 1.0, T: 0.8, share: 0.30, fuel: 0.35, alat: 3.0, dawdle: 0.10, redRun: 0.25 },
    auto:  { label: 'Auto-rickshaw', len: 3.2, pcu: 1.2, vmax: 11.0, a: 1.6, s0: 1.3, T: 1.0, share: 0.10, fuel: 0.6,  alat: 1.8, dawdle: 0.25, redRun: 0.20 },
    erick: { label: 'E-rickshaw',    len: 2.8, pcu: 1.0, vmax: 7.0,  a: 1.2, s0: 1.3, T: 1.0, share: 0.05, fuel: 0,    alat: 1.5, dawdle: 0.30, redRun: 0.15 },
    bus:   { label: 'Bus',           len: 11,  pcu: 2.2, vmax: 11.0, a: 1.0, s0: 2.0, T: 1.4, share: 0.05, fuel: 3.5,  alat: 1.5, dawdle: 0.20, redRun: 0.10 },
    truck: { label: 'Truck / LCV',   len: 8,   pcu: 2.0, vmax: 11.0, a: 1.0, s0: 2.0, T: 1.4, share: 0.10, fuel: 3.0,  alat: 1.5, dawdle: 0.25, redRun: 0.05 },
    ev:    { label: 'Ambulance',     len: 5.5, pcu: 1.5, vmax: 16.7, a: 2.2, s0: 1.5, T: 0.9, share: 0,    fuel: 1.5,  alat: 3.0, dawdle: 0,    redRun: 0 },
    vip:   { label: 'VIP convoy',    len: 5.2, pcu: 1.5, vmax: 16.7, a: 2.2, s0: 2.5, T: 0.9, share: 0,    fuel: 1.5,  alat: 3.0, dawdle: 0,    redRun: 0 },
  };
  const BOX_VMAX = 11;          // m/s, fastest anyone crosses a junction box (straight on)
  const TURN_VMIN = 2.5;        // m/s, slowest turn (a tight U-turn)
  const BUS_DWELL = [20, 40];   // s at a kerbside bus stop (no bus bays)
  const PICKUP_DWELL = [6, 20]; // s for an auto / e-rickshaw stopping to pick up or drop a fare
  const PICKUP_P = 0.2;         // chance an auto / e-rickshaw stops on a given road
  const TYPE_KEYS = ['car', 'tw', 'auto', 'erick', 'bus', 'truck'];

  // ---------------------------------------------------------------- network (schematic)
  // Film City is drawn by hand as a four-junction loop. Real areas (Connaught Place, Sector 62…)
  // are built from OpenStreetMap by tools/osm-import.js and registered in SAARTHI_NETWORKS.
  const NETWORK = {
    id: 'fc', name: 'Film City loop, Noida (schematic)', short: 'Film City loop', schematic: true,
    size: { w: 1000, h: 640 },
    tidal: { am: ['DND', 'CHL'], pm: ['GNO', 'S18'] },
    capacity: CORRIDOR_CAP, // 88% of the ~6150 veh/h the adaptive twin tops out at under overload
    hooks: {
      ambulance: { origin: 'DND', dest: 'GNO', label: 'DND → Greater Noida' },
      parking: 'FC-03>FC-04', parkingName: 'Loop FC-03→FC-04',
      surge: { origin: 'S18', label: 'Sector 18 · DLF Mall' },
      fault: 'FC-03',
      corridor: { o: 'DND', d: 'GNO', label: 'DND → Greater Noida crossing' },
    },
    junctions: [
      { id: 'FC-01', name: 'DND–Chilla / Mahamaya',   corner: 'NW', x: 300, y: 190 },
      { id: 'FC-03', name: 'Munshi Premchand Marg',   corner: 'E',  x: 720, y: 205 },
      { id: 'FC-04', name: 'Dadri Main Rd loop',      corner: 'S',  x: 705, y: 470 },
      { id: 'FC-02', name: 'Dadri Main Rd / Slip Rd', corner: 'W',  x: 285, y: 465 },
    ],
    // demand = base inflow (veh/h) at a profile multiplier of 1.0
    externals: [
      { id: 'DND', name: 'DND Flyway · Delhi',     j: 'FC-01', x: 30,  y: 105, lanes: 4, demand: 1520 },
      { id: 'CHL', name: 'Chilla Elevated Rd',     j: 'FC-01', x: 345, y: 18,  lanes: 3, demand: 640 },
      { id: 'EXP', name: 'Expressway feeder',      j: 'FC-02', x: 30,  y: 610, lanes: 3, demand: 880 },
      { id: 'S18', name: 'Sector 18 · DLF Mall',   j: 'FC-03', x: 970, y: 100, lanes: 3, demand: 880 },
      { id: 'GNO', name: 'Greater Noida exchange', j: 'FC-04', x: 970, y: 615, lanes: 3, demand: 960 },
    ],
    ring: ['FC-01', 'FC-03', 'FC-04', 'FC-02'], // clockwise on screen
    ringLanes: 3,
    od: {
      DND: { CHL: 0.05, EXP: 0.25, S18: 0.30, GNO: 0.40 },
      CHL: { DND: 0.05, EXP: 0.25, S18: 0.30, GNO: 0.40 },
      EXP: { DND: 0.35, CHL: 0.15, S18: 0.30, GNO: 0.20 },
      S18: { DND: 0.35, CHL: 0.15, EXP: 0.25, GNO: 0.25 },
      GNO: { DND: 0.35, CHL: 0.15, EXP: 0.20, S18: 0.30 },
    },
  };

  // Daily demand profile (hour → multiplier), with morning and evening peaks. Midday (12:00–13:00 at 0.95)
  // is calibrated to Google Maps 1 PM typical times on all three real corridors (it was 0.7, which put the
  // twin at or below the fast end of Google's range everywhere).
  const PROFILE = [[0, 0.15], [5, 0.25], [7, 0.7], [8, 1.0], [9, 1.15], [10, 1.0], [11, 0.75], [12, 0.95], [13, 0.95],
    [14, 0.85], [15, 0.75], [17, 0.95], [18, 1.15], [19, 1.2], [20, 0.95], [21, 0.65], [23, 0.3], [24, 0.15]];

  // ---------------------------------------------------------------- helpers
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function profileAt(h) {
    for (let i = 1; i < PROFILE.length; i++) {
      const [h0, v0] = PROFILE[i - 1], [h1, v1] = PROFILE[i];
      if (h <= h1) return v0 + (v1 - v0) * (h - h0) / (h1 - h0);
    }
    return PROFILE[0][1];
  }

  // 1 inside [a, b], ramping linearly over `ramp` either side (hours by default: 30 min).
  function window01(h, a, b, ramp = 0.5) {
    if (h < a - ramp || h > b + ramp) return 0;
    if (h < a) return (h - (a - ramp)) / ramp;
    if (h > b) return (b + ramp - h) / ramp;
    return 1;
  }

  function compass(dx, dy) { // screen vector (y down) → bearing label
    const ang = (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360;
    return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(ang / 45) % 8];
  }

  // Position on a link's reference line at distance s (links are polylines; the schematic loop's are
  // straight). Beyond either end it extrapolates along the first / last segment.
  const FR = [0, 0, 0, 0];
  function frameAt(L, s) {
    const c = L.cum, n = c.length - 1;
    let i = 0;
    if (n > 1) {
      if (s >= c[n - 1]) i = n - 1;
      else if (s > 0) { let lo = 0, hi = n - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (c[m] <= s) lo = m; else hi = m - 1; } i = lo; }
    }
    const p = L.pts[i], ux = L.su[i], uy = L.sv[i], d = s - c[i];
    FR[0] = p[0] + ux * d; FR[1] = p[1] + uy * d; FR[2] = ux; FR[3] = uy;
    return FR;
  }

  // Sideways position of a vehicle within its lane, in lane widths (+ towards the kerb): two-wheelers ride
  // in one half of the lane, or on the lane line towards the median while filtering.
  function sideOffset(veh) { return veh.type !== 'tw' ? 0 : veh.filter ? -0.5 : veh.half ? -0.22 : 0.22; }

  function laneOffset(L, lane) { return L.base + (L.lanes - lane - 0.5) * L.lw; }

  function lanePoint(L, lane, s) { // lane 0 = kerb side (India drives on the left)
    const f = frameAt(L, s), off = laneOffset(L, lane);
    return [f[0] + f[3] * off, f[1] - f[2] * off];
  }

  function polyLen(pts) { let s = 0; for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); return s; }

  // The part of polyline `pts` between arc lengths s0 and s1.
  function slicePolyline(pts, s0, s1) {
    const out = [];
    let acc = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], d = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const at = t => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      if (d > 0) {
        if (!out.length && acc + d >= s0) out.push(at((s0 - acc) / d));
        if (out.length) {
          if (acc + d >= s1) { out.push(at((s1 - acc) / d)); return out; }
          out.push(b);
        }
      }
      acc += d;
    }
    if (out.length < 2) out.push(pts[pts.length - 1]);
    return out;
  }

  function networkById(id) {
    if (!id || id === 'fc') return NETWORK;
    if (typeof id === 'object') return id;
    const reg = (typeof window !== 'undefined' && window.SAARTHI_NETWORKS) || globalThis.SAARTHI_NETWORKS || {};
    if (reg[id]) return reg[id];
    if (typeof require === 'function') return require(`./networks/${id}.js`);
    throw new Error(`unknown network ${id}`);
  }

  class MinHeap { // [key, value] pairs, smallest key first
    constructor() { this.a = []; }
    push(k, v) {
      const a = this.a; a.push([k, v]);
      let i = a.length - 1;
      while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; }
    }
    pop() {
      const a = this.a, top = a[0], last = a.pop();
      if (a.length) {
        a[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1;
          let m = i;
          if (l < a.length && a[l][0] < a[m][0]) m = l;
          if (r < a.length && a[r][0] < a[m][0]) m = r;
          if (m === i) break;
          [a[m], a[i]] = [a[i], a[m]]; i = m;
        }
      }
      return top;
    }
    get size() { return this.a.length; }
  }

  function bezPoint(p0, p1, p2, u) {
    const a = (1 - u) * (1 - u), b = 2 * (1 - u) * u, c = u * u;
    return [a * p0[0] + b * p1[0] + c * p2[0], a * p0[1] + b * p1[1] + c * p2[1]];
  }

  function bezTangent(p0, p1, p2, u) {
    const x = 2 * (1 - u) * (p1[0] - p0[0]) + 2 * u * (p2[0] - p1[0]);
    const y = 2 * (1 - u) * (p1[1] - p0[1]) + 2 * u * (p2[1] - p1[1]);
    const d = Math.hypot(x, y) || 1;
    return [x / d, y / d];
  }

  function bezLen(p0, p1, p2) {
    const d01 = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
    const d12 = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const d02 = Math.hypot(p2[0] - p0[0], p2[1] - p0[1]);
    return Math.max(4, (d01 + d12 + d02) / 2);
  }

  function idm(veh, vDes, gap, dv) {
    if (gap === Infinity) return Math.max(-9, veh.a * (1 - Math.pow(veh.v / Math.max(vDes, 0.1), 4)));
    const sStar = veh.s0 + Math.max(0, veh.v * veh.T + veh.v * dv / (2 * Math.sqrt(veh.a * veh.b)));
    const r = sStar / Math.max(gap, 0.05);
    return Math.max(-9, veh.a * (1 - Math.pow(veh.v / Math.max(vDes, 0.1), 4) - r * r));
  }

  function hash01(a, b) { // deterministic 0..1 from two integers (same answer in both twins)
    let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35);
    h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
    h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; }

  function quantile(sorted, q) {
    if (!sorted.length) return null;
    const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
  }

  function fmtClock(t) {
    const s = Math.floor(((t % 86400) + 86400) % 86400);
    const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = s % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }

  function fmtDur(s) {
    if (s == null) return '—';
    s = Math.round(s);
    return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
  }

  // ---------------------------------------------------------------- signal controllers
  function fixedDecide(sim, j) {
    const va = sim.vipApproach(j); // traffic police hold cross traffic for a VIP convoy, timers or not
    if (va >= 0) return va === j.sig.phase || j.sig.t < 4 ? null : { next: va, reason: 'vip' };
    if (j.sig.t >= j.plan[j.sig.phase]) {
      const n = j.approaches.length, cur = canon(j, j.sig.phase);
      let k = (cur + 1) % n;
      while (k !== cur && canon(j, k) !== k) k = (k + 1) % n; // a paired approach runs with its partner
      return { next: k, reason: 'plan' };
    }
    return null;
  }

  // SAARTHI control brain. A pressure-based, spillback-aware scheduler with platoon look-ahead —
  // a deterministic stand-in for the MARL policy (and the same shape as its Surtrac-style safety
  // fallback). Hard constraints: min/max green, inter-green, anti-starvation cap.
  function adaptiveDecide(sim, j) {
    const sig = j.sig, cur = sig.phase, n = j.approaches.length;

    if (j.faultUntil > sim.t) {
      if (!j.faultLogged) {
        j.faultLogged = true;
        sim.addLog(`${sim.jName(j)}: camera view degraded → safety floor: fallback to fixed plan`, 'fallback', j.id);
      }
      return fixedDecide(sim, j);
    }

    // Smart signal priority: the signal ahead of an ambulance (or a VIP convoy) turns green before it arrives.
    const ea = sim.features.signalPriority ? sim.evApproach(j) : sim.vipApproach(j);
    if (ea >= 0) {
      if (canon(j, ea) === canon(j, cur)) { // already green for it: kept green
        j.evKeep = { t: sim.t, i: ea };
        const m = sim.evMatch, ev = m && m.ev.story ? m.ev : null;
        if (ev && j.evKeepFor !== ev.id) { j.evKeepFor = ev.id; sim.tell(ev, `Light at ${sim.jName(j)} already green for it: SAARTHI keeps it green until it has crossed (${sim.distTxt(m.d)})`, 'light'); }
        return null;
      }
      if (sig.t >= 4) {
        const who = sim.evs.some(e => e.vip && e.link === j.approaches[ea]) ? 'VIP convoy' : 'ambulance';
        return { next: ea, reason: 'ev', log: `${sim.jName(j)} ▸ signal priority: green for ${who} on ${j.approaches[ea].name}`, kind: who === 'ambulance' ? 'ev' : 'vip' };
      }
      return null;
    }

    // An inferred (unconfirmed) signal: its real layout and phasing are not known, so SAARTHI does not optimise it
    // and runs the fixed plan; ambulance and VIP priority above still apply. A signal survey makes it adaptive.
    if (j.inferredCtl) return fixedDecide(sim, j);

    if (sig.t < MIN_GREEN) return null;

    let P = j.approaches.map((_, i) => sim.pressure(j, i));
    if (j.partner) P = P.map((x, i) => {
      const k = j.partner[i];
      if (k < 0) return x;
      if (k < i) return { p: -1, queue: 0, risk: 0, gapOut: false, arriving: 0 }; // served with its partner
      const y = P[k];
      return { p: x.p + y.p, queue: x.queue + y.queue, risk: Math.max(x.risk, y.risk), gapOut: x.gapOut || y.gapOut, arriving: x.arriving + y.arriving };
    });
    const same = i => canon(j, i) === canon(j, cur);
    let best = -1, bestP = 0;
    for (let i = 0; i < n; i++) if (!same(i) && P[i].p > bestP) { bestP = P[i].p; best = i; }

    for (let i = 0; i < n; i++) {
      if (!same(i) && P[i].queue > 0.5 && sim.redTime(j, i) > MAX_RED) {
        return { next: i, reason: 'starve', log: `${sim.jName(j)} ▸ anti-starvation: serving ${j.approaches[i].name} after ${MAX_RED}s red`, kind: 'decision' };
      }
    }
    if (best < 0) return null;
    if (sig.t >= MAX_GREEN) return { next: best, reason: 'max' };

    const c = P[canon(j, cur)];
    const spill = c.risk >= 0.5;
    const spillLog = spill && sim.t - (j.lastSpillLog || -1e9) > 90 && (j.lastSpillLog = sim.t)
      ? `${sim.jName(j)} ▸ cutting ${j.approaches[cur].name}: exit road ${Math.round(c.risk * 100)}% blocked → serving ${j.approaches[best].name}`
      : null;
    const active = c.queue * (1 - c.risk) > 0.3 || c.gapOut;
    if (!active) return { next: best, reason: spill ? 'spill' : 'gap', log: spillLog, kind: 'decision' };
    if (sig.t >= 20 && bestP > 2.0 * c.p + 2) return { next: best, reason: spill ? 'spill' : 'demand', log: spillLog, kind: 'decision' };
    return null;
  }

  // ---------------------------------------------------------------- simulation
  class Sim {
    constructor(opts) {
      this.mode = opts.mode; // 'fixed' | 'adaptive'
      this.features = Object.assign({ greenCorridor: true, signalPriority: true, metering: true, vms: true, enforcement: true, shaping: true, mergeControl: true }, opts.features || {});
      this.net = networkById(opts.network);
      this.hooks = this.net.hooks;
      // Control-room mode (the console): camera alerts go to the controller, who sends the marshal; without
      // one, a marshal on the ground notices after 3 min as with no cameras.
      this.controllerMarshals = !!opts.controllerMarshals;
      // Signal priority as a suggestion: SAARTHI proposes the light changes on an ambulance's route and the
      // controller approves them; only approved junctions change for it.
      this.priorityApproval = !!opts.priorityApproval;
      this.autoApprove = false;    // controller's standing choice: SAARTHI changes the lights without asking
      this.newSuggestion = false;  // set when a suggestion is raised; the page clears it
      this.ring = this.net.ring || null;
      const seed = (opts.seed >>> 0) || 1;
      this.rngDemand = mulberry32(seed);              // identical across twins → identical arrivals
      this.rngRoute = mulberry32(seed ^ 0x9e3779b9);
      this.rngBehav = mulberry32(seed ^ 0x85ebca6b);
      this.rngPlan = mulberry32(seed ^ 0x27d4eb2f);
      this.rngDriver = mulberry32(seed ^ 0x165667b1); // driver traits: one draw per vehicle, identical across twins
      this.rngNoise = mulberry32(seed ^ 0xd3a2646c);  // moment-to-moment hesitation
      this.rngVenue = mulberry32(seed ^ 0x6c8e9cf5);  // a crowd leaving a venue (what-if events), kept apart from everyday arrivals
      this.turnR = new Map();                          // turn radius per movement (cached)
      this.demandMult = opts.demandMult || 1;
      this.t = (opts.startHour != null ? opts.startHour : 8) * 3600 - (opts.warmup ? WARMUP : 0);
      this.stepN = 0;
      this.nextId = 1;
      this.trips = []; this.crossings = []; this.series = []; this.log = []; this.eventLog = [];
      this.surges = []; this.evs = []; this.deferred = [];
      this.closures = []; this.laneRules = []; this.convoys = []; this.demandEvents = []; this.incidents = []; this.sources = [];
      this.activeClosures = 0; this.awareness = 0; this.announceAt = Infinity;
      this.shapingActive = false;
      this.t0 = this.t;
      this.resetStats();
      this.build();
      if (opts.scenario) this.loadScenario(opts.scenario);
      // Warm-up fills the empty network; its trips stay in the rolling window, counters restart.
      if (opts.warmup) { this.quiet = true; for (let i = 0; i < WARMUP / DT; i++) this.step(); this.quiet = false; }
      this.resetStats();
      this.sample();
    }

    resetStats() {
      this.stats = { completed: 0, diverted: 0, gridlockEvents: 0, gridlockSeconds: 0, evTrips: [], nudged: 0,
        vipTrips: [], turnedBack: 0, rerouted: 0, squeezed: 0, avoided: 0, stranded: 0 };
    }

    // -------------------------------------------------------------- planned disruptions (what-if)
    // A scenario is what the city knows is coming (protest closures, VIP convoys and reserved lanes,
    // event parking, demand changes) plus how far the plan reaches drivers before they leave:
    //   { closures: [{ links, from, until, label }], lanes: [{ links, from, until, use: 'vip'|'closed', label }],
    //     convoys: [{ at, origin, dest, dir, size, label }], demand: [{ from, until, factor, origins, label }],
    //     incidents: [{ at, link, lane, label }], venues: [{ links, from, until, rate, label }],
    //     awareness: 0..1, announceAt, preloaded }
    // Times are hours of the day. `preloaded` means the control room had the plan in advance;
    // otherwise SAARTHI only learns of a closure when its cameras see it. A venue (real maps) is a crowd
    // leaving a place inside the map: `rate` vehicles/h join the start of its `links` between `from` and `until`.
    // A closure with `soft: true` is advice only (a crash or crowd the control room asks drivers to avoid): the road
    // stays open, nobody is turned back, but drivers who get the advice route round it once it is sent (knownAt).
    loadScenario(sc) {
      const sec = h => h * 3600;
      this.scenario = sc;
      this.awareness = sc.awareness || 0;
      this.announceAt = sc.announceAt != null ? sec(sc.announceAt) : -Infinity;
      this.closures = (sc.closures || []).map(c => ({ ids: c.links, from: sec(c.from), until: sec(c.until), label: c.label || 'Closure',
        knownAt: sc.preloaded ? -Infinity : sec(c.from) + DETECT, on: false, detectLogged: false }));
      this.laneRules = (sc.lanes || []).map(r => ({ ids: r.links, from: sec(r.from), until: sec(r.until), use: r.use, label: r.label, on: false }));
      this.convoys = (sc.convoys || []).map(c => Object.assign({}, c, { at: sec(c.at) })).sort((a, b) => a.at - b.at);
      this.demandEvents = (sc.demand || []).map(d => Object.assign({}, d, { from: sec(d.from), until: sec(d.until) }));
      this.incidents = (sc.incidents || []).map(d => Object.assign({}, d, { at: sec(d.at) })).sort((a, b) => a.at - b.at);
      this.sources = [];
      for (const v of sc.venues || []) {
        const links = v.links.map(id => this.links[id]);
        for (const L of links) this.addSource(L, v.label, sec(v.from), sec(v.until), v.rate / links.length);
      }
    }

    // Control console: a planned scenario added to a twin that is already running (loadScenario replaces).
    // Its hours are of the day the plan is for; `off` (s) places that day on this twin's clock. Returns a
    // handle for removeScenario. The disturbance test (incidents) is a planning check, not scheduled.
    addScenario(sc, off) {
      const sec = h => h * 3600 + off, H = { closures: [], lanes: [], convoys: [], demand: [], sources: [] };
      for (const c of sc.closures || []) {
        const o = { ids: c.links, from: sec(c.from), until: sec(c.until), label: c.label || 'Closure', where: c.where || this.roadsName(c.links),
          knownAt: sc.preloaded ? -Infinity : sec(c.from) + DETECT, on: false, detectLogged: false, planned: true };
        this.closures.push(o); H.closures.push(o);
      }
      for (const r of sc.lanes || []) {
        const o = { ids: r.links, from: sec(r.from), until: sec(r.until), use: r.use, label: r.label, where: r.where || this.roadsName(r.links), on: false, planned: true };
        this.laneRules.push(o); H.lanes.push(o);
      }
      for (const c of sc.convoys || []) { const o = Object.assign({}, c, { at: sec(c.at) }); this.convoys.push(o); H.convoys.push(o); }
      this.convoys.sort((a, b) => a.at - b.at);
      for (const d of sc.demand || []) { const o = Object.assign({}, d, { from: sec(d.from), until: sec(d.until) }); this.demandEvents.push(o); H.demand.push(o); }
      for (const v of sc.venues || []) {
        const links = v.links.map(id => this.links[id]), n0 = this.sources.length;
        for (const L of links) this.addSource(L, v.label, sec(v.from), sec(v.until), v.rate / links.length);
        H.sources.push(...this.sources.slice(n0));
      }
      if (sc.awareness) { // drivers told in advance, from the announcement on
        this.awareness = Math.max(this.awareness, sc.awareness);
        this.announceAt = Math.min(this.announceAt, sc.announceAt != null ? sec(sc.announceAt) : -Infinity);
      }
      return H;
    }
    removeScenario(H) {
      const drop = (arr, xs) => arr.filter(o => !xs.includes(o));
      for (const c of H.closures) if (c.on && !c.soft) this.addLog(`${c.label} called off: ${(c.where || this.segName(c.ids))} reopened`, 'info');
      this.closures = drop(this.closures, H.closures);
      this.laneRules = drop(this.laneRules, H.lanes);
      this.convoys = drop(this.convoys, H.convoys);
      this.demandEvents = drop(this.demandEvents, H.demand);
      for (const s of H.sources) s.until = Math.min(s.until, this.t); // stop the crowd; vehicles already queued still leave
      for (const L of this.linkList) { L.closed = null; L.rule = null; } // as updatePlan, for what is left
      this.activeClosures = 0;
      for (const c of this.closures) if (c.on) { this.activeClosures++; for (const id of c.ids) this.links[id].closed = c; }
      for (const r of this.laneRules) if (r.on) for (const id of r.ids) {
        const L = this.links[id];
        L.rule = { lane: r.use === 'vip' ? L.lanes - 1 - (L.gc != null ? 1 : 0) : 0, use: r.use, label: r.label };
      }
    }

    // A crowd leaving a venue joins the road at the start of link L, like an entry inside the map. Its
    // destinations are the exits, weighted by how much of the area's traffic heads for each.
    addSource(L, label, from, until, rate) {
      const pull = {};
      for (const x of this.externals) for (const [d, sh] of Object.entries(this.net.od[x.id] || {})) pull[d] = (pull[d] || 0) + x.demand * sh;
      const dests = Object.entries(pull).filter(([d, w]) => w > 0 && this.shortest(L.id, d, M => M.length));
      if (!dests.length) return;
      const tot = dests.reduce((s, [, w]) => s + w, 0);
      const s = { id: `V${this.sources.length + 1}`, type: 'V', name: label, entry: L, j: L.to, lanes: this.generalLanes(L), x: L.ax, y: L.ay,
        backlog: [], lastRelease: -1e9, stallT: 0, metered: false, meterLogT: -1e9, demand: 0, from, until, rate,
        dests: dests.map(([d, w]) => [d, w / tot]) };
      this.nodes[s.id] = s;
      this.sources.push(s);
    }

    // A junction as a controller would say it: its id and name on the schematic loop; on a real map OSM's
    // name, else the named roads that meet there, else the nearest named road.
    jName(j) {
      if (j._label) return j._label;
      const GEN = /^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|service) road\b|^unnamed/i;
      let s;
      if (this.ring || this.net.schematic) s = `${j.id} (${j.name})`;
      else if (j.name && !/unnamed|^junction\b|^J\d/i.test(j.name) && j.name !== j.id) s = j.name;
      else {
        const ns = [...new Set((j.ins || []).concat(j.outs || []).map(L => L.name).filter(n => n && !GEN.test(n)))];
        if (ns.length > 1) s = `${ns[0]} / ${ns[1]} junction`;
        else if (ns.length) s = `junction on ${ns[0]}`;
        else {
          let near = null;
          for (const L of this.linkList) {
            if (!L.name || GEN.test(L.name) || L.kind === 'entry' || L.kind === 'exit') continue;
            const d = Math.min(...L.pts.map(p => Math.hypot(p[0] - j.x, p[1] - j.y)));
            if (!near || d < near.d) near = { d, name: L.name };
          }
          s = near ? `junction ${Math.round(near.d / 10) * 10} m off ${near.name}` : `junction ${j.id}`;
        }
      }
      return (j._label = s);
    }

    // The named roads a set of links is on (for log lines about planned closures and lanes).
    roadsName(ids) {
      const GEN = /^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|service) road/i, ns = [];
      for (const id of ids) { const n = this.links[id] && this.links[id].name; if (n && !GEN.test(n) && !ns.includes(n)) ns.push(n); }
      return ns.length ? ns.slice(0, 2).join(' and ') + (ns.length > 2 ? ' and nearby roads' : '') : undefined;
    }

    segName(ids) {
      const seen = new Set(), out = [];
      for (const id of ids) {
        const [a, b] = id.split('~')[0].split('>'), key = [a, b].sort().join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(ids.includes(`${b}>${a}`) ? `${a}↔${b}` : `${a}→${b}`);
      }
      return out.join(', ');
    }

    updatePlan() {
      let changed = false;
      for (const c of this.closures) {
        const on = this.t >= c.from && this.t < c.until;
        if (on !== c.on) {
          c.on = on; changed = true;
          if (!c.soft) this.addLog(on ? `${c.label}: ${(c.where || this.segName(c.ids))} closed, barricades up` : `${c.label} over: ${(c.where || this.segName(c.ids))} reopened`, on ? 'alert' : 'info');
          if (on && !c.soft && this.mode === 'adaptive' && c.knownAt < this.t) this.addLog(`Pre-loaded plan live: VMS and navigation apps divert traffic away from ${(c.where || this.segName(c.ids))}`, 'plan');
        }
        if (on && !c.soft && !c.detectLogged && this.mode === 'adaptive' && c.knownAt > c.from && this.t >= c.knownAt) {
          c.detectLogged = true;
          this.addLog(`Cameras detected an unannounced closure on ${(c.where || this.segName(c.ids))} → diversion published on VMS`, 'plan');
        }
      }
      for (const r of this.laneRules) {
        const on = this.t >= r.from && this.t < r.until;
        if (on !== r.on) {
          r.on = on; changed = true;
          this.addLog(on ? `${r.label}: ${r.use === 'vip' ? 'median lane reserved for VIP convoys' : 'kerb lane lost'} on ${(r.where || this.segName(r.ids))}`
            : `${r.label} over: all lanes open on ${(r.where || this.segName(r.ids))}`, r.use === 'vip' ? 'vip' : 'info');
        }
      }
      if (changed) {
        for (const L of this.linkList) { L.closed = null; L.rule = null; }
        this.activeClosures = 0;
        for (const c of this.closures) if (c.on) { this.activeClosures++; for (const id of c.ids) this.links[id].closed = c; }
        for (const r of this.laneRules) if (r.on) for (const id of r.ids) {
          const L = this.links[id];
          L.rule = { lane: r.use === 'vip' ? L.lanes - 1 - (L.gc != null ? 1 : 0) : 0, use: r.use, label: r.label }; // median lane for VIPs (inside the green corridor), kerb lane otherwise
        }
      }
      while (this.convoys.length && this.convoys[0].at <= this.t) this.dispatchConvoy(this.convoys.shift());
      while (this.incidents.length && this.incidents[0].at <= this.t) {
        const d = this.incidents.shift();
        this.triggerBlockage(d.link, d.label, d.lane);
      }
    }

    dispatchConvoy(c) {
      const x = this.nodes[c.origin];
      const opts = this.routeOptions(c.origin, c.dest);
      const route = opts.find(r => r.dir === (c.dir || 1)) || opts[0];
      const vehs = [];
      for (let i = 0; i < (c.size || 3); i++) {
        const v = this.newVehicle(c.origin, c.dest, 'vip', 0, true, route);
        v.vip = true; v.lead = i === 0; v.convoy = c.label || 'VIP convoy';
        vehs.push(v);
        this.evs.push(v);
      }
      x.backlog.unshift(...vehs);
      this.addLog(`${vehs[0].convoy} departs ${x.name} → ${this.nodes[c.dest].name}`, 'vip');
    }

    // The lane an ambulance uses on L: the built green corridor lane, or the median lane cleared for it on demand.
    gcOf(L) { return L.gc != null ? L.gc : L.evLane; }
    laneOk(L, i, veh) {
      if (L.gc === i || L.evLane === i) return !!veh && veh.type === 'ev'; // green corridor lane: emergency vehicles only
      const r = L.rule;
      return !r || r.lane !== i || (r.use === 'vip' && !!veh && !!veh.vip);
    }

    // Will any link of route r be closed within `horizon` s? (what an informed driver plans around)
    routeOpen(r, horizon) {
      for (const c of this.closures) {
        if (c.from > this.t + horizon || c.until <= this.t) continue;
        if (c.knownAt === Infinity) continue; // a console closure not yet announced: nobody knows of it
        if (r.ids.some(id => c.ids.includes(id))) return false;
      }
      return true;
    }

    // Barricades and diversions. A driver about to take a closed road is turned back at the junction;
    // a driver who knows about a closure further on (advance notice, or VMS once the control room
    // knows) takes the other way round the loop from here. On a real map, a driver turned back with no
    // way through on the mapped roads returns 'stranded': the caller takes the vehicle off the road.
    divertAt(veh, j) {
      if (!this.activeClosures || veh.vip || j.type === 'X') return;
      let ahead = null;
      for (let k = veh.ri + 1; k < veh.route.length && !ahead; k++) ahead = this.links[veh.route[k]].closed;
      if (!ahead) return;
      const nx = this.links[veh.route[veh.ri + 1]].closed, forced = !!nx && !nx.soft;
      if (!forced && veh.isEV) return; // advice is for general traffic
      if (!forced && !veh.informed) {
        if (this.mode !== 'adaptive' || !this.features.vms || this.t < ahead.knownAt) return;
        if (veh.vmsComply == null) veh.vmsComply = this.rngPlan() < VMS_COMPLY;
        if (!veh.vmsComply) return;
      }
      if (!this.ring) { // real network: shortest open path from here
        const ids = this.shortest(veh.route[veh.ri], veh.dest, L => (L.closed ? Infinity : L.length / Math.max(L.meanSpeed, 1)));
        if (!ids) return forced && !veh.isEV ? 'stranded' : undefined;
        veh.route = veh.route.slice(0, veh.ri).concat(ids);
        if (forced) { this.stats.turnedBack++; veh.turnedBack = true; nx.turnedBack = (nx.turnedBack || 0) + 1; } else { this.stats.rerouted++; ahead.followed = (ahead.followed || 0) + 1; }
        return;
      }
      const jd = this.nodes[veh.dest].j;
      let best = null;
      for (const dir of [1, -1]) {
        const path = this.ringPath(j.id, jd, dir), ids = [];
        for (let i = 0; i + 1 < path.length; i++) ids.push(path[i] + '>' + path[i + 1]);
        ids.push(jd + '>' + veh.dest);
        if (ids.some(id => this.links[id].closed)) continue;
        const tt = ids.reduce((s, id) => s + this.links[id].length / Math.max(this.links[id].meanSpeed, 1), 0);
        if (!best || tt < best.tt) best = { ids, tt };
        if (jd === j.id) break;
      }
      if (!best) return;
      veh.route = veh.route.slice(0, veh.ri + 1).concat(best.ids);
      if (forced) { this.stats.turnedBack++; veh.turnedBack = true; nx.turnedBack = (nx.turnedBack || 0) + 1; } else { this.stats.rerouted++; ahead.followed = (ahead.followed || 0) + 1; }
    }

    // -------------------------------------------------------------- build
    build() {
      const net = this.net;
      this.nodes = {}; this.links = {}; this.linkList = [];
      this.lw = net.laneW || LANE_W;
      this.median = net.median != null ? net.median : MEDIAN;
      const isect = (d, type, r) => Object.assign({ type, r, ins: [], outs: [], box: [], boxPcu: 0, boxBlocked: false, blockedT: 0,
        inGridlock: false, faultUntil: -1, faultLogged: false, evHold: -1, sig: null, lastIn: null, approaches: [], free: [], plan: [], level: 0 }, d);
      const external = d => Object.assign({ type: 'X', r: 0, backlog: [], lastRelease: -1e9, stallT: 0, metered: false, meterLogT: -1e9, entry: null, exit: null, demand: 0 }, d);
      if (this.ring) { // the hand-drawn Film City loop
        for (const d of net.junctions) this.nodes[d.id] = isect(d, 'J', JR);
        for (const d of net.externals) this.nodes[d.id] = external(d);
        const R = this.ring;
        for (let i = 0; i < R.length; i++) {
          const a = R[i], b = R[(i + 1) % R.length];
          this.makeLink({ from: a, to: b, lanes: net.ringLanes, vmax: 13.9, kind: 'ring' });
          this.makeLink({ from: b, to: a, lanes: net.ringLanes, vmax: 13.9, kind: 'ring' });
        }
        for (const d of net.externals) {
          const x = this.nodes[d.id];
          x.entry = this.makeLink({ from: x.id, to: x.j, lanes: x.lanes, vmax: 16.7, kind: 'entry' });
          x.exit = this.makeLink({ from: x.j, to: x.id, lanes: x.lanes, vmax: 16.7, kind: 'exit' });
        }
      } else { // a real network built from OpenStreetMap
        const ext = Object.fromEntries(net.externals.map(x => [x.id, x]));
        for (const n of net.nodes) {
          if (n.type === 'X') this.nodes[n.id] = external(Object.assign({}, n, ext[n.id] || {}, { x: n.x, y: n.y }));
          else this.nodes[n.id] = isect(n, n.type, n.r);
        }
        for (const s of net.links) {
          const L = this.makeLink(s);
          if (L.kind === 'entry') { const x = this.nodes[L.from]; x.entry = L; x.j = L.to; x.lanes = L.lanes; }
          if (L.kind === 'exit') this.nodes[L.to].exit = L;
        }
        for (const x of Object.values(this.nodes)) if (x.type === 'X' && (!x.entry || !net.od[x.id])) x.demand = 0;
      }
      this.externals = Object.values(this.nodes).filter(n => n.type === 'X');
      this.isects = Object.values(this.nodes).filter(n => n.type !== 'X');

      // movements allowed at each junction (incoming link → outgoing links) and which are U-turns
      this.moves = {};
      this.uturns = new Set();
      for (const j of this.isects) {
        const tbl = net.turns && net.turns[j.id];
        for (const L of j.ins) {
          const outs = tbl ? (tbl[L.id] || []).map(id => this.links[id]).filter(Boolean) : j.outs.filter(O => O.to !== L.from);
          this.moves[L.id] = outs;
          for (const O of outs) if (L.eu * O.su[0] + L.ev * O.sv[0] < -0.85) this.uturns.add(L.id + '|' + O.id);
        }
        j.level = j.ins.concat(j.outs).every(L => L.level > 0) ? 1 : 0;
      }
      // Circulating roads (roundabouts, and short one-way loops that work like one) have priority over
      // traffic entering them, as on any roundabout.
      if (!this.ring) {
        // A short two-way crossover between two one-way carriageways (e.g. the DME service roads at
        // Sector 62) still closes the loop.
        const loopable = L => L.oneway || L.length <= LOOP_XOVER_LEN;
        for (const L of this.linkList) {
          if (L.kind === 'entry' || L.kind === 'exit' || L.roundabout || !loopable(L)) continue;
          const stack = [[L, 0, 0]];
          let found = false;
          while (stack.length && !found) {
            const [M, depth, len] = stack.pop();
            for (const O of this.moves[M.id] || []) {
              if (!loopable(O) || this.uturns.has(M.id + '|' + O.id)) continue;
              if (O === L) { found = true; break; }
              if (depth < LOOP_MAX_LINKS && len + O.length < LOOP_MAX_LEN) stack.push([O, depth + 1, len + O.length]);
            }
          }
          if (found) { L.circ = true; L.rank += 3; }
        }
        for (const L of this.linkList) if (L.roundabout) L.circ = true;
      }

      // Green corridor: a lane the city builds along the ambulance route, for emergency vehicles only.
      const h = this.hooks;
      this.ambRoute = h && h.ambulance ? this.routeOptions(h.ambulance.origin, h.ambulance.dest)
        .slice().sort((a, b) => a.len - b.len)[0] : null;
      this.gcLinks = [];
      if (this.mode === 'adaptive' && this.features.greenCorridor && this.ambRoute) {
        for (const id of this.ambRoute.ids) {
          const L = this.links[id];
          L.gc = L.lanes; L.lanes++;
          L.lane.push([]); L.flow.push([]);
          if (L.oneway) L.base = -L.lanes * L.lw / 2;
          this.gcLinks.push(L);
        }
      }
      this.gcBuilt = this.gcLinks.length > 0;

      // Kerbside bus stops (Noida has few bus bays, so a dwelling bus blocks the kerb lane): on every
      // loop road, and on about half the long ground-level roads of a real area. Never on flyovers,
      // slip roads or roundabouts.
      for (const L of this.linkList) {
        if (L.kind === 'slip' || L.kind === 'exit' || L.level !== 0 || L.circ || L.length < 150) continue;
        if (L.kind === 'ring' || (!this.ring && hash01(L.idx, 7) < 0.5)) L.busStop = L.length * 0.6;
      }

      for (const j of this.isects) {
        j.boxCap = Math.max(3, BOX_CAP_PCU * Math.min(1, j.r / JR));
        if (j.type === 'J') {
          j.free = j.ins.filter(L => L.kind === 'slip'); // free-left slip roads bypass the signal
          j.approaches = j.ins.filter(L => L.kind !== 'slip').sort((p, q) => p.bearing - q.bearing); // phase order: clockwise
          if (j.approaches.length < 2) { j.type = 'P'; j.approaches = []; }
        }
        if (j.type === 'J') {
          j.sig = { phase: 0, state: 'G', t: 0, next: 0 };
          j.lastGreenEnd = j.approaches.map(() => this.t);
        } else j.free = j.ins.slice();
        for (const L of j.free) L.free = true;
        // A flyover slip road that comes down to give way to a busier road: SAARTHI can control this merge.
        j.slipMerge = !j.sig && j.ins.some(L => L.kind === 'slip' && L.level > 0 && j.ins.some(M => M.rank > L.rank));
        j.mergePrio = null; j.mergeT = -1e9;
      }
      this.inferSignals();
      this.groupSignals();
      this.junctions = this.isects.filter(j => j.type === 'J' && (!j.group || j.group.leader === j));
      this.computeFixedPlans();
    }

    // A link is a polyline from junction centre to junction centre, trimmed back by each junction's radius.
    makeLink(s) {
      const A = this.nodes[s.from], B = this.nodes[s.to];
      const raw = s.pts || [[A.x, A.y], [B.x, B.y]];
      const total = polyLen(raw), ta = A.r || 0, tb = B.r || 0;
      const pts = total - ta - tb > 4 ? slicePolyline(raw, ta, total - tb) : slicePolyline(raw, total / 2 - 2, total / 2 + 2);
      const cum = [0], su = [], sv = [];
      for (let i = 1; i < pts.length; i++) {
        const dx = pts[i][0] - pts[i - 1][0], dy = pts[i][1] - pts[i - 1][1], d = Math.hypot(dx, dy) || 1e-6;
        cum.push(cum[i - 1] + d); su.push(dx / d); sv.push(dy / d);
      }
      const n = su.length, eu = su[n - 1], ev = sv[n - 1];
      const dx = B.x - A.x, dy = B.y - A.y, d = Math.hypot(dx, dy) || 1;
      const lanes = s.lanes, lw = this.lw;
      const level = s.layers ? (s.layers.filter(l => l > 0).length * 2 >= s.layers.length ? 1 : s.layers.some(l => l < 0) ? -1 : 0) : 0;
      const L = {
        id: s.id || `${s.from}>${s.to}`, idx: this.linkList.length, from: s.from, to: s.to, kind: s.kind, lanes, vmax: s.vmax, cls: s.cls || null, busStop: null,
        rank: (s.rank || 3) + (s.roundabout ? 3 : 0), roundabout: !!s.roundabout, oneway: !!s.oneway, level,
        pts, cum, su, sv, eu, ev, lw, base: s.oneway ? -lanes * lw / 2 : this.median, gc: null,
        ux: dx / d, uy: dy / d, nx: dy / d, ny: -dx / d,
        ax: pts[0][0], ay: pts[0][1], bx: pts[n][0], by: pts[n][1], length: cum[n],
        lane: Array.from({ length: lanes }, () => []), flow: Array.from({ length: lanes }, () => []),
        blockage: null, occ: 0, meanSpeed: s.vmax, count: 0, closed: null, rule: null, stopEma: null, stopNow: 0, free: false, circ: false,
        bearing: (Math.atan2(-eu, ev) * 180 / Math.PI + 360) % 360, // from `to` back towards `from`
        approach: compass(-eu, -ev),
        name: s.kind === 'ring' ? `Loop ${s.from}→${s.to}` : this.ring ? (s.kind === 'entry' ? A.name : B.name)
          : s.name || `${(s.cls || 'local')} road ${s.from}→${s.to}`,
      };
      if (B.type !== 'X') B.ins.push(L);
      if (A.type !== 'X') A.outs.push(L);
      this.links[L.id] = L;
      this.linkList.push(L);
      return L;
    }

    ringPath(a, b, dir) {
      const R = this.ring, n = R.length;
      let i = R.indexOf(a);
      const out = [a];
      while (R[i] !== b) { i = (i + dir + n) % n; out.push(R[i]); }
      return out;
    }

    // Cheapest path (Dijkstra over links, honouring allowed movements) from link `fromId` to external
    // `dest`. Returns link ids starting with `fromId`, or null.
    shortest(fromId, dest, cost) {
      const best = new Map([[fromId, 0]]), prev = new Map(), heap = new MinHeap();
      heap.push(0, fromId);
      while (heap.size) {
        const [c, id] = heap.pop();
        if (c > best.get(id)) continue;
        const L = this.links[id];
        if (L.to === dest) {
          const out = [id];
          let k = id;
          while (prev.has(k)) { k = prev.get(k); out.push(k); }
          return out.reverse();
        }
        for (const O of this.moves[id] || []) {
          const w = cost(O, L);
          if (!(w < Infinity)) continue;
          const nc = c + w + (this.uturns.has(id + '|' + O.id) ? 25 : 0);
          if (nc < (best.has(O.id) ? best.get(O.id) : Infinity)) { best.set(O.id, nc); prev.set(O.id, id); heap.push(nc, O.id); }
        }
      }
      return null;
    }

    routeOptions(o, d) {
      this._ro = this._ro || {};
      const key = o + '>' + d;
      if (this._ro[key]) return this._ro[key];
      const res = [];
      const len = ids => ids.reduce((s, id) => s + this.links[id].length, 0);
      if (this.ring) {
        const jo = this.nodes[o].j, jd = this.nodes[d].j;
        for (const dir of (jo === jd ? [1] : [1, -1])) {
          const path = jo === jd ? [jo] : this.ringPath(jo, jd, dir);
          const ids = [o + '>' + jo];
          for (let i = 0; i + 1 < path.length; i++) ids.push(path[i] + '>' + path[i + 1]);
          ids.push(jd + '>' + d);
          res.push({ ids, dir, len: len(ids) });
        }
      } else {
        // the quickest path at free flow, and a genuinely different alternative if one is not much longer
        const x = this.nodes[o];
        const ff = L => L.length / L.vmax + (L.from[0] === 'J' ? 8 : 2);
        const a = x.entry && this.shortest(x.entry.id, d, ff);
        if (a) {
          res.push({ ids: a, len: len(a) });
          const used = new Set(a.slice(1, -1));
          const b = this.shortest(x.entry.id, d, L => ff(L) * (used.has(L.id) ? 1.8 : 1));
          if (b && b.join() !== a.join()) {
            const tA = a.reduce((s, id) => s + ff(this.links[id]), 0), tB = b.reduce((s, id) => s + ff(this.links[id]), 0);
            const overlap = b.filter(id => used.has(id)).length / Math.max(1, b.length - 2);
            if (tB <= 1.35 * tA && overlap < 0.7) res.push({ ids: b, len: len(b) });
          }
        }
      }
      return (this._ro[key] = res);
    }

    generalLanes(L) { return L.lanes - (L.gc != null ? 1 : 0); }

    // Radius of the path from link L into link O across the junction (Infinity when straight on): the
    // chord between the two middle lanes over 2·sin(half the turn angle).
    turnRadius(L, O) {
      const key = L.idx * 65536 + O.idx;
      let r = this.turnR.get(key);
      if (r === undefined) {
        const ang = Math.acos(Math.max(-1, Math.min(1, L.eu * O.su[0] + L.ev * O.sv[0])));
        if (ang < 0.15) r = Infinity;
        else {
          const p = lanePoint(L, L.lanes >> 1, L.length), q = lanePoint(O, O.lanes >> 1, 0);
          r = Math.max(2, Math.hypot(q[0] - p[0], q[1] - p[1])) / (2 * Math.sin(ang / 2));
        }
        this.turnR.set(key, r);
      }
      return r;
    }

    // How fast this driver takes the turn from L into O: v = √(a_lat · r).
    turnSpeed(veh, L, O) {
      return Math.max(TURN_VMIN, Math.min(veh.v0, BOX_VMAX, Math.sqrt(veh.alat * this.turnRadius(L, O))));
    }

    // Buses stop at the kerbside bus stop; autos and e-rickshaws sometimes pull over for a fare.
    // Decided per vehicle and road from a hash, so both twins see the same stops.
    planKerbStop(veh, L) {
      veh.kerbStop = null;
      if (veh.isEV || L.lanes < 2 || !this.laneOk(L, 0, veh)) return;
      const h = hash01(veh.id, L.idx);
      if (veh.type === 'bus' && L.busStop != null) {
        veh.kerbStop = { pos: L.busStop, dwell: BUS_DWELL[0] + h * (BUS_DWELL[1] - BUS_DWELL[0]), until: null };
      } else if ((veh.type === 'auto' || veh.type === 'erick') && h < PICKUP_P && L.length >= 100 && L.level === 0
        && L.kind !== 'slip' && !L.circ) {
        const u = h / PICKUP_P, w = hash01(L.idx, veh.id);
        veh.kerbStop = { pos: L.length * (0.3 + 0.5 * u), dwell: PICKUP_DWELL[0] + w * (PICKUP_DWELL[1] - PICKUP_DWELL[0]), until: null };
      }
    }

    dwelling(veh) { return !!(veh.kerbStop && veh.kerbStop.until != null); }

    // Baseline: a properly tuned Webster fixed-time plan for the design peak hour —
    // a fair benchmark, not a strawman. It just cannot react to anything.
    computeFixedPlans() {
      const flow = {};
      for (const L of this.linkList) flow[L.id] = 0;
      for (const x of this.externals) {
        if (!x.demand) continue;
        for (const [d, w] of Object.entries(this.net.od[x.id])) {
          const q = x.demand * 1.1 * w;
          const opts = this.routeOptions(x.id, d);
          if (!opts.length) continue;
          let use = opts;
          if (opts.length > 1) {
            const [a, b] = opts;
            if (Math.abs(a.len - b.len) >= 0.1 * Math.min(a.len, b.len)) use = [a.len < b.len ? a : b];
          }
          for (const r of use) for (const id of r.ids) flow[id] += q / use.length;
        }
      }
      for (const j of this.junctions) {
        const y0 = j.approaches.map(L => Math.max(flow[L.id], 100) / (this.generalLanes(L) * SAT_FLOW));
        // a pair shares one phase, timed for the busier of the two
        const y = y0.map((v, i) => (j.partner && j.partner[i] >= 0 ? Math.max(v, y0[j.partner[i]]) : v));
        const phases = y.map((_, i) => i).filter(i => canon(j, i) === i);
        const n = phases.length, C = n >= 4 ? 140 : 110, lost = n * (AMBER + ALL_RED);
        const Y = phases.reduce((a, i) => a + y[i], 0);
        j.plan = y.map(v => Math.max(12, Math.round((C - lost) * v / Y)));
        j.designFlow = j.approaches.map(L => Math.round(flow[L.id]));
      }
    }

    // -------------------------------------------------------------- demand
    arrivalRate(x, t = this.t) {
      const h = (t / 3600) % 24;
      let r = x.demand * profileAt(h) * this.demandMult;
      const td = this.net.tidal;
      if (td) {
        const am = window01(h, 7.5, 10.5), pm = window01(h, 17, 20.5); // tidal flows
        if (td.am.includes(x.id)) r *= 1 + 0.15 * am - 0.10 * pm;
        if (td.pm.includes(x.id)) r *= 1 - 0.10 * am + 0.15 * pm;
      }
      for (const s of this.surges) if (s.origin === x.id && t < s.until) r *= s.factor;
      for (const e of this.demandEvents) {
        if (e.origins && !e.origins.includes(x.id)) continue;
        r *= 1 + (e.factor - 1) * window01(t, e.from, e.until, 600);
      }
      return r;
    }

    // Predict: corridor demand vs. capacity, from the daily profile, tidal pattern and scheduled
    // events (office shifts, Film City / mall schedules). Stand-in for the GNN forecaster.
    forecastLoad(minutesAhead) {
      const t = this.t + minutesAhead * 60;
      let d = 0;
      for (const x of this.externals) if (x.demand) d += this.arrivalRate(x, t);
      return d / this.capacity();
    }

    // What the network sustains under adaptive control. Measured in the twin for the Film City loop;
    // for imported areas, set so that the 09:00–10:00 design peak sits just above it.
    capacity() {
      if (this._cap == null) this._cap = this.net.capacity || this.externals.reduce((s, x) => s + x.demand, 0) * 1.12;
      return this._cap;
    }

    forecastSeries(horizonMin, stepMin) {
      const out = [];
      for (let m = 0; m <= horizonMin; m += stepMin) out.push({ t: this.t + m * 60, v: this.forecastLoad(m) });
      return out;
    }

    // Shape demand: when the forecast says the corridor will saturate within 30 min, push
    // personalised departure advice; a share of commuters leave 15 min later.
    updateShaping() {
      const on = this.mode === 'adaptive' && this.features.shaping;
      const peak = Math.max(this.forecastLoad(0), this.forecastLoad(15), this.forecastLoad(30));
      const active = on && (this.shapingActive ? peak > 0.88 : peak > 0.93);
      if (active !== this.shapingActive) {
        this.shapingActive = active;
        this.addLog(active
          ? `Forecast: corridor at ${Math.round(peak * 100)}% of capacity within 30 min → departure advice sent (leave 15 min later)`
          : 'Forecast back under capacity → departure advice withdrawn', 'forecast');
      }
    }

    pickType(r) {
      let acc = 0;
      for (const k of TYPE_KEYS) { acc += VTYPES[k].share; if (r < acc) return k; }
      return 'car';
    }

    pickDest(o, r) {
      const m = this.net.od[o];
      let acc = 0;
      for (const d in m) { acc += m[d]; if (r < acc) return d; }
      return Object.keys(m).pop();
    }

    routeTT(r, wait) {
      let tt = 0;
      for (const id of r.ids) {
        const L = this.links[id];
        if (L.closed && this.t >= L.closed.knownAt) return Infinity;
        tt += L.length / Math.max(L.meanSpeed, 1);
        // plus how long the front vehicle has been standing at the end of it (a queue at a give-way junction or a
        // red light): speeds alone miss a standing queue, and the alternative would fill until it locks
        if (wait) { let w = 0; for (const arr of L.lane) if (arr[0] && arr[0].v < 0.5) w = Math.max(w, arr[0].curWait); tt += w; }
      }
      return tt;
    }

    chooseRoute(o, d, informed) {
      const opts = this.routeOptions(o, d);
      if (opts.length === 1) return opts[0];
      const [a, b] = opts;
      if (!this.ring && informed) { // real network: an informed driver avoids roads that will be closed soon
        const ok = opts.filter(r => this.routeOpen(r, 600));
        if (ok.length && ok.length < opts.length) return ok[0];
      } else if (informed) { // knows the plan: avoids roads that will be closed within 10 min
        const okA = this.routeOpen(a, 600), okB = this.routeOpen(b, 600);
        if (okA !== okB) return okA ? a : b;
      }
      if (this.mode === 'adaptive' && this.features.vms && this.rngRoute() < 0.7) { // VMS / navigation advice, 70% compliance
        if (this.ring) return this.routeTT(a) <= this.routeTT(b) ? a : b;
        // Real network: an empty side road looks free only because nobody is on it yet, and sending 70% of
        // drivers there at once locks its give-way junctions. Sign the alternative only when it is clearly
        // quicker and every road on it still has room.
        // Otherwise the sign says nothing and drivers keep their usual choice (forcing the main route would pile
        // everyone onto it instead of the usual split between two similar routes).
        const room = b.ids.every(id => this.links[id].occ < VMS_ALT_OCC);
        if (room && this.routeTT(b, true) < VMS_ALT_GAIN * this.routeTT(a, true)) return b;
      }
      if (Math.abs(a.len - b.len) < 0.1 * Math.min(a.len, b.len)) return this.rngRoute() < 0.5 ? a : b;
      return a.len < b.len ? a : b; // habit: shortest road
    }

    newVehicle(o, d, typeKey, factor, isEV, forcedRoute) {
      const T = VTYPES[typeKey];
      const informed = !isEV && this.awareness > 0 && this.t >= this.announceAt && this.rngPlan() < this.awareness;
      const route = forcedRoute || this.chooseRoute(o, d, informed);
      const v0 = isEV ? T.vmax : T.vmax * (0.85 + 0.25 * factor);
      // Driver temperament, roughly bell-shaped in -1..1: bold drivers follow closer and pull away harder.
      const r = this.rngDriver, z = isEV ? 0 : (r() + r() + r()) / 1.5 - 1, redRun = r() < T.redRun;
      const veh = {
        id: this.nextId++, type: typeKey, len: T.len, pcu: T.pcu, a: T.a * (1 + 0.2 * z), b: 2.5, s0: T.s0 * (1 - 0.2 * z), T: T.T * (1 - 0.25 * z),
        v0, fuelK: T.fuel, alat: T.alat, dawdle: T.dawdle, redRun, kerbStop: null, preWait: 0, half: 0, filter: false, marshalled: false, turnFor: null, turnRi: -1, turnV2: Infinity,
        route: route.ids, ri: 0, link: null, lane: 0, pos: 0, v: 0, state: 'backlog', origin: o, dest: d,
        spawnT: this.t, stops: 0, moving: true, curWait: 0, fuel: 0, isEV: !!isEV, diverted: false, box: null, lcT: -1e9,
        keepsClear: this.rngBehav() < 0.9, informed, ff: 0,
        // declared up front so every vehicle shares one object shape (keeps the hot loops fast)
        vip: false, lead: false, convoy: null, vmsComply: null, turnedBack: false, evEntry: null, usedGc: false,
        trace: null, plan: null, linkT: 0, enteredT: null, story: null, gcT: null, heldAt: null, corridor: null,
      };
      veh.ff = route.ids.reduce((s, id) => {
        const L = this.links[id];
        return s + L.length / (isEV ? v0 : Math.min(v0, L.vmax));
      }, 0) + (route.ids.length - 1) * (2 * JR / 9);
      return veh;
    }

    spawn() {
      if (this.stepN % 120 === 0) this.updateShaping();
      while (this.deferred.length && this.deferred[0].at <= this.t) {
        const veh = this.deferred.shift().veh;
        veh.spawnT = this.t; // trip time counts from when they actually leave
        this.nodes[veh.origin].backlog.push(veh);
      }
      for (const x of this.externals) {
        if (!x.demand) continue;
        const p = this.arrivalRate(x) / 3600 * DT;
        if (this.rngDemand() < p) {
          const type = this.pickType(this.rngDemand());
          const dest = this.pickDest(x.id, this.rngDemand());
          const f = this.rngDemand();
          const veh = this.newVehicle(x.id, dest, type, f, false);
          if (this.shapingActive && (type === 'car' || type === 'tw') && this.rngBehav() < 0.12) {
            this.deferred.push({ at: this.t + 900, veh });
            this.stats.nudged++;
          } else if (!this.goesRound(veh)) x.backlog.push(veh);
        }
      }
      for (const s of this.sources) { // crowds leaving a venue (what-if events)
        if (this.t < s.from || this.t >= s.until || this.rngVenue() >= s.rate / 3600 * DT) continue;
        const type = this.pickType(this.rngVenue()), r = this.rngVenue();
        let acc = 0, dest = s.dests[s.dests.length - 1][0];
        for (const [d, w] of s.dests) { acc += w; if (r < acc) { dest = d; break; } }
        const veh = this.newVehicle(s.id, dest, type, this.rngVenue(), false);
        if (!this.goesRound(veh)) s.backlog.push(veh);
      }
    }

    // Real map: a driver who knows before setting off (advance notice, or the VMS at the map edge once the
    // control room knows) that a closure leaves no way through on the mapped roads goes round off the map.
    // The trip is booked as its free-flow time plus DETOUR_AVOID. Returns true if so.
    goesRound(veh) {
      if (this.ring || !this.closures.length || veh.isEV) return false;
      const soon = this.closures.filter(c => !c.soft && c.from <= this.t + 600 && c.until > this.t);
      if (!soon.length) return false;
      const closedSoon = id => soon.some(c => c.ids.includes(id));
      if (!veh.route.some(closedSoon)) return false;
      let told = veh.informed;
      if (!told && this.mode === 'adaptive' && this.features.vms && soon.some(c => c.on && this.t >= c.knownAt)) {
        if (veh.vmsComply == null) veh.vmsComply = this.rngPlan() < VMS_COMPLY;
        told = veh.vmsComply;
      }
      if (!told || this.shortest(veh.route[0], veh.dest, L => (closedSoon(L.id) ? Infinity : L.length))) return false;
      this.stats.avoided++;
      const went = soon.find(q => veh.route.some(id => q.ids.includes(id)));
      went.wentRound = (went.wentRound || 0) + 1;
      veh.spawnT = this.t - veh.ff - DETOUR_AVOID;
      this.completeTrip(veh);
      return true;
    }

    // Only on the Film City loop, where its entries are real ramps. A real map's entries are just its edge:
    // holding traffic there moves the queue off the map, where it still counts (5 seeds on Film City: SAARTHI's
    // average trip was shorter on all five with metering off).
    isMetered(x) {
      if (this.mode !== 'adaptive' || !this.features.metering || !this.ring) return false;
      const j = this.nodes[x.j];
      const occ = Math.max(0, ...j.outs.filter(L => L.kind !== 'exit').map(L => L.occ));
      if (x.metered) return occ > 0.55 || j.boxBlocked;
      return occ > 0.7 || j.boxBlocked;
    }

    releaseBacklog(x) {
      if (!x.entry) return;
      const metered = this.isMetered(x);
      if (metered !== x.metered) {
        x.metered = metered;
        if (metered && this.t - x.meterLogT > 60) { // flickers when a junction box blocks on and off: log once a minute
          x.meterLogT = this.t;
          this.addLog(`Ramp metering ON at ${x.name}: loop ahead is filling`, 'meter');
        } else if (!metered && this.t - x.meterLogT > 60) this.addLog(`Ramp metering OFF at ${x.name}`, 'meter');
      }
      let placed = 0;
      while (x.backlog.length && placed < x.lanes) {
        const veh = x.backlog[0];
        if (metered && !veh.isEV && this.t - x.lastRelease < METER_HEADWAY) break;
        const L = x.entry;
        const lane = this.bestEntryLane(L, veh, false);
        if (lane < 0) break;
        const arr = L.lane[lane], last = arr[arr.length - 1];
        const vDes = veh.isEV ? veh.v0 : Math.min(veh.v0, L.vmax);
        veh.v = last ? Math.min(vDes, last.v) : vDes;
        // time queued off the map is waiting for the first junction too: kept aside for the KPIs, so the
        // driver's patience (curWait) starts afresh
        veh.preWait = veh.curWait;
        veh.pos = 0; veh.link = L; veh.lane = lane; veh.state = 'link'; veh.curWait = 0; veh.linkT = this.t;
        if (veh.trace) veh.enteredT = this.t;
        if (veh.story) { this.tell(veh, `Entered the map on ${L.name || 'its road'}`); if (lane === this.gcOf(L)) this.enteredGc(veh, L); }
        arr.push(veh);
        this.joinLane(veh, arr);
        x.backlog.shift();
        this.planKerbStop(veh, L);
        if (this.divertAt(veh, this.nodes[L.to]) === 'stranded') this.turnBack(veh, arr);
        x.lastRelease = this.t;
        placed++;
      }
      // The backlog is the queue on the road beyond the map edge. When it moves again after a standstill
      // (the entry road had filled to the edge), everyone in it rolls forward and then stops again, so
      // stops are counted the same way as in a queue on the map.
      if (placed && x.stallT >= BACKLOG_STALL) for (const veh of x.backlog) veh.moving = true;
      x.stallT = placed || !x.backlog.length ? 0 : x.stallT + DT;
      for (const veh of x.backlog) this.accountMotion(veh, 0, 0);
    }

    // -------------------------------------------------------------- stepping
    step() {
      this.t += DT;
      this.stepN++;
      this.updateEvents();
      this.spawn();
      this.updateSignals();
      this.moveLinks();
      this.moveBoxes();
      for (const x of this.externals) this.releaseBacklog(x);
      for (const s of this.sources) this.releaseBacklog(s);
      if (this.stepN % 4 === 0) { this.laneChanges(); if (this.evs.length) this.updateSuggestions(); }
      this.updateJunctionState();
      if (this.stepN % 120 === 0) { this.sample(); this.trackEvents(); }
    }

    updateEvents() {
      this.updatePlan();
      for (const L of this.linkList) {
        if (L.blockage && this.t >= L.blockage.until) {
          this.addLog(`Kerbside blockage cleared on ${L.name}`, 'info');
          L.blockage = null;
        }
      }
      this.surges = this.surges.filter(s => s.until > this.t);
      for (const j of this.junctions) {
        if (j.faultUntil > 0 && this.t >= j.faultUntil) {
          j.faultUntil = -1;
          if (this.mode === 'adaptive') this.addLog(`${this.jName(j)}: camera restored → adaptive control resumed`, 'fallback', j.id);
        }
      }
    }

    updateSignals() {
      const decide = this.mode === 'adaptive' ? adaptiveDecide : fixedDecide;
      for (const j of this.junctions) {
        const s = j.sig;
        s.t += DT;
        if (s.state === 'Y' && s.t >= AMBER) { s.state = 'R'; s.t = 0; }
        else if (s.state === 'R' && s.t >= ALL_RED) { s.phase = s.next; s.state = 'G'; s.t = 0; }
        else if (s.state === 'G' && this.stepN % 4 === 0) {
          if (j.ovr && this.t >= j.ovr.until) this.clearOverride(j, 'time up');
          const d = j.ovr ? this.overrideDecide(j, decide) : decide(this, j);
          if (d && d.next >= 0 && d.next !== s.phase) {
            s.next = d.next; s.state = 'Y'; s.t = 0;
            j.lastGreenEnd[s.phase] = this.t;
            if (j.partner && j.partner[s.phase] >= 0) j.lastGreenEnd[j.partner[s.phase]] = this.t;
            j.lastReason = d.reason;
            if (d.reason === 'ev') { // for the ambulance's junction-by-junction record
              j.evSwitch = { t: this.t, i: d.next };
              const m = this.evMatch, A = j.approaches[d.next];
              if (m && m.ev.story) j.evKeepFor = m.ev.id; // then 'kept green' is not news
              if (m && m.ev.story) this.tell(m.ev, `Light at ${this.jName(j)} changing to green for it on ${A.name || 'its road'} (${this.distTxt(m.d)})`, 'light');
            }
            if (d.log) this.addLog(d.log, d.kind || 'decision', j.id);
          }
        }
      }
    }

    canAdmit(j, veh) {
      return !j.boxBlocked && j.boxPcu + veh.pcu <= j.boxCap;
    }

    mustStop(veh, L, j) {
      const dist = L.length - veh.pos;
      // An ambulance in the green corridor lane never stops; the junction holds everyone else for
      // the few seconds it takes to cross, instead of flushing a whole approach ahead of it.
      if (veh.type === 'ev' && veh.lane === this.gcOf(L) && this.evCleared(veh, j)) return false;
      // held for the ambulance, except whoever is ahead of it in its own lane: they go first and clear its way
      if (j.evHold > this.t && !veh.isEV && dist < 12 && !(j.evHoldL === L && veh.lane === j.evHoldLane)) return true;
      if (j.sig && !L.free && !(this.ctrl(j).ovr && this.ctrl(j).ovr.mode === 'flash')) {
        const s = j.sig, mine = j.approaches[s.phase] === L || (!!j.partner && j.approaches[j.partner[s.phase]] === L);
        // A red-runner already close and moving carries on through the amber, the all-red and the first
        // couple of seconds of the next green (the same drivers in both twins).
        const jump = veh.redRun && veh.v > 3 && dist < veh.v * 1.5;
        if (!mine) { if (!(jump && this.t - j.lastGreenEnd[j.approaches.indexOf(L)] < AMBER + ALL_RED + 2)) return true; }
        else if (s.state === 'R' && !jump && !(s.t < 2 && dist < veh.v * 1.2)) return true;
        else if (s.state === 'Y' && !jump && dist > veh.v * veh.v / (2 * 3.5) + 1) return true;
      } else if (dist < 20 && !(j.group && j.group.ids.has(L.from)) && this.mustYield(veh, L, j)) return true; // inside a signal group: it entered on green, it clears the crossing
      if (dist < 12 && !this.canAdmit(j, veh)) return true;
      // Keep-clear: with vision enforcement auto-flagging box-blocking at a signal, most drivers wait at the
      // line rather than enter a junction whose exit road is jammed. (Doing the same at give-way junctions
      // just moves a circular jam from the boxes onto the approach roads, where nothing can break it.)
      if (dist < 12 && veh.keepsClear && j.sig && this.mode === 'adaptive' && this.features.enforcement
        && this.exitJammed(this.exitPast(j, veh), veh)) return true;
      return false;
    }

    // The road beyond is full and standing still. If its tail is rolling there will be room by the time a
    // driver crosses, so that doesn't count.
    exitJammed(next, veh) {
      if (!next) return false; // the route ends here (an ambulance reaching a hospital inside the map)
      const full = this.bestEntryLane(next, veh, false) < 0 || this.maxEntryRoom(next, veh) < Math.min(veh.len + veh.s0 + 2, next.length - 1);
      return full && !this.tailMoving(next, veh);
    }

    // Unsignalised junctions (merges, slip-road ends, roundabout entries, median U-turns): give way to
    // traffic on a higher-ranked road that will reach the junction within ~3 s. A U-turn gives way to
    // everyone. In crawling traffic drivers take turns (a zipper merge): once a car from the main road has
    // gone, the side road's next car goes. After 15 s of waiting, drivers nose in anyway, so nothing starves.
    mustYield(veh, L, j) {
      if (veh.isEV) return false;
      if (j.slipMerge && this.mode === 'adaptive' && this.features.mergeControl) return this.mergeYield(veh, L, j);
      const next = this.links[veh.route[veh.ri + 1]];
      const joining = next && next.circ && !L.circ; // entering a roundabout / loop
      if (veh.curWait > (joining ? 40 : 15)) return false;
      // joining a loop needs space for the whole car, or the loop locks up
      if (joining && this.maxEntryRoom(next, veh) < Math.min(2 * (veh.len + veh.s0), next.length - 1)) return true;
      const my = L.rank - (next && this.uturns.has(L.id + '|' + next.id) ? 10 : 0);
      for (const M of j.ins) {
        if (M === L || M.rank <= my) continue; // equal roads: first come, first served
        if (j.sig && !M.free && j.approaches[j.sig.phase] !== M) continue; // red there: no conflict
        for (const arr of M.lane) {
          const v = arr[0];
          if (!v || (j.lastIn === M && v.v < ZIP_V)) continue; // main road just went and is crawling: my turn
          const d = M.length - v.pos;
          if (d < 40 && v.v > 1 && d / v.v < 3) return true;
          // a queued car on the main road waiting for the same space goes first
          if (d < 12 && v.route[v.ri + 1] === (next && next.id)) return true;
        }
      }
      return false;
    }

    // SAARTHI merge control where a flyover slip gives way: the road with the fuller queue goes first
    // (cameras on both approaches, a merge signal or marshal), re-picked every 10 s. The other road gives
    // way to it as at any give-way junction. At plain merges this didn't help: there the merge box, not
    // giving way, sets the pace, so priority only moves the waiting from one road to the other.
    mergeYield(veh, L, j) {
      if (veh.curWait > 15) return false;
      if (this.t - j.mergeT >= MERGE_EVERY) {
        const cur = j.mergePrio || j.ins.reduce((a, M) => (M.rank > a.rank ? M : a));
        let best = cur;
        for (const M of j.ins) if (M.occ > best.occ + (best === cur ? MERGE_HYST : 0)) best = M;
        if (best !== cur) this.addLog(`Merge control: ${best.name} goes first (queue fuller)`, 'decision');
        j.mergePrio = best; j.mergeT = this.t;
      }
      const P = j.mergePrio;
      if (P === L) return false;
      for (const arr of P.lane) {
        const v = arr[0];
        if (!v) continue;
        const d = P.length - v.pos;
        if (d < 12 || (d < 40 && v.v > 1 && d / v.v < 3)) return true;
      }
      return false;
    }

    accountMotion(veh, ds, v) {
      veh.fuel += veh.fuelK * (ds * 0.00007 + (v < 0.3 ? 0.00017 * DT : 0)); // ~7 L/100 km, ~0.6 L/h idle
      if (v < 0.5) {
        veh.curWait += DT;
        if (veh.moving) { veh.moving = false; veh.stops++; veh.fuel += veh.fuelK * 0.004; }
      } else if (v > 3) veh.moving = true;
    }

    moveLinks() {
      for (const L of this.linkList) {
        const toJ = this.nodes[L.to].type !== 'X' ? this.nodes[L.to] : null;
        const g = this.gcOf(L);
        if (toJ && g != null) { // ambulance closing on the junction in its corridor lane
          const a = L.lane[g][0];
          if (a && L.length - a.pos < 45 && this.evCleared(a, toJ)) {
            toJ.evHold = this.t + 0.5; toJ.evHoldL = L; toJ.evHoldLane = g;
            const c = this.ctrl(toJ);
            if (a.story && a.heldAt !== c.id && toJ.sig && !L.free && !(toJ.sig.state === 'G' && toJ.approaches[toJ.sig.phase] === L)) { a.heldAt = c.id; this.tell(a, `${this.jName(c)}: cross traffic held for it`, 'light'); }
          }
        }
        let occ = 0, spd = 0, cnt = 0;
        for (let li = 0; li < L.lanes; li++) {
          const arr = L.lane[li];
          let reorder = false;
          for (let k = 0; k < arr.length; k++) {
            const veh = arr[k];
            let vDes = veh.isEV ? veh.v0 : Math.min(veh.v0, L.vmax);
            // Who this vehicle has to follow. Two-wheelers ride two abreast in a lane and filter between
            // lanes past crawling traffic, so the leader isn't always the vehicle just ahead.
            let ld = this.leaderOf(arr, k, veh);
            if (veh.type === 'tw') {
              if (!veh.filter && ld && ld.v < FILTER_START_V && ld.pos - ld.len - veh.pos < FILTER_GAP) {
                veh.filter = true;
                ld = this.leaderOf(arr, k, veh);
              } else if (veh.filter && this.canRejoin(arr, k, veh)) {
                veh.filter = false;
                ld = this.leaderOf(arr, k, veh);
              }
              if (veh.filter) { // no faster than FILTER_DV past the traffic it is squeezing by
                let nb = null;
                for (let m = k - 1; m >= 0 && !nb; m--) if (!arr[m].filter) nb = arr[m];
                if (nb && nb.pos - nb.len - veh.pos < 15) vDes = Math.min(vDes, nb.v + FILTER_DV);
              }
            }
            const toEnd = L.length - veh.pos;
            if (toJ && toEnd < 60 && vDes > TURN_VMIN) { // ease off for the turn ahead (comfortable 2 m/s² braking)
              if (veh.turnFor !== veh.route || veh.turnRi !== veh.ri) { // cached until the route or the road changes
                const nxt = this.links[veh.route[veh.ri + 1]];
                veh.turnV2 = nxt ? this.turnSpeed(veh, L, nxt) ** 2 : Infinity;
                veh.turnFor = veh.route; veh.turnRi = veh.ri;
              }
              if (veh.turnV2 < Infinity) vDes = Math.min(vDes, Math.sqrt(veh.turnV2 + 4 * Math.max(0, toEnd)));
            }
            let gap = Infinity, vl = vDes, leaderRear = Infinity;
            if (ld) { leaderRear = ld.pos - ld.len; gap = leaderRear - veh.pos; vl = ld.v; }
            let stopAt = Infinity;
            if (toJ && leaderRear >= L.length && this.mustStop(veh, L, toJ)) stopAt = L.length;
            const bl = L.blockage;
            if (bl && bl.on[li] && !veh.filter && veh.pos < bl.pos && leaderRear >= bl.pos) stopAt = Math.min(stopAt, bl.pos - 0.5);
            const ks = veh.kerbStop;
            if (ks) {
              if (li !== 0 && veh.pos > ks.pos - 5) veh.kerbStop = null; // couldn't reach the kerb in time: skip it
              else if (li === 0) {
                if (ks.until == null && ks.pos - veh.pos < 1.5 && veh.v < 0.3) ks.until = this.t + ks.dwell;
                if (ks.until != null && this.t >= ks.until) { veh.kerbStop = null; veh.curWait = 0; } // fare / passengers on board
                else stopAt = Math.min(stopAt, ks.until != null ? veh.pos : ks.pos);
              }
            }
            if (stopAt < Infinity && stopAt - veh.pos < gap) { gap = stopAt - veh.pos; vl = 0; }
            let acc = idm(veh, vDes, gap, veh.v - vl);
            if (veh.dawdle && acc > -2) acc -= veh.dawdle * veh.a * this.rngNoise(); // a moment's hesitation
            let v = Math.max(0, veh.v + acc * DT);
            let pos = veh.pos + v * DT;
            if (ld && pos > leaderRear - 0.3) { pos = Math.max(veh.pos, leaderRear - 0.3); v = Math.min(v, ld.v); }
            if (stopAt < Infinity && pos > stopAt - 0.05) { pos = Math.max(veh.pos, stopAt - 0.05); v = 0; }
            this.accountMotion(veh, pos - veh.pos, v);
            veh.v = v; veh.pos = pos;
            if (k > 0 && pos > arr[k - 1].pos) reorder = true; // a two-wheeler slipped past someone
            if (pos < L.length) { occ += (veh.filter ? 0 : veh.type === 'tw' ? 0.5 : 1) * (veh.len + veh.s0); spd += v; cnt++; }
          }
          if (reorder) { // keep the lane front-first (insertion sort: it is almost sorted already)
            for (let k = 1; k < arr.length; k++) {
              const veh = arr[k];
              let m = k - 1;
              while (m >= 0 && arr[m].pos < veh.pos) { arr[m + 1] = arr[m]; m--; }
              arr[m + 1] = veh;
            }
          }
          while (arr.length && arr[0].pos >= L.length) {
            const veh = arr.shift();
            if (toJ && veh.ri + 1 < veh.route.length) this.enterBox(veh, L, li, toJ); // a route can end inside the map (a hospital)
            else this.completeTrip(veh);
          }
        }
        L.occ = occ / (L.length * Math.max(1, this.generalLanes(L) - (L.rule ? 1 : 0)));
        L.count = cnt;
        L.meanSpeed = cnt ? spd / cnt : L.vmax;
      }
    }

    // The first vehicle ahead in the lane that `veh` can't share road width with. Two-wheelers ride in
    // one half of the lane, so a bike in the other half doesn't block them; a filtering bike rides on the
    // lane line and is only held up by other filtering bikes; everyone else ignores filtering bikes.
    leaderOf(arr, k, veh) {
      const bike = veh.type === 'tw';
      for (let m = k - 1; m >= 0; m--) {
        const o = arr[m];
        if (o.filter ? veh.filter : !veh.filter && (!bike || o.type !== 'tw' || o.half === veh.half)) return o;
      }
      return null;
    }

    // A filtering bike slots back into the lane once traffic is moving and there is room around it.
    canRejoin(arr, k, veh) {
      let ahead = null, behind = null;
      for (let m = k - 1; m >= 0 && !ahead; m--) if (!arr[m].filter) ahead = arr[m];
      for (let m = k + 1; m < arr.length && !behind; m++) if (!arr[m].filter) behind = arr[m];
      if (ahead && (ahead.v < FILTER_END_V || ahead.pos - ahead.len < veh.pos + veh.s0 + 1)) return false;
      if (behind && behind.pos > veh.pos - veh.len - 1) return false;
      if (ahead && ahead.type === 'tw' && ahead.pos - ahead.len - veh.pos < 10) veh.half = 1 - ahead.half; // ride beside it
      return true;
    }

    // A vehicle has just joined the tail of a lane: bikes pair up with a bike just ahead, side by side.
    joinLane(veh, arr) {
      veh.filter = false;
      if (veh.type !== 'tw') return;
      const o = arr[arr.length - 2];
      veh.half = o && o.type === 'tw' && o.pos - veh.pos < 8 ? 1 - o.half : veh.id & 1;
    }

    entryRoom(L, lane) {
      const arr = L.lane[lane], last = arr[arr.length - 1];
      return last ? last.pos - last.len : L.length;
    }

    // Is the back of the traffic on link L, in a lane `veh` may use, moving?
    tailMoving(L, veh) {
      for (let i = 0; i < L.lanes; i++) {
        if (!this.laneOk(L, i, veh)) continue;
        const arr = L.lane[i], last = arr[arr.length - 1];
        if (last && last.v > KEEP_CLEAR_V) return true;
      }
      return false;
    }

    maxEntryRoom(L, veh) { // lanes `veh` may use (no `veh`: lanes open to general traffic)
      let room = -Infinity;
      for (let i = 0; i < L.lanes; i++) if (this.laneOk(L, i, veh)) room = Math.max(room, this.entryRoom(L, i));
      return room;
    }

    // Best lane to enter link L at its start. Returns -1 if none has room (unless `any`).
    bestEntryLane(L, veh, any, prefer) {
      const need = veh.s0 + 0.3;
      if (veh.type === 'ev' && this.gcOf(L) != null && this.entryRoom(L, this.gcOf(L)) >= need) return this.gcOf(L);
      if (veh.vip && L.rule && L.rule.use === 'vip' && this.entryRoom(L, L.rule.lane) >= need) return L.rule.lane;
      if (prefer != null && this.laneOk(L, prefer, veh) && this.entryRoom(L, prefer) >= need) return prefer;
      let best = -1, bestRoom = -Infinity;
      for (let i = 0; i < L.lanes; i++) {
        if (!this.laneOk(L, i, veh)) continue;
        const r = this.entryRoom(L, i);
        if (r > bestRoom) { bestRoom = r; best = i; }
      }
      return any || bestRoom >= need ? best : -1;
    }

    enterBox(veh, L, li, j) {
      this.divertAt(veh, j); // a closure that began while this vehicle was on its approach
      const next = this.links[veh.route[veh.ri + 1]];
      const outLane = this.bestEntryLane(next, veh, true);
      const p0 = lanePoint(L, li, L.length), p1 = [j.x, j.y], p2 = lanePoint(next, outLane, 0);
      veh.state = 'box'; veh.link = null;
      veh.box = { j, from: L, next, outLane, p0, p1, p2, s: Math.max(0, veh.pos - L.length), len: bezLen(p0, p1, p2), stuck: 0,
        vt: this.turnSpeed(veh, L, next) };
      veh.kerbStop = null;
      j.box.push(veh);
      j.boxPcu += veh.pcu;
      j.lastIn = L; // whose turn it is at a zipper merge
      if (veh.trace) this.traceCrossing(veh, L, li, j);
      const cr = { t: this.t, j: j.id, wait: veh.curWait + veh.preWait };
      veh.preWait = 0;
      this.crossings.push(cr);
      if (this.allCrossings) this.allCrossings.push(cr);
      const fl = L.flow[li];
      fl.push({ t: this.t, pcu: veh.pcu });
      while (fl.length && fl[0].t < this.t - 60) fl.shift();
      veh.curWait = 0;
    }

    moveBoxes() {
      for (const j of this.isects) {
        let blocked = false;
        const keep = [];
        for (const veh of j.box) {
          const b = veh.box;
          if (veh.type === 'ev' && this.gcOf(b.next) != null) { j.evHold = this.t + 0.5; j.evHoldL = null; }
          if (b.s < b.len) {
            const vt = b.vt;
            veh.v = Math.max(1.5, Math.min(vt, veh.v + (veh.v < vt ? veh.a : -2.5) * DT));
            b.s += veh.v * DT;
            this.accountMotion(veh, veh.v * DT, veh.v);
          }
          if (b.s >= b.len) {
            const lane = this.bestEntryLane(b.next, veh, false, b.outLane);
            if (lane >= 0) {
              const arr = b.next.lane[lane], last = arr[arr.length - 1];
              const room = this.entryRoom(b.next, lane);
              veh.pos = Math.max(0, Math.min(b.s - b.len, room - veh.s0));
              if (last) veh.v = Math.min(veh.v, last.v + 2);
              veh.link = b.next; veh.lane = lane; veh.ri++; veh.state = 'link'; veh.box = null; veh.curWait = 0; veh.linkT = this.t;
              arr.push(veh);
              this.joinLane(veh, arr);
              if (veh.story && lane === this.gcOf(b.next)) this.enteredGc(veh, b.next);
              if (veh.corridor) this.releaseLane(veh, b.from);
              j.boxPcu -= veh.pcu;
              this.planKerbStop(veh, b.next);
              if (this.divertAt(veh, this.nodes[b.next.to]) === 'stranded') this.turnBack(veh, arr);
              continue;
            }
            b.s = b.len; veh.v = 0; b.stuck += DT;
            this.accountMotion(veh, 0, 0);
            if (!this.ring && b.stuck >= DEADLOCK_T) { // as SUMO's time-to-teleport: squeeze out, trip pays a penalty
              this.squeezeOut(veh, j);
              continue;
            }
            if (b.stuck > 2) blocked = true;
          }
          keep.push(veh);
        }
        j.box = keep;
        j.boxBlocked = blocked;
      }
    }

    laneChanges() {
      for (const L of this.linkList) {
        if (L.lanes < 2) continue;
        const bl = L.blockage;
        for (let li = 0; li < L.lanes; li++) {
          const arr = L.lane[li];
          for (let k = arr.length - 1; k >= 0; k--) {
            const veh = arr[k];
            if (this.t - veh.lcT < 3) continue;
            if (L.length - veh.pos < 15 || veh.pos < 5) continue;
            const blocked = !!(bl && bl.on[li] && veh.pos < bl.pos && bl.pos - veh.pos < 80);
            const toVip = !!(veh.vip && L.rule && L.rule.use === 'vip' && li !== L.rule.lane); // convoy heads for its lane
            const toGc = veh.type === 'ev' && this.gcOf(L) != null && li !== this.gcOf(L); // ambulance heads for the corridor lane
            const ks = veh.kerbStop;
            if (ks && ks.until != null) continue; // stopped at the kerb
            if (veh.filter) continue;             // filtering bike: already on the lane line
            const toKerb = !!(ks && li > 0 && ks.pos - veh.pos < 150); // bus / auto works across to the kerb lane
            const ld = arr[k - 1];
            const myGap = ld ? ld.pos - ld.len - veh.pos : (blocked ? bl.pos - veh.pos : Infinity);
            const behindStop = !!(!ks && ld && myGap < 40 && this.dwelling(ld)); // stuck behind a bus at its stop
            const mandatory = blocked || toVip || toGc || toKerb || behindStop || !this.laneOk(L, li, veh);
            if (!mandatory) {
              if (veh.v > 0.7 * veh.v0 || myGap > 30) continue;
              if (this.rngBehav() > 0.3) continue;
            }
            for (const tl of (toGc ? [li + 1] : toVip ? [li + Math.sign(L.rule.lane - li)] : toKerb ? [li - 1] : [li + 1, li - 1])) {
              if (tl < 0 || tl >= L.lanes || !this.laneOk(L, tl, veh)) continue;
              if (bl && bl.on[tl] && veh.pos < bl.pos && bl.pos - veh.pos < (bl.lanes.length > 1 ? 30 : 80)) continue; // squeeze past a wide blockage lane by lane
              const ta = L.lane[tl];
              let idx = 0;
              while (idx < ta.length && ta[idx].pos >= veh.pos) idx++;
              const nl = ta[idx - 1], nf = ta[idx];
              const lgap = nl ? nl.pos - nl.len - veh.pos : Infinity;
              const fgap = nf ? veh.pos - veh.len - nf.pos : Infinity;
              if (lgap < veh.s0 + 0.3 * veh.v) continue;
              if (nf && fgap < nf.s0 + 0.5 * nf.v) continue;
              if (!mandatory && lgap < myGap + 12) continue;
              arr.splice(k, 1);
              ta.splice(idx, 0, veh);
              veh.lane = tl; veh.lcT = this.t;
              if (veh.story && tl === this.gcOf(L)) this.enteredGc(veh, L);
              if (veh.type === 'tw') veh.half = veh.id & 1;
              break;
            }
          }
        }
      }
    }

    updateJunctionState() {
      const auto = this.mode === 'adaptive' && this.features.enforcement;
      for (const j of this.isects) {
        if (!j.boxBlocked) { j.blockedT = 0; j.inGridlock = false; j.deadT = 0; j.marshalAt = null; continue; }
        j.blockedT += DT;
        if (j.blockedT >= 30 && !j.inGridlock) {
          j.inGridlock = true;
          this.stats.gridlockEvents++;
          this.addLog(`Gridlock at ${this.jName(j)}: vehicles stuck in the junction for 30 s (the road they are turning into is full)`, 'alert', j.id);
        }
        if (j.inGridlock) this.stats.gridlockSeconds += DT;
        if (j.marshalAt != null) { // a marshal the controller sent: clears it on arrival, keeps at it until clear
          if (this.t >= j.marshalAt && !this.clearBox(j, auto, 'controller')) j.marshalAt = this.t + 10;
          continue;
        }
        if (j.blockedT >= (auto && !this.controllerMarshals ? 60 : 180)) {
          const held = j.blockedT; // clearBox resets blockedT, so read it first
          if (!this.clearBox(j, auto && !this.controllerMarshals) && !this.ring) j.deadT = (j.deadT || 0) + held;
          if (j.deadT >= 240) this.breakDeadlock(j);
        }
      }
    }

    // Last resort on real networks (as SUMO "teleports"): a box locked for 4 min with nowhere to divert is
    // a circular wait. The stuck vehicles squeeze out and finish their trip with a 4-min penalty, so the
    // control system that caused the lock still pays for it in trip time.
    breakDeadlock(j) {
      const stuck = j.box.filter(v => v.box.stuck > 2);
      for (const veh of stuck) this.squeezeOut(veh, j, true);
      j.box = j.box.filter(v => !stuck.includes(v));
      j.deadT = 0; j.blockedT = 0;
      if (stuck.length) this.addLog(`Deadlock at ${this.jName(j)}: ${stuck.length} vehicle(s) squeezed out after 4 min`, 'alert', j.id);
    }

    // Turned back at a barricade with no way through on the mapped roads: the vehicle leaves road `arr` and
    // finishes its trip off the map, DETOUR_TURNBACK later.
    turnBack(veh, arr) {
      arr.splice(arr.indexOf(veh), 1);
      this.stats.turnedBack++; this.stats.stranded++;
      const nl = this.links[veh.route[veh.ri + 1]], c = nl && nl.closed;
      if (c) c.turnedBack = (c.turnedBack || 0) + 1;
      veh.spawnT -= DETOUR_TURNBACK;
      this.completeTrip(veh);
    }

    // One vehicle stuck in a box too long leaves the network and finishes its trip with a 4-min penalty.
    // The caller takes it out of j.box.
    squeezeOut(veh, j, quiet) {
      veh.spawnT -= 240;
      j.boxPcu -= veh.pcu;
      if (veh.isEV) this.evs = this.evs.filter(e => e !== veh);
      this.completeTrip(veh);
      this.stats.squeezed++;
      if (!quiet && this.t - (j.squeezeLogT || -1e9) > 120) {
        j.squeezeLogT = this.t;
        this.addLog(`Deadlock at ${this.jName(j)}: a vehicle stuck ${Math.round(DEADLOCK_T / 60)} min squeezed out`, 'alert', j.id);
      }
    }

    // The controller sends a marshal to a blocked junction; they get there in `eta` seconds.
    sendMarshal(j, eta = 20) { // a marshal posted at or near the junction, called by radio
      if (!j.boxBlocked || j.marshalAt != null) return false;
      j.marshalAt = this.t + eta;
      this.addLog(`Marshal sent to ${this.jName(j)} (there in ~${eta} s)`, 'sent', j.id);
      return true;
    }

    // A marshal (auto-alerted by vision enforcement, sent by the controller, or noticing it on the ground)
    // waves stuck vehicles out.
    clearBox(j, auto, by) {
      let n = 0;
      const exits = j.outs.filter(L => L.kind === 'exit');
      for (const veh of j.box) {
        if (veh.box.stuck < 2) continue;
        let alt = null, tail = null;
        if (this.ring) {
          alt = exits.find(L => L !== veh.box.next && this.bestEntryLane(L, veh, false) >= 0);
          if (alt) tail = [alt.id];
        } else { // real network: the road out that gets this driver to their destination quickest now,
          // as long as the way round isn't much longer than the route they were on
          const ff = M => M.length / M.vmax, now = M => M.length / Math.max(M.meanSpeed, 1);
          const orig = veh.route.slice(veh.ri + 1).reduce((s, id) => s + ff(this.links[id]), 0);
          let best = Infinity;
          for (const L of this.moves[veh.route[veh.ri]] || []) {
            if (L === veh.box.next || (L.closed && !L.closed.soft) || this.bestEntryLane(L, veh, false) < 0) continue;
            const p = this.shortest(L.id, veh.dest, now);
            if (!p) continue;
            let pf = 0, pc = 0;
            for (const id of p) { pf += ff(this.links[id]); pc += now(this.links[id]); }
            if (pf > DETOUR_MAX * orig + DETOUR_SLACK || pc >= best) continue;
            best = pc; alt = L; tail = p;
          }
        }
        if (!alt) continue;
        veh.route = veh.route.slice(0, veh.ri + 1).concat(tail);
        veh.box.next = alt; veh.box.outLane = 0; veh.box.p2 = lanePoint(alt, 0, 0); veh.box.stuck = 0;
        veh.box.vt = this.turnSpeed(veh, veh.box.from, alt);
        // On the loop the vehicle leaves by another exit, so its trip no longer compares and is left out
        // of the KPIs; on a real map it still reaches its own destination and the detour counts in its trip.
        if (this.ring) veh.diverted = true;
        else if (!veh.marshalled) { veh.marshalled = true; this.stats.diverted++; }
        n++;
      }
      if (n) this.addLog(`${by === 'controller' ? 'Marshal' : auto ? 'Vision alert → marshal' : 'Traffic marshal (manual)'} cleared the junction at ${this.jName(j)}; ${n} vehicle${n === 1 ? "" : "s"} waved out`, 'alert', j.id);
      if (n && by === 'controller') j.marshalAt = null;
      j.lastCleared = { t: this.t, by: by || (auto ? 'auto' : 'ground'), n };
      j.blockedT = 0;
      return n;
    }

    completeTrip(veh) {
      const tt = this.t - veh.spawnT;
      this.stats.completed++;
      if (veh.vip) {
        this.evs = this.evs.filter(e => e !== veh);
        const delay = Math.max(0, tt - veh.ff);
        this.stats.vipTrips.push({ t: this.t, tt, delay });
        if (veh.lead) this.addLog(`${veh.convoy} arrived in ${fmtDur(tt)} (delay ${fmtDur(delay)})`, 'vip');
        return;
      }
      if (veh.isEV) {
        this.evs = this.evs.filter(e => e !== veh);
        const delay = Math.max(0, tt - veh.ff);
        this.stats.evTrips.push({ t: this.t, tt, delay });
        if (veh.evEntry) Object.assign(veh.evEntry, { arriveAt: this.t, tt, delay, usedLane: !!veh.usedGc });
        if (veh.story) this.tell(veh, `Reached the hospital: ${fmtDur(tt)} after it was reported`, 'done');
        if (veh.corridor) for (const L of veh.corridor.slice()) this.releaseLane(veh, L);
        this.addLog(`Ambulance arrived in ${fmtDur(tt)} (delay ${fmtDur(delay)})`, 'ev');
        return;
      }
      if (veh.diverted) { this.stats.diverted++; return; }
      const rec = { t: this.t, tt, ff: veh.ff, stops: veh.stops, fuel: veh.fuel, o: veh.origin, d: veh.dest };
      this.trips.push(rec);
      if (this.allTrips) this.allTrips.push(rec);
    }

    // -------------------------------------------------------------- controller inputs
    redTime(j, i) {
      return j.sig.state === 'G' && greenFor(j, i) ? 0 : this.t - j.lastGreenEnd[i];
    }

    isFull(L) {
      return this.maxEntryRoom(L) < Math.min(7, L.length * 0.5) || L.occ > 0.88;
    }

    // What the edge cameras + forecaster tell the brain about one approach.
    pressure(j, i) {
      const L = j.approaches[i];
      let queue = 0, arriving = 0, front = 0, risky = 0, gapOut = false, upstream = 0, downOcc = 0;
      for (const arr of L.lane) {
        for (let k = 0; k < arr.length; k++) {
          const veh = arr[k], dist = L.length - veh.pos;
          if (veh.v < 2 && dist < 150) { if (!this.dwelling(veh)) queue += veh.pcu; } // the tracker tells a bus at its stop from a queue
          else if (dist / Math.max(veh.v, 1) < 15) arriving += veh.pcu;
          if (dist < 25 && veh.v > 2 && dist / veh.v < 3) gapOut = true;
          if (k < 4) {
            front++;
            // the road it leaves the crossing by: past the short links inside a signal group
            const nxt = this.exitPast(j, veh);
            if (nxt) { downOcc += nxt.occ; if (this.isFull(nxt)) risky++; }
          }
        }
      }
      const up = this.nodes[L.from];
      if (up.type === 'J') for (const veh of up.box) if (veh.box.next === L) upstream += veh.pcu; // platoon look-ahead
      const risk = front ? risky / front : 0;
      // Max-pressure: what is waiting here, discounted by how full the roads it feeds already are.
      const down = front ? downOcc / front : 0;
      const p = (queue + 0.6 * arriving + 0.5 * upstream) * Math.max(0.05, 1 - 1.1 * down) * (1 - 0.85 * risk)
        + queue * Math.min(this.redTime(j, i), 120) / 240;
      return { p, queue, arriving, upstream, risk, gapOut };
    }

    evApproach(j, vipOnly) {
      for (const ev of this.evs) {
        if (vipOnly && !ev.vip) continue;
        // within 350 m along its route: real maps have short links, so look past the end of the road it is on
        let d, k;
        if (ev.state === 'link') { d = ev.link.length - ev.pos; k = ev.ri; }
        else if (ev.state === 'box') { d = ev.box.len - ev.box.s; k = ev.ri + 1; if (k < ev.route.length) d += this.links[ev.route[k]].length; }
        else continue;
        for (; k < ev.route.length && d < EV_REACH_ASKED; k++) {
          const L = this.links[ev.route[k]];
          if (k > ev.ri + (ev.state === 'box' ? 1 : 0)) d += L.length;
          if (d >= EV_REACH_ASKED) break;
          if (this.ctrlId(L.to) === j.id) {
            const i = j.approaches.indexOf(L), p = ev.plan && ev.plan.find(x => x.j === j.id);
            if (i >= 0 && this.evCleared(ev, j) && d < (p && p.ok ? EV_REACH_ASKED : EV_REACH)) { this.evMatch = { ev, d }; return i; } // who it is for and how far away, for the ambulance's timeline
            break;
          }
        }
      }
      return -1;
    }

    // Signal groups. A crossing of divided roads is several junction points in the network (each carriageway
    // meets the other separately), but on the ground one controller runs it. Signalised points within
    // GROUP_R of each other become one group: one signal whose phases are the roads coming in from outside it,
    // in turn; the short links between its points are inside the crossing and are not stopped by it.
    groupSignals() {
      if (this.ring) return;
      const sig = this.isects.filter(j => j.signal && j.level === 0 && !j.circ);
      this.signalGroups = [];
      for (const ms of clusterPoints(sig, GROUP_R, GROUP_SPAN)) {
        if (ms.length < 2) continue;
        // only where a signal point cannot run on its own (one road in): signals that work alone stay as they are
        if (!ms.some(j => j.type !== 'J')) continue;
        // only crossings confirmed by a signal survey: an OSM-only group can stop a road that, in the model, nothing
        // crosses (Sector 62's three: pedestrian or median crossings the model does not carry), adding red time for nobody
        if (!ms.some(j => j.surveySignal || j.inferredSignal)) continue;
        const M = new Set(ms.map(j => j.id));
        const approaches = ms.flatMap(j => j.ins.filter(L => L.kind !== 'slip' && !M.has(L.from))).sort((p, q) => p.bearing - q.bearing);
        if (approaches.length < 2) continue;
        const leader = ms.find(j => j.type === 'J') || ms[0];
        const G = { leader, members: ms, ids: M };
        const s = { phase: 0, state: 'G', t: 0, next: 0 }, lge = approaches.map(() => this.t), partner = pairApproaches(approaches);
        for (const j of ms) {
          j.type = 'J'; j.group = G; j.sig = s; j.approaches = approaches; j.lastGreenEnd = lge; j.slipMerge = false; j.partner = partner;
          j.inferredCtl = ms.some(m => m.inferredSignal) && !ms.some(m => m.surveySignal);
          for (const L of j.ins) L.free = !approaches.includes(L); // slips and the links inside the crossing
          j.free = j.ins.filter(L => L.free);
        }
        this.signalGroups.push(G);
      }
    }
    // Inferred signals, for areas whose OSM data maps almost none (net.inferCrossings) and that have no signal
    // survey yet: every at-grade crossing of two or more mapped roads (the same list as the survey sheet,
    // tools/signal-survey.js) without an OSM signal is taken as signalised and marked inferred, to be confirmed.
    // A survey file replaces this entirely.
    inferSignals() {
      this.inferredCount = 0;
      if (this.ring || !this.net.inferCrossings || this.net.survey) return;
      const GEN = /^(motorway|trunk|primary|secondary|tertiary) road /;
      const pts = this.isects.filter(j => j.level === 0 && !j.circ);
      for (const js of clusterPoints(pts, 45, GROUP_SPAN)) {
        if (js.some(j => j.signal)) continue; // OSM maps a signal here already
        const inG = id => js.some(j => j.id === id);
        const ext = js.flatMap(j => j.ins.concat(j.outs))
          .filter(L => L.level === 0 && L.kind !== 'entry' && L.kind !== 'exit' && L.kind !== 'slip' && !(inG(L.from) && inG(L.to)));
        const roads = new Set(ext.map(L => (L.name && !GEN.test(L.name) ? L.name : `${L.cls || 'road'}:${L.rank}`)));
        if (roads.size < 2 || ext.length < 3) continue; // a bend, a merge or a U-turn point, not a crossing
        // a crossing or T: 3+ roads come in, from at least 2 different roads (two roads merging into one is not signalised)
        const arms = ext.filter(L => inG(L.to));
        const armRoads = new Set(arms.map(L => (L.name && !GEN.test(L.name) ? L.name : `${L.cls || 'road'}:${L.rank}`)));
        if (arms.length < 3 || armRoads.size < 2) continue;
        // never on a motorway or expressway (access-controlled: no signals), e.g. the Delhi-Meerut Expressway
        if (js.some(j => j.ins.concat(j.outs).some(L => L.cls === 'motorway' || /expressway/i.test(L.name || '')))) continue;
        this.inferredCount++;
        for (const j of js) { j.signal = true; j.inferredSignal = true; j.inferredCtl = true; }
        if (js.length === 1) { // one point: a signal of its own, as in the main set-up
          const j = js[0], ap = j.ins.filter(L => L.kind !== 'slip').sort((p, q) => p.bearing - q.bearing);
          if (ap.length < 2) continue;
          j.type = 'J'; j.approaches = ap; j.sig = { phase: 0, state: 'G', t: 0, next: 0 }; j.lastGreenEnd = ap.map(() => this.t); j.slipMerge = false; j.partner = pairApproaches(ap);
          for (const L of j.ins) L.free = L.kind === 'slip';
          j.free = j.ins.filter(L => L.free);
        }
      }
    }

    // The road a vehicle leaves junction j by: past the short links inside a signal group (they are part of the crossing).
    exitPast(j, veh) {
      let r = veh.ri + 1, L = this.links[veh.route[r]];
      while (L && j.group && j.group.ids.has(L.from) && j.group.ids.has(L.to)) L = this.links[veh.route[++r]];
      return L;
    }

    // The node whose signal controls junction point j (itself, or its group's leader).
    ctrl(j) { return j && j.group ? j.group.leader : j; }
    ctrlId(id) { const j = this.nodes[id]; return j && j.group ? j.group.leader.id : id; }

    // May this junction change for this ambulance? Yes unless the controller has been asked and has not approved it.
    evCleared(ev, j) {
      if (!ev.plan || ev.vip) return true;
      const c = this.ctrl(j), p = ev.plan.find(x => x.j === c.id);
      return !p || p.ok === true;
    }

    // SAARTHI's suggestion for an ambulance: every signal on its route, the road it comes in on and when it
    // gets there on an empty road.
    ambulancePlan(ev) {
      let d = 0;
      const plan = [];
      for (const id of ev.route) {
        const L = this.links[id], j = this.ctrl(this.nodes[L.to]);
        d += L.length;
        if (j && j.sig && !L.free) plan.push({ j: j.id, link: L.id, name: this.jName(j), road: L.name || 'the approach road', eta: d, ok: null, lane: this.gcOf(L) != null, inferred: !!(j.group ? j.group.members.some(m => m.inferredSignal) : j.inferredSignal) });
      }
      // reach times on the same empty-road estimate as the whole trip (turns and junctions slow it too)
      for (const p of plan) p.eta = ev.ff > 0 ? p.eta / d * ev.ff : p.eta / ev.v0;
      return plan;
    }

    // Metres along an ambulance's route to junction jId, or null once it has passed it.
    evDistTo(ev, jId) {
      let d, k;
      if (ev.state === 'link') { d = ev.link.length - ev.pos; k = ev.ri; }
      else if (ev.state === 'box') { d = ev.box.len - ev.box.s; k = ev.ri + 1; if (k < ev.route.length) d += this.links[ev.route[k]].length; }
      else if (ev.state === 'backlog') { d = 0; k = 0; if (ev.route.length) d = this.links[ev.route[0]].length; }
      else return null;
      for (; k < ev.route.length; k++) {
        const L = this.links[ev.route[k]];
        if (k > (ev.state === 'backlog' ? 0 : ev.ri + (ev.state === 'box' ? 1 : 0))) d += L.length;
        if (this.ctrlId(L.to) === jId) return d;
      }
      return null;
    }

    // SAARTHI suggests each light change as the ambulance comes within EV_ASK of the signal.
    updateSuggestions() {
      for (const ev of this.evs) {
        if (!ev.plan) continue;
        for (const p of ev.plan) {
          if (p.asked != null || p.ok != null || p.rec) continue;
          const d = this.evDistTo(ev, p.j);
          if (d == null || d > EV_ASK) continue;
          p.asked = this.t; p.askD = d;
          if (this.autoApprove) { this.changeLight(ev, p.j, true); continue; }
          // Already green for it: nothing to ask. SAARTHI keeps it green until it has crossed.
          const c = this.nodes[p.j], i = c.approaches.indexOf(this.links[p.link]);
          if (c.sig.state === 'G' && c.sig.phase === i) {
            p.ok = true; p.okAt = this.t; p.auto = 'green'; c.evKeepFor = ev.id; // so 'kept green' is not told twice
            this.tell(ev, `Light at ${p.name} already green for it (${this.distTxt(d)}): SAARTHI keeps it green, nothing for you to do`, 'light');
            continue;
          }
          this.tell(ev, `SAARTHI suggests: turn the light at ${p.name} green for it on ${p.road} (${this.distTxt(d)})`, 'saarthi');
          this.addLog(`SAARTHI suggests: turn the light at ${p.name} green for the ambulance on ${p.road} (${Math.round(d / 10) * 10} m away)`, 'ev', p.j);
          this.newSuggestion = true;
        }
      }
    }
    // Suggestions waiting for the controller's answer.
    pendingSuggestions() {
      const out = [];
      for (const ev of this.evs) if (ev.plan) for (const p of ev.plan) if (p.asked != null && p.ok == null && !p.rec) out.push({ ev, p, d: this.evDistTo(ev, p.j) });
      return out;
    }
    // The controller's buttons: turn this light green for the ambulance, or leave it on normal control.
    changeLight(ev, jId, auto) {
      const p = ev && ev.plan && ev.plan.find(x => x.j === jId);
      if (!p || p.ok != null || p.rec) return false;
      p.ok = true; p.okAt = this.t; if (auto) p.auto = 'auto';
      if (ev.story) this.tell(ev, auto ? `SAARTHI turned the light at ${p.name} green for it (automatic)` : `Controller turned the light at ${p.name} green for it`, 'controller');
      this.addLog(`${auto ? 'Approved automatically' : 'Controller'}: light at ${p.name} to green for the ambulance on ${p.road}`, 'sent', jId);
      return true;
    }
    leaveLight(ev, jId) {
      const p = ev && ev.plan && ev.plan.find(x => x.j === jId);
      if (!p || p.ok != null || p.rec) return false;
      p.ok = false; p.okAt = this.t;
      if (ev.story) this.tell(ev, `Controller left the light at ${p.name} on normal control`, 'controller');
      this.addLog(`Controller: light at ${p.name} left on normal control for the ambulance`, 'sent', jId);
      return true;
    }

    // The controller's answer: the junction ids to change the light at (the rest stay on SAARTHI's normal control).
    approvePriority(ev, ids) {
      if (!ev || !ev.plan) return;
      for (const p of ev.plan) p.ok = ids.includes(p.j);
      if (ev.story) this.tell(ev, ids.length ? `Controller approved the change at ${ids.length === ev.plan.length ? 'all' : `${ids.length} of`} ${ev.plan.length} signal${ev.plan.length === 1 ? '' : 's'}` : 'Controller declined: no light changes for it', 'controller');
      const n = ids.length, all = ev.plan.length;
      this.addLog(n ? `Controller approved signal priority for the ambulance at ${n === all ? 'all' : n + ' of'} ${all} signal${all === 1 ? '' : 's'} on its route`
        : 'Controller declined signal priority for the ambulance: lights stay on normal control', 'sent');
    }

    // Green corridor on demand: when an ambulance is dispatched, the median lane of every road on its route that
    // has no built lane is cleared for it (drivers alerted, police at the junctions), as Indian cities do for
    // a green corridor. Drivers in it move out where they find a gap; in a standing queue they cannot. Each road
    // opens again as soon as the ambulance has passed it. Roads with a single lane are not cleared.
    clearCorridor(ev) {
      if (this.mode !== 'adaptive' || !this.features.greenCorridor) return;
      ev.corridor = [];
      let built = 0, cleared = 0, none = 0;
      for (const id of ev.route) {
        const L = this.links[id];
        if (L.gc != null) { built += L.length; continue; }
        if (L.lanes < 2 || L.evLane != null || L.circ) { none += L.length; continue; }
        L.evLane = L.lanes - 1; L.evFor = ev.id;
        ev.corridor.push(L);
        cleared += L.length;
      }
      ev.usedGc = ev.usedGc || ev.corridor.length > 0;
      const km = m => (m / 1000).toFixed(1);
      if (cleared) {
        this.addLog(`Green corridor: median lane cleared for the ambulance along ${km(cleared)} km of its route${built ? ` (+ ${km(built)} km of built lane)` : ''}${none > 50 ? `; ${km(none)} km is single-lane` : ''}`, 'ev');
        if (ev.story) this.tell(ev, `Green corridor set up: median lane cleared for it along ${km(cleared)} km${built ? `, ${km(built)} km of built lane` : ''}; each road opens again once it has passed`, 'lane');
      }
    }
    releaseLane(ev, L) {
      if (L.evFor !== ev.id) return;
      L.evLane = null; L.evFor = null;
      ev.corridor = ev.corridor.filter(x => x !== L);
    }

    // The ambulance's timeline, as the controller would read it.
    distTxt(d) { return d < 30 ? 'it is just reaching it' : `it is ${Math.round(d / 10) * 10} m away`; }
    tell(veh, msg, kind) { veh.story.push({ t: this.t, msg, kind: kind || 'step' }); }
    enteredGc(veh, L) {
      if (veh.gcT != null) return;
      veh.gcT = this.t;
      this.tell(veh, `In the green corridor lane on ${L.name || 'its road'}: no traffic ahead of it`, 'lane');
    }

    // Junction-by-junction record of an ambulance trip: how it got through each junction and how long it stood.
    traceCrossing(veh, L, li, jp) {
      const j = this.ctrl(jp), i = j.approaches ? j.approaches.indexOf(L) : -1, sig = !!j.sig && !L.free;
      const onLink = this.t - veh.linkT, ff = L.length / veh.v0;
      let how;
      const ok = this.evCleared(veh, j), lane = sig && ok && this.gcOf(L) != null && li === this.gcOf(L);
      if (!sig) how = 'giveway';
      // switched for it, and green by the time it got there (in its lane it may cross while the light is still changing)
      else if (ok && j.evSwitch && j.evSwitch.i === i && this.t - j.evSwitch.t < 60 && !(lane && this.t < j.evSwitch.t + AMBER + ALL_RED)) how = 'switched';
      else if (ok && j.evKeep && j.evKeep.i === i && this.t - j.evKeep.t < 3) how = 'kept';
      else if (lane) how = 'lane';
      else how = veh.curWait > 2 ? 'red' : 'green';
      const rec = { j: j.id, name: this.jName(j), t: this.t, sig, how, lane, wait: veh.curWait, lost: Math.max(0, onLink - ff),
        lead: how === 'switched' ? this.t - (j.evSwitch.t + AMBER + ALL_RED) : null };
      if (veh.story && sig) {
        const p = veh.plan && veh.plan.find(x => x.j === j.id);
        const what = how === 'switched' ? `on green${rec.lead > 1 ? ` (green for ${Math.round(rec.lead)} s before it got there)` : ''}${lane ? ', in its own lane' : ''}`
          : how === 'lane' ? 'in its own lane, cross traffic held' : how === 'kept' ? `on green, kept green for it${lane ? ', in its own lane' : ''}`
          : how === 'green' ? 'on green (it was green anyway)' : `after standing ${Math.round(rec.wait)} s at red${p && p.ok === false ? ' (left on normal control)' : p && p.ok == null ? ' (light not changed in time)' : ''}`;
        this.tell(veh, `Crossed ${rec.name} ${what}`, how === 'red' ? 'bad' : 'cross');
      }
      veh.trace.push(rec);
      if (veh.plan) { const p = veh.plan.find(x => x.j === j.id && !x.rec); if (p) p.rec = rec; }
    }

    vipApproach(j) { return this.evs.length ? this.evApproach(j, true) : -1; }

    // -------------------------------------------------------------- scenarios
    // Same route in both twins, so the only difference is the road and the control system.
    // Control console: an ambulance on any route, from a map edge or from a point inside the map, to the end of
    // `ids` (the road at a hospital). Signal priority and the corridor lane (where the route uses it) apply as usual.
    dispatchAmbulance(ids, label) {
      const L = this.links[ids[0]];
      let o = L.from;
      if (!this.nodes[o] || this.nodes[o].type !== 'X') { // starts inside the map: a start point on that road
        o = 'A' + L.id;
        if (!this.nodes[o]) {
          const s = { id: o, type: 'V', name: label, entry: L, j: L.to, lanes: this.generalLanes(L), x: L.ax, y: L.ay,
            backlog: [], lastRelease: -1e9, stallT: 0, metered: false, meterLogT: -1e9, demand: 0, from: 0, until: 0, rate: 0, dests: [] };
          this.nodes[o] = s;
          this.sources.push(s);
        }
      }
      const last = this.links[ids[ids.length - 1]];
      const ev = this.newVehicle(o, last.to, 'ev', 0, true, { ids });
      ev.usedGc = ids.some(id => this.links[id].gc != null);
      ev.trace = []; ev.story = [];
      this.tell(ev, `Ambulance reported: ${label}`);
      this.clearCorridor(ev);
      if (this.priorityApproval && this.mode === 'adaptive' && this.features.signalPriority) ev.plan = this.ambulancePlan(ev);
      if (ev.plan && ev.plan.length) this.tell(ev, `${ev.plan.length} signal${ev.plan.length === 1 ? '' : 's'} on its route: ${this.autoApprove ? 'SAARTHI turns each light green for it as it gets close' : 'SAARTHI will suggest each light change as it gets close'}`, 'saarthi');
      ev.evEntry = this.addEvent({ kind: 'ambulance', label: `Ambulance · ${label}`, arriveAt: null, tt: null, delay: null, ff: ev.ff, veh: ev });
      this.nodes[o].backlog.unshift(ev);
      this.evs.push(ev);
      this.addLog(`Ambulance dispatched: ${label}${ev.usedGc ? ' (uses the green corridor lane)' : ''}`, 'ev');
      return ev;
    }

    triggerAmbulance() {
      const a = this.hooks.ambulance, x = this.nodes[a.origin];
      const ev = this.newVehicle(a.origin, a.dest, 'ev', 0, true, this.ambRoute || undefined);
      ev.usedGc = this.gcBuilt;
      ev.trace = []; ev.story = [];
      this.tell(ev, `Ambulance reported: ${a.label}`);
      this.clearCorridor(ev);
      if (this.priorityApproval && this.mode === 'adaptive' && this.features.signalPriority) ev.plan = this.ambulancePlan(ev);
      if (ev.plan && ev.plan.length) this.tell(ev, `${ev.plan.length} signal${ev.plan.length === 1 ? '' : 's'} on its route: ${this.autoApprove ? 'SAARTHI turns each light green for it as it gets close' : 'SAARTHI will suggest each light change as it gets close'}`, 'saarthi');
      ev.evEntry = this.addEvent({ kind: 'ambulance', label: `Ambulance · ${a.label}`, arriveAt: null, tt: null, delay: null, ff: ev.ff, veh: ev });
      x.backlog.unshift(ev);
      this.evs.push(ev);
      this.addLog(`Ambulance dispatched: ${a.label}${this.gcBuilt ? ' (green corridor lane)' : ''}`, 'ev');
      if (ev.plan && ev.plan.length) this.addLog(`${ev.plan.length} signal${ev.plan.length === 1 ? '' : 's'} on the ambulance's route: SAARTHI will suggest each light change to the controller`, 'ev');
      return ev;
    }

    // Illegal parking (or a crash, when `label` is given). With vision enforcement the camera flags it
    // in ~30 s and a tow clears it ~6 min after it starts; without, a patrol or a complaint finds it
    // after ~9 min and it is cleared after ~15.
    // `clearMins` (control console): the controller's own estimate of when it is cleared.
    triggerBlockage(linkId, label, lane, clearMins) {
      const L = this.links[linkId || this.hooks.parking];
      const auto = this.mode === 'adaptive' && this.features.enforcement;
      const mins = clearMins || (auto ? 6 : 15);
      const lanes = [].concat(lane || 0); // one lane, or several (a crash across two lanes)
      L.blockage = { lane: lanes[0], lanes, on: Array.from({ length: L.lanes }, (_, i) => lanes.includes(i)),
        pos: L.length * 0.55, until: this.t + mins * 60, start: this.t, label: label || 'illegal parking' };
      const area = [L].concat(this.nodes[L.from].ins || []);
      this.addEvent({ kind: label ? 'crash' : 'parking', label: `${label || 'Illegal parking'} · ${L.name}`, link: L.id,
        detectAt: this.t + (auto ? 30 : 9 * 60), clearAt: L.blockage.until, normalAt: null, lost: 0,
        area: area.map(M => M.id), base: area.reduce((s, M) => s + (M.stopEma || 0), 0), okN: 0 });
      if (clearMins) {
        this.addLog(`${label || 'Illegal parking'} on ${L.name}: ${lanes.length > 1 ? lanes.length + ' lanes' : 'one lane'} blocked, expected clear in ${clearMins} min`, 'alert');
        return;
      }
      if (label) {
        this.addLog(`${label} on ${L.name}: ${auto
          ? 'deviation from plan captured by camera → tow dispatched (~6 min), VMS rebalancing the diversion' : 'no auto-detection, found by patrol and cleared (~15 min)'}`, 'alert');
        return;
      }
      this.addLog(`Illegal parking blocks kerb lane on ${L.name}: ${auto
        ? 'vision enforcement flagged it, tow dispatched (~6 min)' : 'no auto-detection, cleared manually (~15 min)'}`, 'alert');
    }

    triggerSurge(origin, factor, mins) {
      origin = origin || this.hooks.surge.origin;
      this.surges.push({ origin, factor, until: this.t + mins * 60 });
      this.addEvent({ kind: 'surge', label: `Event surge · ${this.nodes[origin].name}`, clearAt: this.t + mins * 60, normalAt: null,
        lost: 0, base: this.totalEma || 0, okN: 0 });
      this.addLog(`Demand surge: ${this.nodes[origin].name} +${Math.round((factor - 1) * 100)}% for ${mins} min`, 'info');
    }

    triggerCameraFault(jId, mins) {
      jId = jId || this.hooks.fault;
      const j = this.nodes[jId];
      j.faultUntil = this.t + mins * 60;
      j.faultLogged = false;
      this.addEvent({ kind: 'camera', label: `Camera fault · ${jId}`, clearAt: j.faultUntil, affects: this.mode === 'adaptive' });
      if (this.mode !== 'adaptive') this.addLog(`Camera fault at ${jId}: no effect, fixed timers don't use cameras`, 'info');
    }

    // ---------------------------------------------------------------- event stopwatch
    // Every injected event gets a timeline (start → spotted → cleared → traffic back to normal) and the
    // vehicle-minutes it cost, so the two twins can be compared event by event.
    addEvent(e) {
      const ev = Object.assign({ n: this.eventLog.length, start: this.t }, e);
      this.eventLog.push(ev);
      return ev;
    }

    stoppedOn(L) {
      let n = 0;
      for (const arr of L.lane) for (const v of arr) if (v.v < 0.5) n++;
      return n;
    }

    trackEvents() { // every 30 s
      let total = 0;
      for (const L of this.linkList) {
        const s = this.stoppedOn(L);
        total += s;
        L.stopEma = L.stopEma == null ? s : L.stopEma + 0.12 * (s - L.stopEma);
        L.stopNow = s;
      }
      for (const x of this.externals) total += x.backlog.length;
      const openEvent = this.eventLog.some(e => (e.kind === 'parking' || e.kind === 'crash' || e.kind === 'surge') && e.normalAt == null);
      if (!openEvent) this.totalEma = this.totalEma == null ? total : this.totalEma + 0.12 * (total - this.totalEma); // baseline outside events
      for (const e of this.eventLog) {
        if (e.normalAt != null || !(e.kind === 'parking' || e.kind === 'crash' || e.kind === 'surge')) continue;
        if (this.t - e.start > 3 * 3600) continue; // give up tracking after 3 h
        const now = e.kind === 'surge' ? total : e.area.reduce((s, id) => s + this.links[id].stopNow, 0);
        const extra = now - e.base;
        if (extra > 0) e.lost += extra * 0.5; // vehicle-minutes lost to the event (30 s samples)
        if (this.t >= e.clearAt) {
          if (now <= e.base * (e.kind === 'surge' ? 1.1 : 1.2) + (e.kind === 'surge' ? 8 : 3)) {
            if (++e.okN === 1) e.okAt = this.t;
            if (e.okN >= 2) { e.normalAt = e.okAt; this.addLog(`${e.label}: traffic back to normal, ${fmtDur(e.normalAt - e.start)} after it started`, 'info'); }
          } else e.okN = 0;
        }
      }
    }

    addLog(msg, kind, at) {
      if (this.quiet) return;
      this.log.push({ t: this.t, msg, kind, at }); // at: the junction it is about, if any
      if (this.log.length > 150) this.log.shift();
    }

    // -------------------------------------------------------------- measurement
    vehicleCounts() {
      let inNet = 0, queued = 0, backlog = 0;
      for (const L of this.linkList) for (const arr of L.lane) for (const v of arr) { inNet++; if (v.v < 0.5) queued++; }
      for (const j of this.isects) inNet += j.box.length;
      for (const x of this.externals) backlog += x.backlog.length;
      for (const s of this.sources) backlog += s.backlog.length;
      return { inNet, queued, backlog };
    }

    kpis() {
      const since = this.t - WINDOW;
      while (this.trips.length && this.trips[0].t < since) this.trips.shift();
      while (this.crossings.length && this.crossings[0].t < since) this.crossings.shift();
      const tr = this.trips, n = tr.length;
      const span = Math.min(WINDOW, this.t - this.t0);
      const tts = tr.map(r => r.tt).sort((a, b) => a - b);
      const cd = this.hooks.corridor;
      const corr = tr.filter(r => r.o === cd.o && r.d === cd.d).map(r => r.tt);
      const ev = this.stats.evTrips[this.stats.evTrips.length - 1];
      const perJ = {};
      for (const j of this.junctions) perJ[j.id] = mean(this.crossings.filter(c => c.j === j.id).map(c => c.wait));
      return Object.assign({
        n,
        avgTrip: mean(tts),
        p95: n >= 5 ? quantile(tts, 0.95) : null,
        corridor: mean(corr),
        avgDelay: mean(tr.map(r => r.tt - r.ff)),
        wait: mean(this.crossings.map(c => c.wait)),
        waitByJ: perJ,
        throughput: span >= 120 ? n * 3600 / span : null,
        stops: mean(tr.map(r => r.stops)),
        fuel: mean(tr.map(r => r.fuel)),
        gridlockEvents: this.stats.gridlockEvents,
        gridlockMin: this.stats.gridlockSeconds / 60,
        evDelay: ev ? ev.delay : null,
        evCount: this.stats.evTrips.length,
        diverted: this.stats.diverted,
        nudged: this.stats.nudged,
        turnedBack: this.stats.turnedBack,
        rerouted: this.stats.rerouted,
        vipDelay: this.stats.vipTrips.length ? Math.max(...this.stats.vipTrips.map(v => v.delay)) : null,
      }, this.vehicleCounts());
    }

    sample() {
      const k = this.kpis();
      this.series.push({ t: this.t, p95: k.p95, avgTrip: k.avgTrip, inNet: k.inNet, backlog: k.backlog, queued: k.queued, throughput: k.throughput });
      if (this.series.length > 3000) this.series.shift();
    }

    turnType(inL, outL) {
      const ox = outL.su[0], oy = outL.sv[0];
      const dot = inL.eu * ox + inL.ev * oy;
      if (dot > 0.6) return 'T';
      return inL.eu * oy - inL.ev * ox < 0 ? 'L' : 'R';
    }

    // Mirrors the edge → centre MQTT message on deck slide 7.
    edgeState(j, i) {
      const L = j.approaches[i];
      const turns = { L: 0, T: 0, R: 0 };
      let total = 0;
      const lanes = L.lane.map((arr, li) => {
        let queueM = 0, pcu = 0, spd = 0;
        for (const veh of arr) {
          const dist = L.length - veh.pos;
          if (dist < 150) pcu += veh.pcu;
          if (veh.v < 2) queueM = Math.max(queueM, L.length - (veh.pos - veh.len));
          spd += veh.v;
          const nxt = this.links[veh.route[veh.ri + 1]];
          if (nxt) { turns[this.turnType(L, nxt)]++; total++; }
        }
        const fl = L.flow[li];
        while (fl.length && fl[0].t < this.t - 60) fl.shift();
        return {
          lane: li + 1,
          queue_m: Math.round(queueM),
          pcu: +pcu.toFixed(1),
          flow_pcu_min: +fl.reduce((s, f) => s + f.pcu, 0).toFixed(1),
          avg_speed: arr.length ? Math.round(spd / arr.length * 3.6) : 0,
        };
      });
      const r = x => (total ? +(x / total).toFixed(2) : 0);
      return { junction_id: j.id, approach: L.approach, lanes, turning: { L: r(turns.L), T: r(turns.T), R: r(turns.R) }, incident: !!L.blockage || j.boxBlocked };
    }

    // ---------------------------------------------------------- manual override (control console)
    // The controller takes a signal over for a set time: hold green on one road, run the fixed plan, or switch it
    // to flashing amber (signal off; drivers give way). Safety stays: a switch still runs amber and all-red, and
    // the current green has run at least OVR_MIN_GREEN s. An ambulance with priority still gets its green.
    // It returns to SAARTHI by itself when the time is up.
    setOverride(j, mode, i, mins) {
      const c = this.ctrl(j);
      if (!c || !c.sig) return false;
      const was = c.ovr;
      c.ovr = { mode, i: mode === 'hold' ? i : null, from: this.t, until: this.t + mins * 60 };
      this.addLog(`Manual override at ${this.jName(c)}: ${this.ovrText(c)} for ${mins} min${was ? ' (replaces the previous one)' : ''}`, 'sent', c.id);
      return true;
    }
    extendOverride(j, mins) {
      const c = this.ctrl(j);
      if (!c || !c.ovr) return false;
      c.ovr.until += mins * 60;
      this.addLog(`Manual override at ${this.jName(c)} extended by ${mins} min, until ${fmtClock(c.ovr.until).slice(0, 5)}`, 'sent', c.id);
      return true;
    }
    clearOverride(j, why) {
      const c = this.ctrl(j);
      if (!c || !c.ovr) return false;
      c.ovr = null;
      this.addLog(`Manual override at ${this.jName(c)} ended (${why || 'by the controller'}): back to SAARTHI`, 'sent', c.id);
      return true;
    }
    ovrText(c) {
      const o = c.ovr;
      if (!o) return '';
      return o.mode === 'hold' ? `green held for ${(n => (!n ? 'an unnamed road' : /^(motorway|trunk|primary|secondary|tertiary) road /.test(n) ? `an unnamed ${n.split(' ')[0]} road` : n))(c.approaches[o.i].name)}` : o.mode === 'fixed' ? 'fixed signal plan' : 'flashing amber (signal off, drivers give way)';
    }
    overrideDecide(j, decide) {
      const o = j.ovr;
      if (o.mode === 'flash') return null;
      // an ambulance (or VIP convoy) with priority: SAARTHI gives it its green as usual
      if ((this.mode === 'adaptive' && this.features.signalPriority ? this.evApproach(j) : this.vipApproach(j)) >= 0) return decide(this, j);
      if (o.mode === 'fixed') return fixedDecide(this, j);
      if (canon(j, j.sig.phase) !== canon(j, o.i) && j.sig.t >= OVR_MIN_GREEN) return { next: o.i, reason: 'manual' };
      return null;
    }

    approachInfo(j) {
      return j.approaches.map((L, i) => {
        let queue = 0;
        for (const arr of L.lane) for (const v of arr) if (v.v < 2 && L.length - v.pos < 150) queue += v.pcu;
        const s = j.sig, mine = greenFor(j, i);
        return { name: L.name, approach: L.approach, queue, state: mine ? s.state : 'R', plan: j.plan[i], red: this.redTime(j, i) };
      });
    }
  }

  const api = { Sim, VTYPES, NETWORK, DT, JR, LANE_W, MEDIAN, lanePoint, laneOffset, sideOffset, frameAt, networkById, bezPoint, bezTangent,
    fmtClock, fmtDur, profileAt, quantile, mean };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SAARTHI = api;
})(typeof window !== 'undefined' ? window : globalThis);
