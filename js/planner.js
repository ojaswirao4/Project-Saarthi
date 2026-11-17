/*
 * Project SAARTHI — what-if planner. DOM-free, so it runs in the browser and in Node (tools/whatif.js).
 *
 * Takes a disruption the city knows is coming (a protest closure, a VIP movement, a big event),
 * builds candidate traffic plans for it, simulates every candidate on identical traffic next to
 * today's approach (barricades + fixed timers), ranks them and writes the recommendation.
 * Optionally replays the recommended plan with an unplanned disturbance to show it being caught
 * and corrected.
 *
 * Runs on the schematic Film City loop ('fc') or on a real OpenStreetMap area ('fco', 'cp', 's62').
 * On a real area a protest closes a stretch of a named road in both directions, a VIP route follows
 * the quickest road between two map-edge entries, and an event's crowd leaves from a real landmark.
 */
(function (root) {
  'use strict';
  const S = typeof module !== 'undefined' && module.exports ? require('./engine.js') : root.SAARTHI;
  const { Sim, NETWORK, fmtClock, fmtDur, quantile, mean } = S;

  const XN = Object.fromEntries(NETWORK.externals.map(x => [x.id, x]));
  const hhmm = h => fmtClock(h * 3600).slice(0, 5);

  // Where each disruption can happen. Real areas: a protest closes `road` (both carriageways) wherever its
  // midpoint is within `r` m of junction `at`; a VIP route runs from entry `origin` to exit `dest`; an event's
  // crowd leaves from the roads nearest the landmark at `at` (lat, lon, from OpenStreetMap).
  const AREAS = {
    fco: {
      label: 'Film City corridor · OpenStreetMap', offices: 'Film City and Sector 16A / 18', handles: 'the Sector 94 ITMS handles',
      protest: [
        { key: 'dmr', name: 'Dadri Main Road at the Film City Flyover', road: 'Dadri Main Road', at: 'P90', r: 400 },
        { key: 'vtm', name: 'Lt. Vijyant Thapar Marg at Tulsi Marg', road: 'Lieutenant Vijyant Thapar Marg', at: 'J2', r: 300 },
        { key: 'mam', name: 'Maharaja Agrasen Marg at the Film City Flyover', road: 'Maharaja Agrasen Marg', at: 'P85', r: 300 },
      ],
      vip: [
        { key: 'dnd-exp', name: 'DND Flyway → Noida–Greater Noida Expressway', origin: 'X2', dest: 'X39' },
        { key: 'exp-dnd', name: 'Noida–Greater Noida Expressway → DND Flyway', origin: 'X38', dest: 'X16' },
      ],
      venue: { name: 'Sector 18, by the metro station', at: [28.5708, 77.3261] },
    },
    cp: {
      label: 'Connaught Place · OpenStreetMap', offices: 'Connaught Place', handles: 'Delhi Traffic Police handles',
      protest: [
        { key: 'sansad', name: 'Sansad Marg at Tolstoy Marg', road: 'Sansad Marg', at: 'J12', r: 300 },
        { key: 'janpath', name: 'Janpath, Tolstoy Marg to the Outer Circle', road: 'Janpath', at: 'J10', r: 400 },
        { key: 'barakhamba', name: 'Barakhamba Road at the Outer Circle', road: 'Barakhamba Road', at: 'J9', r: 400 },
      ],
      vip: [
        { key: 'barakhamba-sansad', name: 'Barakhamba Road → Sansad Marg', origin: 'X20', dest: 'X25' },
        { key: 'janpath-chelmsford', name: 'Janpath → Chelmsford Road', origin: 'X27', dest: 'X4' },
      ],
      venue: { name: 'Central Park, Connaught Place', at: [28.6328, 77.2197] },
    },
    s62: {
      label: 'Sector 62 Noida · OpenStreetMap', offices: 'Sector 62', handles: 'the Sector 94 ITMS handles',
      protest: [
        { key: 'vishwakarma', name: 'Vishwakarma Road by the Sector 62 metro', road: 'Vishwakarma Road', at: 'J5', r: 350 },
        { key: 'vishwas', name: 'Vishwas Marg at Sushil Marg', road: 'Vishwas Marg', at: 'J1', r: 400 },
      ],
      vip: [
        { key: 'dme', name: 'Delhi–Meerut Expressway, east → west', origin: 'X14', dest: 'X13' },
      ],
      venue: { name: 'Sector 62, by the metro station', at: [28.6255, 77.3743] },
    },
    s34: {
      label: 'Sector 34 Noida · OpenStreetMap', offices: 'Sector 34', handles: 'the Sector 94 ITMS handles',
      protest: [
        { key: 'sscsm', name: 'Shaheed Capt. Shashikant Sharma Marg at Main Road Gijhor', road: 'Shaheed Captain Shashikant Sharma Marg', at: 'J2', r: 350 },
        { key: 'gijhor', name: 'Main Road Gijhor, north of the crossing', road: 'Main Road Gijhor', at: 'J1', r: 400 },
        { key: 'citycenter', name: 'City Center Marg', road: 'City Center Marg', at: 'P30', r: 400 },
      ],
      vip: [
        { key: 'sscsm', name: 'Shaheed Capt. Shashikant Sharma Marg, south-west → north-east', origin: 'X34', dest: 'X15' },
        { key: 'gijhor', name: 'Main Road Gijhor → Shashikant Sharma Marg (south-west)', origin: 'X8', dest: 'X35' },
      ],
      venue: { name: 'Sector 34, by the metro station', at: [28.5803, 77.3635] },
    },
    fc: {
      label: 'Film City loop · schematic', offices: 'Sector 16A / 18', handles: 'the Sector 94 ITMS handles', schematic: true,
      protest: [
        { key: 'north', a: 'FC-01', b: 'FC-03', name: 'FC-01 ↔ FC-03 (north side)' },
        { key: 'east', a: 'FC-03', b: 'FC-04', name: 'FC-03 ↔ FC-04 (east side)' },
        { key: 'south', a: 'FC-04', b: 'FC-02', name: 'FC-04 ↔ FC-02 (south side)' },
        { key: 'west', a: 'FC-02', b: 'FC-01', name: 'FC-02 ↔ FC-01 (west side)' },
      ],
      vip: [
        { key: 'DND-GNO', name: 'DND Flyway → FC-01 → FC-03 → FC-04 → Greater Noida', origin: 'DND', dest: 'GNO', dir: 1 },
        { key: 'EXP-S18', name: 'Expressway → FC-02 → FC-04 → FC-03 → Sector 18', origin: 'EXP', dest: 'S18', dir: -1 },
      ],
      venue: { name: 'Sector 18' },
    },
  };
  const DEFAULT_AREA = 'fco';
  const TYPES = {
    protest: { label: 'Protest / rally', defaults: { start: 10, duration: 1 } },
    vip: { label: 'VIP movement', defaults: { start: 9.5, duration: 1.5, convoys: 2, holiday: 0.15 } },
    event: { label: 'Big event', defaults: { start: 17, duration: 1.5, surge: 0.8, crowd: 800 } },
  };
  // Every field an input can have, with this area's first site and route as the defaults.
  function defaultsFor(type, area) {
    const A = AREAS[area] || AREAS[DEFAULT_AREA];
    const d = Object.assign({ area: AREAS[area] ? area : DEFAULT_AREA }, TYPES[type].defaults);
    if (type === 'protest') d.segment = A.protest[0].key;
    if (type === 'vip') d.vipRoute = A.vip[0].key;
    if (type === 'event' && A.schematic) delete d.crowd;
    if (type === 'event' && !A.schematic) delete d.surge;
    return d;
  }

  // Geometry and route options only (one per area, built on first use).
  const geos = {};
  const geoFor = area => geos[area] || (geos[area] = new Sim({ mode: 'fixed', seed: 1, startHour: 0, network: area }));

  // ---------------------------------------------------------------- schematic-loop helpers
  function ringLinks(a, b, dir) {
    const R = NETWORK.ring, n = R.length, out = [];
    let i = R.indexOf(a);
    while (R[i] !== b) { const k = (i + dir + n) % n; out.push(`${R[i]}>${R[k]}`); i = k; }
    return out;
  }

  function routeText(ids) {
    const js = ids.slice(0, -1).map(id => id.split('>')[1]);
    return [XN[ids[0].split('>')[0]].name].concat(js, [XN[ids[ids.length - 1].split('>')[1]].name]).join(' → ');
  }

  // ---------------------------------------------------------------- real-area helpers
  const GENERIC = /^(motorway|trunk|primary|secondary|tertiary) road [PJXA]\d/;
  const plainName = n => n.replace(/ \((N|S|E|W|NE|NW|SE|SW)\)$/, '');

  // Road names along a list of link ids, each once in driving order (unnamed OSM links skipped).
  function roadNames(g, ids) {
    const out = [];
    for (const id of ids) {
      const n = g.links[id].name;
      if (!GENERIC.test(n) && out[out.length - 1] !== n) out.push(n);
    }
    return out;
  }
  const pathLen = (g, ids) => ids.reduce((s, id) => s + g.links[id].length, 0);
  const midPt = L => L.pts[Math.floor(L.pts.length / 2)];
  const distTo = (L, x, y) => Math.min(...L.pts.map(p => Math.hypot(p[0] - x, p[1] - y)));
  const ffCost = L => L.length / L.vmax + (L.from[0] === 'J' ? 8 : 2); // as routeOptions: free flow, a little for each junction

  function siteLinks(g, site) {
    const a = g.nodes[site.at];
    return g.linkList.filter(L => L.kind === 'road' && L.level === 0 && L.name === site.road
      && Math.hypot(midPt(L)[0] - a.x, midPt(L)[1] - a.y) < site.r).map(L => L.id);
  }

  // The crowd leaves from the two roads nearest the landmark (both carriageways where there are two);
  // attendees park on the kerb lanes of the main roads within 250 m.
  function venueOf(g, A) {
    const [lat0, lon0] = g.net.center, kx = Math.cos(lat0 * Math.PI / 180) * 111320, ky = 110540;
    return venueAt(g, (A.venue.at[1] - lon0) * kx + g.net.size.w / 2, -(A.venue.at[0] - lat0) * ky + g.net.size.h / 2);
  }
  // The same for any point on the map (the control console: the controller clicks where the event is).
  function venueAt(g, x, y) {
    const near = g.linkList.filter(L => L.kind === 'road' && L.level === 0 && g.generalLanes(L) >= 2)
      .map(L => ({ L, d: distTo(L, x, y) })).sort((p, q) => p.d - q.d);
    const first = near[0].L;
    const turn = L => Math.abs(((L.bearing - first.bearing) % 360 + 540) % 360 - 180); // 0 = same way, 180 = opposite
    const second = (near.find(n => n.L !== first && turn(n.L) > 120 && n.d < near[0].d + 150)
      || near.find(n => n.L !== first && n.L.from !== first.to && n.L.to !== first.from)).L;
    const park = near.filter(n => n.d < 250).slice(0, 4).map(n => n.L.id);
    return { x, y, links: [first.id, second.id], park };
  }

  // Quickest route (at free flow) from road `fromId` to a point on the map, such as a hospital: it ends on one of
  // the ground-level roads nearest the point. Null if there's no way there.
  function routeToPoint(g, fromId, x, y) {
    const cands = g.linkList.filter(L => L.kind !== 'entry' && L.kind !== 'exit' && L.level <= 0)
      .map(L => ({ L, d: distTo(L, x, y) })).sort((p, q) => p.d - q.d).slice(0, 8);
    let best = null;
    for (const { L, d } of cands) {
      if (d > cands[0].d + 120) break;
      const p = g.shortest(fromId, L.from, ffCost);
      if (!p) continue;
      const end = p[p.length - 1], ids = end === L.id ? p : (g.moves[end] || []).includes(L) ? p.concat(L.id) : null;
      if (!ids) continue;
      const cost = ids.reduce((s, id) => s + ffCost(g.links[id]), 0) + d / 3; // the gap to the gate counts a little
      if (!best || cost < best.cost) best = { ids, cost };
    }
    return best && best.ids;
  }

  // ---------------------------------------------------------------- public diversions
  // Origin–destination pairs whose usual road is closed, the way round for them, and the ones left with no
  // way through on the mapped roads (they go round off the map).
  function publicDiversions(P, closedIds) {
    if (!closedIds.length) return [];
    const closed = new Set(closedIds);
    if (P.schematic) {
      const geo = geoFor('fc'), out = [];
      for (const o of Object.keys(NETWORK.od)) {
        for (const d of Object.keys(NETWORK.od[o])) {
          const opts = geo.routeOptions(o, d);
          if (opts.length < 2) continue;
          const usual = opts[0].len <= opts[1].len ? opts[0] : opts[1], other = usual === opts[0] ? opts[1] : opts[0];
          if (!usual.ids.some(id => closed.has(id)) || other.ids.some(id => closed.has(id))) continue;
          const n = other.ids.length - usual.ids.length;
          out.push({ vol: NETWORK.od[o][d] * XN[o].demand, from: XN[o].name, to: XN[d].name, ids: other.ids,
            via: routeText(other.ids).split(' → ').slice(1, -1).join(' → '), extra: n > 0 ? `${n} more junction${n > 1 ? 's' : ''}` : '' });
        }
      }
      return out.sort((p, q) => q.vol - p.vol);
    }
    const g = geoFor(P.area), groups = new Map();
    for (const x of g.externals) {
      if (!x.demand) continue;
      for (const [d, sh] of Object.entries(g.net.od[x.id])) {
        const usual = g.routeOptions(x.id, d)[0];
        if (!usual || !usual.ids.some(id => closed.has(id))) continue;
        const alt = g.shortest(x.entry.id, d, L => (closed.has(L.id) ? Infinity : ffCost(L)));
        const from = x.name, to = g.nodes[d].name, key = `${from}|${to}`; // compass kept: both ends of a road can be on the map
        const r = groups.get(key) || { vol: 0, from, to, ids: null, via: null, extra: '', noWay: !alt };
        r.vol += x.demand * sh;
        if (alt && !r.ids) {
          r.ids = alt; r.noWay = false;
          r.via = roadNames(g, alt.slice(1, -1)).join(' → ') || 'local roads';
          const km = (pathLen(g, alt) - pathLen(g, usual.ids)) / 1000;
          r.extra = km > 0.15 ? `${km.toFixed(1)} km longer` : 'about the same distance';
        }
        groups.set(key, r);
      }
    }
    return [...groups.values()].sort((p, q) => q.vol - p.vol);
  }

  // Share of the area's traffic whose usual route crosses the closure and has no way through on the mapped roads.
  function strandedShare(P, closedIds) {
    if (P.schematic || !closedIds.length) return 0;
    const g = geoFor(P.area), closed = new Set(closedIds);
    let all = 0, none = 0;
    for (const x of g.externals) {
      if (!x.demand) continue;
      for (const [d, sh] of Object.entries(g.net.od[x.id])) {
        all += x.demand * sh;
        const usual = g.routeOptions(x.id, d)[0];
        if (usual && usual.ids.some(id => closed.has(id)) && !g.shortest(x.entry.id, d, L => (closed.has(L.id) ? Infinity : L.length))) none += x.demand * sh;
      }
    }
    return all ? none / all : 0;
  }

  // A junction a marshal can be sent to: OSM's name, or the roads that meet there.
  function junctionLabel(sim, j) {
    if (sim.ring) return `${j.id} (${j.name})`;
    if (j.name && !/unnamed/i.test(j.name)) return j.name;
    const ns = [...new Set(j.ins.concat(j.outs).map(L => L.name).filter(n => !GENERIC.test(n)))];
    if (ns.length) return ns.length > 1 ? `the junction of ${ns[0]} and ${ns[1]}` : `the junction on ${ns[0]}`;
    let near = null; // only unnamed OSM roads meet here: the nearest named road says where it is
    for (const L of sim.linkList) {
      if (GENERIC.test(L.name) || L.kind === 'entry' || L.kind === 'exit') continue;
      const d = Math.min(...L.pts.map(p => Math.hypot(p[0] - j.x, p[1] - j.y)));
      if (!near || d < near.d) near = { d, name: L.name };
    }
    return near ? `the junction just off ${near.name} (${Math.round(near.d / 10) * 10} m away)` : `junction ${j.id}`;
  }

  const linkName = id => id.replace('>', '→');
  const listLinks = ids => ids.map(linkName).join(', ');
  const roadsText = (P, ids) => (P.schematic ? listLinks(ids) : roadNames(geoFor(P.area), ids).join(', '));

  // ---------------------------------------------------------------- candidate plans
  function build(input) {
    const inp = Object.assign(defaultsFor(input.type, input.area), input);
    const A = AREAS[inp.area] || AREAS[DEFAULT_AREA];
    inp.area = AREAS[inp.area] ? inp.area : DEFAULT_AREA;
    const start = +inp.start, duration = +inp.duration, end = start + duration;
    const P = { input: inp, type: inp.type, area: inp.area, schematic: !!A.schematic, areaLabel: A.label, start, end, arms: [] };
    const g = P.schematic ? null : geoFor(P.area);

    if (inp.type === 'protest') {
      const seg = A.protest.find(s => s.key === inp.segment) || A.protest[0];
      inp.segment = seg.key;
      const links = P.schematic ? [`${seg.a}>${seg.b}`, `${seg.b}>${seg.a}`] : siteLinks(g, seg);
      const closures = [{ links, from: start, until: end, label: 'Protest' }];
      P.title = `Protest closes ${seg.name}, ${hhmm(start)}–${hhmm(end)}`;
      P.site = seg;
      P.simFrom = start - 0.5; P.measureFrom = start - 0.25; P.simTo = end + 0.5;
      P.closed = links; P.incidentAt = start + Math.min(0.5, duration / 2);
      P.arms = [
        { key: 'today', name: 'Today: barricades + fixed timers', short: 'Today', mode: 'fixed', baseline: true,
          desc: 'Police barricade both ends when the rally starts. Drivers hear about it from the news (25%) or find out at the barricade.',
          scenario: { closures, awareness: 0.25, announceAt: start - 2 } },
        { key: 'live', name: 'SAARTHI, not told in advance', short: 'SAARTHI live', mode: 'adaptive',
          desc: 'Cameras spot the closure about 90 s after it starts, then VMS and navigation divert traffic. Shows what pre-loading the plan adds.',
          scenario: { closures, awareness: 0 } },
        { key: 'plan', name: 'Pre-planned diversion', short: 'Pre-planned', mode: 'adaptive', plan: true, effort: 1,
          desc: 'Closure loaded into SAARTHI the day before and published to maps, SMS and VMS. 80% of drivers plan around it; signals re-time for the diverted flows.',
          scenario: { closures, awareness: 0.8, preloaded: true } },
        { key: 'planPlus', name: 'Pre-planned + staggered office hours', short: '+ staggering', mode: 'adaptive', plan: true, effort: 2,
          desc: `As pre-planned, and offices around ${A.offices} stagger start times or allow work-from-home (−10% demand during the closure).`,
          scenario: { closures, awareness: 0.8, preloaded: true, demand: [{ from: start - 0.25, until: end, factor: 0.9, label: 'Staggered office hours' }] } },
      ];
    } else if (inp.type === 'vip') {
      const vr = A.vip.find(v => v.key === inp.vipRoute) || A.vip[0];
      inp.vipRoute = vr.key;
      let vipLinks, route, junctions;
      if (P.schematic) {
        vipLinks = ringLinks(XN[vr.origin].j, XN[vr.dest].j, vr.dir);
        route = routeText(geoFor('fc').routeOptions(vr.origin, vr.dest).find(r => r.dir === vr.dir).ids);
        junctions = [...new Set(vipLinks.flatMap(id => id.split('>')))];
      } else {
        const ids = g.routeOptions(vr.origin, vr.dest)[0].ids;
        vipLinks = ids.filter(id => g.links[id].kind !== 'entry' && g.links[id].kind !== 'exit');
        route = [plainName(g.nodes[vr.origin].name)].concat(roadNames(g, vipLinks), [plainName(g.nodes[vr.dest].name)])
          .filter((n, i, a) => n !== a[i - 1]).join(' → ');
        junctions = [...new Set(vipLinks.map(id => g.links[id].to))].filter(id => g.nodes[id].sig).map(id => g.nodes[id].name);
      }
      // A reserved lane only where the public keeps at least one lane of its own
      const laneLinks = P.schematic ? vipLinks : vipLinks.filter(id => g.generalLanes(g.links[id]) >= 2);
      const n = Math.max(1, +inp.convoys);
      const times = Array.from({ length: n }, (_, i) => start + (i + 0.5) * duration / n);
      const convoys = times.map((at, i) => ({ at, origin: vr.origin, dest: vr.dest, dir: vr.dir, size: 4, label: `VIP convoy ${i + 1}` }));
      const holiday = +inp.holiday > 0 ? [{ from: start - 3, until: end + 3, factor: 1 - inp.holiday, label: 'Schools & offices closed' }] : [];
      const full = [{ links: vipLinks, from: start, until: end, label: 'VIP route' }];
      const rolling = times.map((at, i) => ({ links: vipLinks, from: at - 4 / 60, until: at + 6 / 60, label: `VIP hold ${i + 1}` }));
      P.title = `VIP movement ${vr.name}, ${n} convoy${n > 1 ? 's' : ''}, ${hhmm(start)}–${hhmm(end)}`;
      P.simFrom = start - 0.5; P.measureFrom = start - 0.25; P.simTo = end + 0.5;
      P.vip = { links: vipLinks, laneLinks, times, route, junctions, origin: vr.origin, dest: vr.dest };
      P.closed = vipLinks; P.incidentAt = start + Math.min(0.5, duration / 2);
      const base = { convoys, demand: holiday };
      P.arms = [
        { key: 'today', name: 'Today: full closure + fixed timers', short: 'Today', mode: 'fixed', baseline: true,
          desc: 'The VIP direction is shut to the public for the whole window; police hold signals for each convoy. Advisory reaches 30% of drivers.',
          scenario: Object.assign({ closures: full, awareness: 0.3, announceAt: start - 12 }, base) },
        { key: 'full', name: 'Full closure, pre-planned', short: 'Full closure', mode: 'adaptive', plan: true, effort: 1,
          desc: 'Same closure, but published a day ahead (80% reach), diversions on VMS and signals re-timed for them, green wave for every convoy.',
          scenario: Object.assign({ closures: full, awareness: 0.8, preloaded: true }, base) },
        { key: 'lane', name: 'Dedicated VIP lane + green wave', short: 'VIP lane', mode: 'adaptive', plan: true, effort: 2,
          desc: P.schematic ? 'Median lane coned off for the convoys; the public keeps two lanes and its normal routes. SAARTHI clears the signals ahead of each convoy.'
            : 'Median lane coned off for the convoys wherever the road has two or more lanes; the public keeps the rest and its normal routes. SAARTHI clears the signals ahead of each convoy.',
          scenario: Object.assign({ lanes: [{ links: laneLinks, from: start, until: end, use: 'vip', label: 'VIP lane' }], awareness: 0.8, preloaded: true }, base) },
        { key: 'rolling', name: 'Rolling 10-min holds', short: 'Rolling holds', mode: 'adaptive', plan: true, effort: 3,
          desc: 'The VIP direction closes only from 4 min before to 6 min after each convoy, and is open to the public in between.',
          scenario: Object.assign({ closures: rolling, awareness: 0.8, preloaded: true }, base) },
      ];
    } else {
      P.simFrom = Math.max(start, end - 1) - 0.25; P.measureFrom = P.simFrom + 0.25; P.simTo = end + 1.5;
      P.closed = []; P.incidentAt = end + 0.25;
      let lanes, crowd, staggered, venueName = A.venue.name;
      if (P.schematic) {
        const surge = +inp.surge;
        P.parkLinks = ['FC-01>FC-03', 'FC-04>FC-03'];
        crowd = { demand: [{ from: end, until: end + 0.75, factor: 1 + surge, origins: ['S18'], label: 'Crowd leaving' }] };
        staggered = { demand: [{ from: end, until: end + 1.5, factor: 1 + surge / 2, origins: ['S18'], label: 'Crowd leaving in waves' }] };
        P.title = `Big event near Sector 18, ${hhmm(start)}–${hhmm(end)}, +${Math.round(surge * 100)}% traffic out of Sector 18 afterwards`;
      } else {
        const v = venueOf(g, A), size = +inp.crowd;
        P.venue = Object.assign({ name: venueName }, v);
        P.parkLinks = v.park;
        crowd = { venues: [{ links: v.links, from: end, until: end + 0.75, rate: size / 0.75, label: 'Crowd leaving' }] };
        staggered = { venues: [{ links: v.links, from: end, until: end + 1.5, rate: size / 1.5, label: 'Crowd leaving in waves' }] };
        P.title = `Big event at ${venueName}, ${hhmm(start)}–${hhmm(end)}, ${size.toLocaleString('en-IN')} vehicles leave afterwards`;
      }
      lanes = [{ links: P.parkLinks, from: start, until: end + 0.5, use: 'closed', label: 'Event parking on the kerb' }];
      const parkWhere = P.schematic ? 'the kerb lanes leading into FC-03' : `the kerb lanes of ${roadsText(P, P.parkLinks)}`;
      P.arms = [
        { key: 'today', name: 'Today: kerb parking + fixed timers', short: 'Today', mode: 'fixed', baseline: true,
          desc: `Attendees park on ${parkWhere} and everyone leaves in one 45-min wave.`,
          scenario: Object.assign({ lanes }, crowd) },
        { key: 'live', name: 'SAARTHI, not told in advance', short: 'SAARTHI live', mode: 'adaptive',
          desc: 'Adaptive signals react to the crowd as it appears; the kerb lanes are still lost to parking.',
          scenario: Object.assign({ lanes }, crowd) },
        { key: 'plan', name: 'Designated parking + enforcement', short: 'Parking plan', mode: 'adaptive', plan: true, effort: 1,
          desc: P.schematic ? 'Attendees directed to off-street parking; vision enforcement keeps the kerb lanes clear. The forecaster knows the crowd is coming.'
            : 'Attendees directed to off-street parking; vision enforcement keeps the kerb lanes clear.',
          scenario: Object.assign({ preloaded: true }, crowd) },
        { key: 'planPlus', name: 'Parking plan + staggered exit', short: '+ staggered exit', mode: 'adaptive', plan: true, effort: 2,
          desc: 'As the parking plan, and the organiser opens exits in waves over 90 min instead of everyone leaving in 45.',
          scenario: Object.assign({ preloaded: true }, staggered) },
      ];
    }
    P.stranded = strandedShare(P, P.closed);
    return P;
  }

  // ---------------------------------------------------------------- measurement
  function makeSim(P, arm, seed, incident, features) {
    const scenario = Object.assign({}, arm.scenario, incident ? { incidents: [incident] } : {});
    const sim = new Sim({ mode: arm.mode, seed, startHour: P.simFrom, warmup: true, scenario, features, network: P.area });
    sim.allTrips = []; sim.allCrossings = []; sim.occSum = {}; sim.occN = 0;
    return sim;
  }

  // Roads a crash could block: the loop on the schematic map; any road 80 m or longer on a real one.
  const crashable = (sim, L) => (sim.ring ? L.kind === 'ring' : L.kind !== 'entry' && L.kind !== 'exit' && L.length >= 80);

  function sampleOcc(sim, P) {
    if (sim.t < P.measureFrom * 3600) return;
    sim.occN++;
    for (const L of sim.linkList) if (crashable(sim, L)) sim.occSum[L.id] = (sim.occSum[L.id] || 0) + L.occ;
  }

  function measure(sim, P) {
    const from = P.measureFrom * 3600, to = P.simTo * 3600;
    const tr = sim.allTrips.filter(r => r.t >= from && r.t <= to);
    const tts = tr.map(r => r.tt).sort((a, b) => a - b);
    const cr = sim.allCrossings.filter(c => c.t >= from);
    const waits = {};
    for (const c of cr) (waits[c.j] = waits[c.j] || []).push(c.wait);
    let hotspot = null;
    for (const j of sim.ring ? sim.junctions : sim.isects) {
      const w = mean(waits[j.id] || []);
      if (w != null && (!hotspot || w > hotspot.wait)) hotspot = { id: j.id, name: j.name, wait: w };
    }
    if (hotspot) hotspot.label = junctionLabel(sim, sim.nodes[hotspot.id]);
    const series = sim.series.filter(p => p.t >= from - 900).map(p => ({ t: p.t, v: p.queued + p.backlog }));
    const vip = sim.stats.vipTrips;
    return {
      n: tr.length,
      p95: quantile(tts, 0.95),
      avg: mean(tts),
      wait: mean(cr.map(c => c.wait)),
      peakStopped: Math.max(0, ...series.filter(p => p.t >= from).map(p => p.v)),
      series,
      turnedBack: sim.stats.turnedBack,
      rerouted: sim.stats.rerouted,
      avoided: sim.stats.avoided,
      stranded: sim.stats.stranded,
      gridlockMin: sim.stats.gridlockSeconds / 60,
      vipDelay: vip.length ? Math.max(...vip.map(v => v.delay)) : null,
      vipArrived: vip.length,
      nudged: sim.stats.nudged,
      hotspot,
      occ: Object.fromEntries(Object.entries(sim.occSum).map(([k, v]) => [k, v / Math.max(1, sim.occN)])),
      log: sim.log.slice(),
    };
  }

  // Lower is better: the bad-day and typical trip, plus gridlock and any convoy held up past a minute.
  function score(m, P) {
    let s = (m.p95 || 0) + (m.avg || 0) + 60 * m.gridlockMin;
    if (P.type === 'vip') {
      const expected = P.vip.times.length * 4;
      s += 10 * Math.max(0, (m.vipDelay || 0) - 60) + 600 * Math.max(0, expected - m.vipArrived);
    }
    return s;
  }

  // ---------------------------------------------------------------- disturbance: caught and corrected?
  function smooth(series, k = 5) { // centred moving average over 2.5 min, so noise doesn't read as deviation
    return series.map((p, i) => {
      const w = series.slice(Math.max(0, i - (k >> 1)), i + (k >> 1) + 1);
      return { t: p.t, v: w.reduce((s, q) => s + q.v, 0) / w.length };
    });
  }

  function deviation(actualRaw, expectedRaw, t0) {
    const actual = smooth(actualRaw), exp = new Map(smooth(expectedRaw).map(p => [p.t, p.v]));
    const band = v => Math.max(30, 0.25 * v); // trajectories never re-converge exactly after a shock
    let detectT = null, peak = 0, peakT = null, recoverT = null, ok = 0;
    for (const p of actual) {
      if (p.t < t0 || !exp.has(p.t)) continue;
      const e = exp.get(p.t), extra = p.v - e;
      if (detectT == null) { if (extra > band(e)) detectT = p.t; else continue; }
      if (extra > peak) { peak = extra; peakT = p.t; }
      if (extra <= band(e)) { if (++ok === 2) recoverT = p.t; } // back inside the band for a full minute
      else { ok = 0; recoverT = null; }
    }
    return { detectT, peak: Math.round(peak), peakT, recoverT };
  }

  // ---------------------------------------------------------------- recommendation text
  function recommend(P, R) {
    const arms = P.arms, today = arms.find(a => a.baseline);
    const plans = arms.filter(a => a.plan);
    const bestScore = Math.min(...plans.map(a => a.score));
    // cheapest plan within 5% of the best result: no need to ask for more coordination than it buys
    const rec = plans.slice().sort((a, b) => a.effort - b.effort || a.score - b.score).find(a => a.score <= bestScore * 1.05);
    const best = plans.find(a => a.score === bestScore);
    const m = rec.m, t = today.m;
    const cut = (x, y) => (x ? Math.round((x - y) / x * 100) : 0);
    const n = v => v.toLocaleString('en-IN');

    const why = [`95th-percentile trip time ${fmtDur(m.p95)} against ${fmtDur(t.p95)} today (${cut(t.p95, m.p95) >= 0 ? '−' : '+'}${Math.abs(cut(t.p95, m.p95))}%).`,
      `Peak vehicles stopped: ${m.peakStopped} against ${t.peakStopped} today.`];
    if (P.closed.length && P.type !== 'event') why.push(`${n(m.turnedBack)} drivers turned back at barricades, against ${n(t.turnedBack)} today.`);
    if (m.avoided + t.avoided > 0) why.push(`${n(m.avoided)} drivers knew in advance and went round the area, against ${n(t.avoided)} today.`);
    if (P.type === 'vip') why.push(`Worst convoy delay ${fmtDur(m.vipDelay)} (today ${fmtDur(t.vipDelay)}).`);
    if (best !== rec) why.push(`${best.name} scores ${Math.round((1 - best.score / rec.score) * 100)}% better but needs more coordination, so the simpler plan is recommended.`);

    const actions = [];
    const hs = m.hotspot;
    const marshal = hs ? { when: hhmm(P.type === 'event' ? P.end : P.start), what: `Station a marshal at ${hs.label}: the twin predicts the longest waits there (${Math.round(hs.wait)} s average).` } : null;
    const noWayText = routes => {
      const stuck = routes.filter(r => r.noWay);
      if (!stuck.length) return null;
      const dests = [...new Set(stuck.map(r => r.to))].slice(0, 3).join(', ');
      return `Traffic heading for ${dests} has no way through on the main roads while it is closed (${Math.round(P.stranded * 100)}% of the area's trips): signs and maps send it round before it reaches the area.`;
    };
    let routes = [];
    if (P.type === 'protest') {
      const seg = P.site;
      routes = publicDiversions(P, P.closed);
      const entries = [...new Set(routes.filter(r => !r.noWay).map(r => r.from))];
      actions.push({ when: 'Day before', what: `Load the closure of ${seg.name} (${hhmm(P.start)}–${hhmm(P.end)}) into SAARTHI and publish it to map closure feeds, ${AREAS[P.area].handles} and SMS. Modelled reach: 80% of drivers.` });
      if (rec.key === 'planPlus') actions.push({ when: 'Day before', what: `Ask offices around ${AREAS[P.area].offices} to stagger start times by 30 min or allow work-from-home (modelled as −10% demand).` });
      actions.push({ when: hhmm(P.start - 0.5), what: `VMS at ${entries.slice(0, P.schematic ? 5 : 4).join(', ') || (P.schematic ? 'every loop entry' : 'every entry')} switch to the diversion; navigation apps reroute the rest.` });
      const nw = noWayText(routes);
      if (nw) actions.push({ when: hhmm(P.start - 0.5), what: nw });
      actions.push({ when: hhmm(P.start), what: P.schematic ? `Barricades at ${seg.a} and ${seg.b}. The control brain re-times every junction for the diverted flows.`
        : `Barricades at both ends of ${seg.name}, both directions. SAARTHI re-times the signals for the diverted flows.` });
      if (marshal) actions.push(marshal);
      actions.push({ when: hhmm(P.end), what: P.schematic ? 'Reopen; keep perimeter metering on until the queues clear.' : 'Reopen; VMS go back to normal once the queues clear.' });
    } else if (P.type === 'vip') {
      const v = P.vip, times = v.times.map(hhmm).join(', ');
      if (rec.key !== 'lane') routes = publicDiversions(P, v.links);
      actions.push({ when: 'Day before', what: `Publish the public advisory: routes and timings below${+P.input.holiday > 0 ? `; schools and offices closed by order (−${Math.round(P.input.holiday * 100)}% demand, modelled in every option)` : ''}.` });
      if (rec.key === 'full') actions.push({ when: hhmm(P.start), what: `Close ${roadsText(P, v.links)} to the public in the convoy's direction, ${hhmm(P.start)}–${hhmm(P.end)}. The opposite carriageway stays open.` });
      if (rec.key === 'lane') actions.push({ when: hhmm(P.start), what: `Cone off the median lane on ${roadsText(P, v.laneLinks)} as a VIP lane, ${hhmm(P.start)}–${hhmm(P.end)}. The public keeps the other lanes and its usual routes.` });
      if (rec.key === 'rolling') actions.push({ when: times, what: `Hold ${roadsText(P, v.links)} from 4 min before to 6 min after each convoy; open to the public in between.` });
      const nw = rec.key !== 'lane' && noWayText(routes);
      if (nw) actions.push({ when: hhmm(P.start - 0.5), what: nw });
      actions.push({ when: times, what: v.junctions.length
        ? `Convoys leave on ${v.route}. SAARTHI pre-empts the signals at ${v.junctions.join(', ')} when a convoy is 350 m out (green wave).`
        : `Convoys leave on ${v.route}. There are no signals on the way; convoys have right of way at every merge.` });
      if (marshal) actions.push(marshal);
    } else {
      actions.push({ when: 'Week before', what: 'Agree off-street parking with the venue and print it on tickets; brief the tow contractor.' });
      actions.push({ when: hhmm(P.input.start), what: `Vision enforcement keeps the kerb lanes on ${roadsText(P, P.parkLinks)} clear for the whole event.` });
      if (rec.key === 'planPlus') actions.push({ when: hhmm(P.end), what: 'The organiser opens exits in waves over 90 min instead of letting everyone out in 45.' });
      if (m.nudged > 0) actions.push({ when: hhmm(P.end - 0.5), what: `SAARTHI forecasts the crunch and sends departure advice; ${n(m.nudged)} regular commuters shift their trip by 15 min.` });
      if (marshal) actions.push(marshal);
    }
    return { rec, best, why, actions, routes };
  }

  // ---------------------------------------------------------------- runner (chunked, so the page stays responsive)
  function createRun(input, opts) {
    const P = build(input);
    const seed = (opts && opts.seed) || 7;
    const disturbance = !!input.disturbance;
    const total = (P.simTo - P.simFrom) * 3600 / S.DT;
    let jobs = P.arms.map(arm => ({ arm, sim: makeSim(P, arm, seed) }));
    let phase = 1, i = 0;
    const phases = disturbance ? 2 : 1;
    const run = { P, done: false, result: null, progress: 0, label: 'Simulating every option on identical traffic' };

    function finishPhase1() {
      for (const j of jobs) { j.arm.m = measure(j.sim, P); j.arm.score = score(j.arm.m, P); }
      run.reco = recommend(P, run);
      if (!disturbance) return finish();
      // the busiest open road under the recommended plan: where a breakdown would hurt most
      const occ = run.reco.rec.m.occ, sim = jobs[0].sim;
      const link = Object.keys(occ).filter(id => !P.closed.includes(id)).sort((a, b) => occ[b] - occ[a])[0];
      const L = sim.links[link];
      const lanes = sim.ring ? [0, 1, 2] : Array.from({ length: L.lanes }, (_, k) => k).filter(k => k !== L.gc);
      P.incident = { at: P.incidentAt, link, lane: lanes, label: 'Unplanned crash blocks the carriageway', name: sim.ring ? linkName(link) : L.name };
      // same plan twice: SAARTHI catching and correcting it, and nobody catching it until a patrol does
      const rec = run.reco.rec;
      jobs = [{ arm: rec, sim: makeSim(P, rec, seed, P.incident) },
        { arm: rec, sim: makeSim(P, rec, seed, P.incident, { enforcement: false }) }];
      phase = 2; i = 0;
      run.label = 'Replaying the plan with an unplanned breakdown';
    }

    function finish() {
      if (disturbance) {
        const [mc, mu] = jobs.map(j => measure(j.sim, P));
        const t0 = P.incident.at * 3600, expected = run.reco.rec.m.series;
        P.dist = {
          link: P.incident.link, name: P.incident.name, at: t0, expected,
          corrected: Object.assign({ m: mc, clearedT: t0 + 6 * 60 }, deviation(mc.series, expected, t0)),
          uncorrected: Object.assign({ m: mu, clearedT: t0 + 15 * 60 }, deviation(mu.series, expected, t0)),
        };
      }
      run.done = true; run.progress = 1;
      run.result = { P, reco: run.reco };
    }

    run.step = budgetMs => {
      if (run.done) return run;
      const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
      const t0 = now();
      while (i < total && now() - t0 < budgetMs) {
        for (let k = 0; k < 40 && i < total; k++, i++) {
          for (const j of jobs) {
            j.sim.step();
            if (j.sim.stepN % 240 === 0) sampleOcc(j.sim, P);
          }
        }
      }
      run.progress = ((phase - 1) + i / total) / phases;
      run.clock = jobs[0].sim.t;
      if (i >= total) { if (phase === 1) finishPhase1(); else finish(); }
      return run;
    };
    return run;
  }

  const api = { TYPES, AREAS, DEFAULT_AREA, defaultsFor, geoFor, siteLinks, venueOf, build, createRun, hhmm, routeText, roadNames,
    publicDiversions, strandedShare, junctionLabel, venueAt, routeToPoint };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SAARTHI_PLANNER = api;
})(typeof window !== 'undefined' ? window : globalThis);
