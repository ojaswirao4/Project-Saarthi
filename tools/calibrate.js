// Headless A/B run of the twin: node tools/calibrate.js [startHour] [hours] [demandMult] [seed] [network] [--events]
//   network: fc (Film City loop, default), cp (Connaught Place), s62 (Sector 62 Noida)
//   --events: dispatch an ambulance after 30 min and illegal parking after 60 min, then print the event stopwatch
const { Sim, fmtClock, fmtDur } = require('../js/engine.js');

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const events = process.argv.includes('--events');
const startHour = +(args[0] || 8);
const hours = +(args[1] || 2);
const demandMult = +(args[2] || 1);
const seed = +(args[3] || 7);
const network = args[4] || 'fc';

const t0 = Date.now();
const fixed = new Sim({ mode: 'fixed', seed, startHour, demandMult, warmup: true, network });
const smart = new Sim({ mode: 'adaptive', seed, startHour, demandMult, warmup: true, network });

const f1 = x => (x == null ? '—' : x.toFixed(1));
const row = (k, s) => `${s.padEnd(8)} n=${String(k.n).padStart(4)} avg=${fmtDur(k.avgTrip).padStart(7)} p95=${fmtDur(k.p95).padStart(7)} corr=${fmtDur(k.corridor).padStart(7)} wait=${f1(k.wait).padStart(5)}s thr=${String(Math.round(k.throughput || 0)).padStart(5)}/h stops=${f1(k.stops)} fuel=${(k.fuel || 0).toFixed(3)}L grid=${k.gridlockEvents}/${f1(k.gridlockMin)}m net=${k.inNet} backlog=${k.backlog} div=${k.diverted}`;

const steps = hours * 3600 / 0.25;
for (let i = 1; i <= steps; i++) {
  if (events && i === 1800 / 0.25) { fixed.triggerAmbulance(); smart.triggerAmbulance(); }
  if (events && i === 3600 / 0.25) { fixed.triggerBlockage(); smart.triggerBlockage(); }
  fixed.step(); smart.step();
  if (i % (900 / 0.25) === 0) {
    console.log(`--- ${fmtClock(fixed.t)}`);
    console.log(row(fixed.kpis(), 'FIXED'));
    console.log(row(smart.kpis(), 'SAARTHI'));
  }
}
console.log(`plans:`, fixed.junctions.slice(0, 8).map(j => `${j.id}[${j.plan.join(',')}]`).join(' '), fixed.junctions.length > 8 ? '…' : '');
if (events) {
  const d = (e, k) => (e[k] == null ? 'not yet' : fmtDur(e[k] - e.start));
  fixed.eventLog.forEach((f, i) => {
    const s = smart.eventLog[i];
    if (f.kind === 'ambulance') console.log(`${f.label}\n  reached in      ${fmtDur(f.tt)} vs ${fmtDur(s.tt)}   delay ${fmtDur(f.delay)} vs ${fmtDur(s.delay)}${s.usedLane ? ' (green corridor lane)' : ''}`);
    else console.log(`${f.label}\n  spotted after   ${d(f, 'detectAt')} vs ${d(s, 'detectAt')}\n  cleared after   ${d(f, 'clearAt')} vs ${d(s, 'clearAt')}`
      + `\n  normal after    ${d(f, 'normalAt')} vs ${d(s, 'normalAt')}\n  veh-min lost    ${Math.round(f.lost)} vs ${Math.round(s.lost)}`);
  });
}
console.log(`elapsed ${(Date.now() - t0) / 1000}s`);
