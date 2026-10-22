/*
 * Project SAARTHI — what-if planner. DOM-free, so it runs in the browser and in Node (tools/whatif.js).
 *
 * Takes a disruption the city knows is coming (a protest closure, a VIP movement, a big event),
 * builds candidate traffic plans for it, simulates every candidate on identical traffic next to
 * today's approach (barricades + fixed timers), ranks them and writes the recommendation.
 * Optionally replays the recommended plan with an unplanned disturbance to show it being caught
 * and corrected.
 */
(function (root) {
  'use strict';
  const S = typeof module !== 'undefined' && module.exports ? require('./engine.js') : root.SAARTHI;
  const { Sim, NETWORK, fmtClock, fmtDur, quantile, mean } = S;

  const JN = Object.fromEntries(NETWORK.junctions.map(j => [j.id, j]));
  const XN = Object.fromEntries(NETWORK.externals.map(x => [x.id, x]));
  const hhmm = h => fmtClock(h * 3600).slice(0, 5);
  const geo = new Sim({ mode: 'fixed', seed: 1, startHour: 0 }); // geometry and route options only

  const SEGMENTS = {
    north: { a: 'FC-01', b: 'FC-03', name: 'FC-01 ↔ FC-03 (north side)' },
    east: { a: 'FC-03', b: 'FC-04', name: 'FC-03 ↔ FC-04 (east side)' },
    south: { a: 'FC-04', b: 'FC-02', name: 'FC-04 ↔ FC-02 (south side)' },
    west: { a: 'FC-02', b: 'FC-01', name: 'FC-02 ↔ FC-01 (west side)' },
  };
  const VIP_ROUTES = {
    'DND-GNO': { origin: 'DND', dest: 'GNO', dir: 1 },
    'EXP-S18': { origin: 'EXP', dest: 'S18', dir: -1 },
  };
  const TYPES = {
    protest: { label: 'Protest / rally', defaults: { start: 10, duration: 1, segment: 'north' } },
    vip: { label: 'VIP movement', defaults: { start: 9.5, duration: 1.5, vipRoute: 'DND-GNO', convoys: 2, holiday: 0.15 } },
    event: { label: 'Big event', defaults: { start: 17, duration: 1.5, surge: 0.8 } },
  };

  // ---------------------------------------------------------------- helpers
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

  // Origin–destination pairs whose usual (shortest) road is closed, and the way round for them.
  function publicDiversions(closedIds) {
    const out = [];
    if (!closedIds.length) return out;
    for (const o of Object.keys(NETWORK.od)) {
      for (const d of Object.keys(NETWORK.od[o])) {
        const opts = geo.routeOptions(o, d);
        if (opts.length < 2) continue;
        const usual = opts[0].len <= opts[1].len ? opts[0] : opts[1], other = usual === opts[0] ? opts[1] : opts[0];
        if (!usual.ids.some(id => closedIds.includes(id)) || other.ids.some(id => closedIds.includes(id))) continue;
        out.push({ o, d, share: NETWORK.od[o][d], from: XN[o].name, to: XN[d].name, via: routeText(other.ids),
          extra: other.ids.length - usual.ids.length });
      }
    }
    return out.sort((p, q) => q.share * XN[q.o].demand - p.share * XN[p.o].demand);
  }

  const linkName = id => id.replace('>', '→');
  const listLinks = ids => ids.map(linkName).join(', ');

  // ---------------------------------------------------------------- candidate plans
  function build(input) {
    const inp = Object.assign({}, TYPES[input.type].defaults, input);
    const start = +inp.start, duration = +inp.duration, end = start + duration;
    const P = { input: inp, type: inp.type, start, end, arms: [] };

    if (inp.type === 'protest') {
      const seg = SEGMENTS[inp.segment];
      const links = [`${seg.a}>${seg.b}`, `${seg.b}>${seg.a}`];
      const closures = [{ links, from: start, until: end, label: 'Protest' }];
      P.title = `Protest closes ${seg.name}, ${hhmm(start)}–${hhmm(end)}`;
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
          desc: 'As pre-planned, and offices around Sector 16A / 18 stagger start times or allow work-from-home (−10% demand during the closure).',
          scenario: { closures, awareness: 0.8, preloaded: true, demand: [{ from: start - 0.25, until: end, factor: 0.9, label: 'Staggered office hours' }] } },
      ];
    } else if (inp.type === 'vip') {
      const vr = VIP_ROUTES[inp.vipRoute];
      const vipLinks = ringLinks(XN[vr.origin].j, XN[vr.dest].j, vr.dir);
      const n = Math.max(1, +inp.convoys);
      const times = Array.from({ length: n }, (_, i) => start + (i + 0.5) * duration / n);
      const convoys = times.map((at, i) => ({ at, origin: vr.origin, dest: vr.dest, dir: vr.dir, size: 4, label: `VIP convoy ${i + 1}` }));
      const holiday = +inp.holiday > 0 ? [{ from: start - 3, until: end + 3, factor: 1 - inp.holiday, label: 'Schools & offices closed' }] : [];
      const full = [{ links: vipLinks, from: start, until: end, label: 'VIP route' }];
      const rolling = times.map((at, i) => ({ links: vipLinks, from: at - 4 / 60, until: at + 6 / 60, label: `VIP hold ${i + 1}` }));
      P.title = `VIP movement ${XN[vr.origin].name} → ${XN[vr.dest].name}, ${n} convoy${n > 1 ? 's' : ''}, ${hhmm(start)}–${hhmm(end)}`;
      P.simFrom = start - 0.5; P.measureFrom = start - 0.25; P.simTo = end + 0.5;
      P.vip = { links: vipLinks, times, route: routeText(geo.routeOptions(vr.origin, vr.dest).find(r => r.dir === vr.dir).ids),
        junctions: [...new Set(vipLinks.flatMap(id => id.split('>')))] };
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
          desc: 'Median lane coned off for the convoys; the public keeps two lanes and its normal routes. SAARTHI clears the signals ahead of each convoy.',
          scenario: Object.assign({ lanes: [{ links: vipLinks, from: start, until: end, use: 'vip', label: 'VIP lane' }], awareness: 0.8, preloaded: true }, base) },
        { key: 'rolling', name: 'Rolling 10-min holds', short: 'Rolling holds', mode: 'adaptive', plan: true, effort: 3,
          desc: 'The VIP direction closes only from 4 min before to 6 min after each convoy, and is open to the public in between.',
          scenario: Object.assign({ closures: rolling, awareness: 0.8, preloaded: true }, base) },
      ];
    } else {
      const surge = +inp.surge;
      const park = ['FC-01>FC-03', 'FC-04>FC-03'];
      const lanes = [{ links: park, from: start, until: end + 0.5, use: 'closed', label: 'Event parking on the kerb' }];
      const crowd = { from: end, until: end + 0.75, factor: 1 + surge, origins: ['S18'], label: 'Crowd leaving' };
      const staggered = { from: end, until: end + 1.5, factor: 1 + surge / 2, origins: ['S18'], label: 'Crowd leaving in waves' };
      P.title = `Big event near Sector 18, ${hhmm(start)}–${hhmm(end)}, +${Math.round(surge * 100)}% traffic out of Sector 18 afterwards`;
      P.simFrom = Math.max(start, end - 1) - 0.25; P.measureFrom = P.simFrom + 0.25; P.simTo = end + 1.5;
      P.closed = []; P.parkLinks = park; P.incidentAt = end + 0.25;
      P.arms = [
        { key: 'today', name: 'Today: kerb parking + fixed timers', short: 'Today', mode: 'fixed', baseline: true,
          desc: 'Attendees park on the kerb lanes leading into FC-03 and everyone leaves in one 45-min wave.',
          scenario: { lanes, demand: [crowd] } },
        { key: 'live', name: 'SAARTHI, not told in advance', short: 'SAARTHI live', mode: 'adaptive',
          desc: 'Adaptive signals react to the crowd as it appears; the kerb lanes are still lost to parking.',
          scenario: { lanes, demand: [crowd] } },
        { key: 'plan', name: 'Designated parking + enforcement', short: 'Parking plan', mode: 'adaptive', plan: true, effort: 1,
          desc: 'Attendees directed to off-street parking; vision enforcement keeps the kerb lanes clear. The forecaster knows the crowd is coming.',
          scenario: { demand: [crowd], preloaded: true } },
        { key: 'planPlus', name: 'Parking plan + staggered exit', short: '+ staggered exit', mode: 'adaptive', plan: true, effort: 2,
          desc: 'As the parking plan, and the organiser opens exits in waves over 90 min instead of everyone leaving in 45.',
          scenario: { demand: [staggered], preloaded: true } },
      ];
    }
    return P;
  }

  // ---------------------------------------------------------------- measurement
  function makeSim(P, arm, seed, incident, features) {
    const scenario = Object.assign({}, arm.scenario, incident ? { incidents: [incident] } : {});
    const sim = new Sim({ mode: arm.mode, seed, startHour: P.simFrom, warmup: true, scenario, features });
    sim.allTrips = []; sim.allCrossings = []; sim.occSum = {}; sim.occN = 0;
    return sim;
  }

  function sampleOcc(sim, P) {
    if (sim.t < P.measureFrom * 3600) return;
    sim.occN++;
    for (const L of sim.linkList) if (L.kind === 'ring') sim.occSum[L.id] = (sim.occSum[L.id] || 0) + L.occ;
  }

  function measure(sim, P) {
    const from = P.measureFrom * 3600, to = P.simTo * 3600;
    const tr = sim.allTrips.filter(r => r.t >= from && r.t <= to);
    const tts = tr.map(r => r.tt).sort((a, b) => a - b);
    const cr = sim.allCrossings.filter(c => c.t >= from);
    let hotspot = null;
    for (const j of sim.junctions) {
      const w = mean(cr.filter(c => c.j === j.id).map(c => c.wait));
      if (w != null && (!hotspot || w > hotspot.wait)) hotspot = { id: j.id, name: j.name, wait: w };
    }
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

    const why = [`95th-percentile trip time ${fmtDur(m.p95)} against ${fmtDur(t.p95)} today (${cut(t.p95, m.p95) >= 0 ? '−' : '+'}${Math.abs(cut(t.p95, m.p95))}%).`,
      `Peak vehicles stopped: ${m.peakStopped} against ${t.peakStopped} today.`];
    if (P.closed.length && P.type !== 'event') why.push(`${m.turnedBack.toLocaleString('en-IN')} drivers turned back at barricades, against ${t.turnedBack.toLocaleString('en-IN')} today.`);
    if (P.type === 'vip') why.push(`Worst convoy delay ${fmtDur(m.vipDelay)} (today ${fmtDur(t.vipDelay)}).`);
    if (best !== rec) why.push(`${best.name} scores ${Math.round((1 - best.score / rec.score) * 100)}% better but needs more coordination, so the simpler plan is recommended.`);

    const actions = [];
    const hs = m.hotspot;
    const marshal = hs ? { when: hhmm(P.type === 'event' ? P.end : P.start), what: `Station a marshal at ${hs.id} (${hs.name}): the twin predicts the longest waits there (${Math.round(hs.wait)} s average).` } : null;
    let routes = [];
    if (P.type === 'protest') {
      const seg = SEGMENTS[P.input.segment];
      routes = publicDiversions(P.closed);
      const entries = [...new Set(routes.map(r => r.from))];
      actions.push({ when: 'Day before', what: `Load the closure of ${seg.name} (${hhmm(P.start)}–${hhmm(P.end)}) into SAARTHI and publish it to map closure feeds, the Sector 94 ITMS handles and SMS. Modelled reach: 80% of drivers.` });
      if (rec.key === 'planPlus') actions.push({ when: 'Day before', what: 'Ask offices around Sector 16A / 18 to stagger start times by 30 min or allow work-from-home (modelled as −10% demand).' });
      actions.push({ when: hhmm(P.start - 0.5), what: `VMS at ${entries.join(', ') || 'every loop entry'} switch to the diversion; navigation apps reroute the rest.` });
      actions.push({ when: hhmm(P.start), what: `Barricades at ${seg.a} and ${seg.b}. The control brain re-times every junction for the diverted flows.` });
      if (marshal) actions.push(marshal);
      actions.push({ when: hhmm(P.end), what: 'Reopen; keep perimeter metering on until the queues clear.' });
    } else if (P.type === 'vip') {
      const v = P.vip, times = v.times.map(hhmm).join(', ');
      if (rec.key !== 'lane') routes = publicDiversions(v.links);
      actions.push({ when: 'Day before', what: `Publish the public advisory: routes and timings below${+P.input.holiday > 0 ? `; schools and offices closed by order (−${Math.round(P.input.holiday * 100)}% demand, modelled in every option)` : ''}.` });
      if (rec.key === 'full') actions.push({ when: hhmm(P.start), what: `Close ${listLinks(v.links)} to the public ${hhmm(P.start)}–${hhmm(P.end)}. The opposite carriageway stays open.` });
      if (rec.key === 'lane') actions.push({ when: hhmm(P.start), what: `Cone off the median lane on ${listLinks(v.links)} as a VIP lane, ${hhmm(P.start)}–${hhmm(P.end)}. The public keeps two of three lanes and its usual routes.` });
      if (rec.key === 'rolling') actions.push({ when: times, what: `Hold ${listLinks(v.links)} from 4 min before to 6 min after each convoy; open to the public in between.` });
      actions.push({ when: times, what: `Convoys leave on ${v.route}. SAARTHI pre-empts the signals at ${v.junctions.join(', ')} when a convoy is 350 m out (green wave).` });
      if (marshal) actions.push(marshal);
    } else {
      actions.push({ when: 'Week before', what: 'Agree off-street parking with the venue and print it on tickets; brief the tow contractor.' });
      actions.push({ when: hhmm(P.input.start), what: `Vision enforcement keeps the kerb lanes on ${listLinks(P.parkLinks)} clear for the whole event.` });
      if (rec.key === 'planPlus') actions.push({ when: hhmm(P.end), what: 'The organiser opens exits in waves over 90 min instead of letting everyone out in 45.' });
      if (m.nudged > 0) actions.push({ when: hhmm(P.end - 0.5), what: `SAARTHI forecasts the crunch and sends departure advice; ${m.nudged.toLocaleString('en-IN')} regular commuters shift their trip by 15 min.` });
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
      // the busiest open loop road under the recommended plan: where a breakdown would hurt most
      const occ = run.reco.rec.m.occ;
      const link = Object.keys(occ).filter(id => !P.closed.includes(id)).sort((a, b) => occ[b] - occ[a])[0];
      P.incident = { at: P.incidentAt, link, lane: [0, 1, 2], label: 'Unplanned crash blocks the carriageway' };
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
          link: P.incident.link, at: t0, expected,
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

  const api = { TYPES, SEGMENTS, VIP_ROUTES, build, createRun, hhmm, routeText };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SAARTHI_PLANNER = api;
})(typeof window !== 'undefined' ? window : globalThis);
