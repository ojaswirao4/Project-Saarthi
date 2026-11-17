// Headless what-if run: node tools/whatif.js <protest|vip|event> [key=value ...] [disturbance]
//   area=fco (default, Film City corridor) | cp | s62 | fc (schematic loop); sites and routes are listed in js/planner.js
// e.g. node tools/whatif.js protest area=fco segment=vtm start=10 duration=1 disturbance
//      node tools/whatif.js vip area=cp vipRoute=barakhamba-sansad convoys=2 holiday=0.15
//      node tools/whatif.js event area=s62 crowd=1000      node tools/whatif.js event area=fc surge=0.8
const { fmtClock, fmtDur } = require('../js/engine.js');
const W = require('../js/planner.js');

const [type = 'protest', ...rest] = process.argv.slice(2);
const input = { type };
for (const a of rest) {
  if (a === 'disturbance') { input.disturbance = true; continue; }
  const [k, v] = a.split('=');
  input[k] = isNaN(+v) ? v : +v;
}

const t0 = Date.now();
const run = W.createRun(input);
while (!run.done) run.step(1e9);
const { P, reco } = run.result;
const hm = t => (t == null ? '—' : fmtClock(t).slice(0, 5));

console.log(`${P.title} [${P.areaLabel}]`);
if (P.stranded) console.log(`no way through on the mapped roads for ${(P.stranded * 100).toFixed(1)}% of the area's trips while closed`);
for (const a of P.arms) {
  const m = a.m;
  console.log(`${(a === reco.rec ? '* ' : '  ') + a.short.padEnd(16)} p95=${fmtDur(m.p95).padStart(7)} avg=${fmtDur(m.avg).padStart(7)} `
    + `peakStopped=${String(m.peakStopped).padStart(4)} turnedBack=${String(m.turnedBack).padStart(4)} rerouted=${String(m.rerouted).padStart(4)} `
    + `wentRound=${String(m.avoided).padStart(4)} noWay=${String(m.stranded).padStart(4)} vip=${fmtDur(m.vipDelay).padStart(6)} (${m.vipArrived}) grid=${m.gridlockMin.toFixed(1)}m n=${m.n} score=${Math.round(a.score)}`);
}
console.log('\nRecommended:', reco.rec.name);
reco.why.forEach(w => console.log('  -', w));
reco.actions.forEach(x => console.log(`  [${x.when}] ${x.what}`));
reco.routes.forEach(r => console.log(`  route ${r.from} → ${r.to}: ${r.noWay ? 'no way through on the mapped roads' : `via ${r.via} (${r.extra || 'same'})`}`));
if (P.dist) {
  const d = P.dist;
  console.log(`\nDisturbance on ${d.name} (${d.link}) at ${hm(d.at)}`);
  for (const k of ['corrected', 'uncorrected']) {
    const x = d[k];
    console.log(`  ${k.padEnd(11)} deviates ${hm(x.detectT)} peak +${x.peak} at ${hm(x.peakT)} back on plan ${hm(x.recoverT)} p95=${fmtDur(x.m.p95)} avg=${fmtDur(x.m.avg)}`);
  }
  console.log(`  expected    p95=${fmtDur(reco.rec.m.p95)} avg=${fmtDur(reco.rec.m.avg)}`);
}
console.log(`elapsed ${(Date.now() - t0) / 1000}s`);
