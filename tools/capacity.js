// Capacity A/B: both twins fed the same overload, trips finished per hour once saturated.
// node tools/capacity.js [demandMult] [seed] [network] [settleMin] [measureMin]
//   e.g. node tools/capacity.js 1.4 7        (Film City loop at 140% of the design demand)
// Demand shaping is off (it moves demand rather than carrying it); metering, VMS and enforcement stay on.
const { Sim } = require('../js/engine.js');

const [dm = '1.4', seed = '7', network = 'fc', settle = '15', measure = '60'] = process.argv.slice(2);
const t0 = Date.now();
const mk = mode => new Sim({ mode, seed: +seed, startHour: 8.5, demandMult: +dm, warmup: true, network, features: { shaping: false } });
const fixed = mk('fixed'), smart = mk('adaptive');
const done = x => x.stats.completed - x.stats.evTrips.length - x.stats.vipTrips.length;

for (let i = 0; i < +settle * 60 / 0.25; i++) { fixed.step(); smart.step(); }
const f0 = done(fixed), s0 = done(smart);
for (let i = 0; i < +measure * 60 / 0.25; i++) { fixed.step(); smart.step(); }
const f = (done(fixed) - f0) * 60 / +measure, s = (done(smart) - s0) * 60 / +measure;

console.log(`${network} demand ×${dm} seed ${seed}: FIXED ${Math.round(f)} trips/h, SAARTHI ${Math.round(s)} trips/h (${s >= f ? '+' : ''}${((s / f - 1) * 100).toFixed(1)}%)`);
console.log(`elapsed ${(Date.now() - t0) / 1000}s`);
