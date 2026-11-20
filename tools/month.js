// Simulated month: the 08:30–09:30 morning peak replayed for 22 working days, Fixed vs SAARTHI.
// Every day uses the same calibrated weekday demand; what changes from day to day is the random
// seed (who leaves when, vehicle mix, driver behaviour) and the incidents: an ambulance every day
// at a random time, illegal parking on about 4 days in 10. No real day-to-day or seasonal data is used.
//   node tools/month.js <network> [days]      e.g. node tools/month.js fco
// Writes tools/month-out/<network>.json; tools/month-pack.js bundles them into js/month-data.js.
const fs = require('fs'), path = require('path');
const { Sim } = require('../js/engine.js');

const [network = 'fc', daysArg = '22'] = process.argv.slice(2);
const DAYS = +daysArg, DT = 0.25, START = 8.5, MINS = 60;

// a small seeded RNG so the incident plan is the same on every run
let r = 20261120 ^ network.split('').reduce((a, c) => a * 31 + c.charCodeAt(0), 7);
const rnd = () => ((r = (r * 1664525 + 1013904223) >>> 0) / 4294967296);

function summarise(sim, from) {
  const tr = sim.allTrips.filter(x => x.t >= from);
  const tts = tr.map(x => x.tt).sort((a, b) => a - b);
  const q = p => tts[Math.min(tts.length - 1, Math.floor((tts.length - 1) * p))];
  const mean = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);
  const cr = sim.allCrossings.filter(c => c.t >= from);
  const ev = sim.stats.evTrips[0];
  const park = sim.eventLog.find(e => e.kind === 'parking');
  return {
    trips: tr.length, avg: +mean(tts).toFixed(1), p95: +(q(0.95) || 0).toFixed(1),
    vehH: +(tts.reduce((a, b) => a + b, 0) / 3600).toFixed(1),
    wait: +mean(cr.map(c => c.wait)).toFixed(1), stops: +mean(tr.map(x => x.stops)).toFixed(2),
    fuel: +mean(tr.map(x => x.fuel)).toFixed(4),
    ev: ev ? Math.round(ev.delay) : null,
    park: park && park.normalAt != null ? Math.round(park.normalAt - park.start) : null,
    gridlock: sim.stats.gridlockEvents,
  };
}

const t0 = Date.now(), out = [];
for (let d = 0; d < DAYS; d++) {
  const seed = 1000 + d * 97;
  const ambAt = Math.round((5 + rnd() * 45) * 60);          // ambulance between 08:35 and 09:20
  const parkAt = rnd() < 0.4 ? Math.round((5 + rnd() * 40) * 60) : null;
  const mk = mode => {
    const s = new Sim({ mode, seed, startHour: START, warmup: true, network, priorityApproval: mode === 'adaptive' });
    s.autoApprove = true; s.allTrips = []; s.allCrossings = []; s.quiet = true;
    return s;
  };
  const f = mk('fixed'), s = mk('adaptive');
  const from = f.t;
  for (let i = 0; i < MINS * 60 / DT; i++) {
    const el = i * DT;
    if (el === ambAt) { f.triggerAmbulance(); s.triggerAmbulance(); }
    if (el === parkAt) { f.triggerBlockage(); s.triggerBlockage(); }
    f.step(); s.step();
  }
  const sf = summarise(f, from), ss = summarise(s, from);
  // let the ambulance (and the parking recovery) finish if still under way; only those two figures are updated
  for (let i = 0; i < 20 * 60 / DT && (!f.stats.evTrips.length || !s.stats.evTrips.length); i++) { f.step(); s.step(); }
  for (const [x, sm] of [[f, sf], [s, ss]]) { const e = summarise(x, from); sm.ev = e.ev; sm.park = e.park; }
  out.push({ day: d + 1, seed, ambAt: START * 3600 + ambAt, parkAt: parkAt == null ? null : START * 3600 + parkAt,
    fixed: sf, smart: ss });
  console.log(`${network} day ${d + 1}/${DAYS}  avg ${out[d].fixed.avg}s vs ${out[d].smart.avg}s  ev ${out[d].fixed.ev} vs ${out[d].smart.ev}  (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
}
const dir = path.join(__dirname, 'month-out');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, `${network}.json`), JSON.stringify({ network, days: DAYS, start: START, mins: MINS, generated: new Date().toISOString().slice(0, 10), rows: out }));
console.log('done', (Date.now() - t0) / 1000 + 's');
