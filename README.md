# Project SAARTHI: website and corridor digital twin

A presentation website for SAARTHI with a live digital twin of the Noida Film City / Sector 16A loop built in.
Open `index.html` in Chrome or Edge. No install or server is needed; an internet connection is used only for the Inter web font.

## The page, top to bottom

| Section | What it shows |
|---|---|
| Hero | The SAARTHI twin running live, plus headline results from the in-browser benchmark |
| 01 Problem | The five failure modes from the brief and the "Noida already owns the hardware" insight |
| 02 Approach | A live **graph view** of the corridor (edges coloured by occupancy, nodes sized by queue) and the closed loop: Sense → Predict → Decide & act → Enforce → Shape demand |
| 03 Live twin | Fixed timers vs SAARTHI side by side on identical traffic: an **area picker** (the schematic Film City loop, or the real road network of the **Film City corridor**, **Connaught Place** or **Sector 62 Noida** from OpenStreetMap), event injection with an **event stopwatch**, layer toggles, KPIs, charts, demand forecast, junction inspector with the slide-7 edge message, and a decision log. Zoom with Ctrl + scroll or the + / − buttons, drag to pan |
| 04 Plan ahead | **What-if planner.** Enter a protest closure, a VIP movement (G20-style: convoys, schools/offices closed) or a big event in advance. It simulates today's approach and 2–3 SAARTHI plans on identical traffic, ranks them, and recommends one with an action timeline, public diversions and a separate VIP route. An optional unplanned crash checks that the plan is caught and corrected. *Watch it in the live twin* loads the scenario into section 03 |
| 05 Results | A full 08:00–10:30 morning peak, with an ambulance at 09:10 and illegal parking at 09:30, **simulated in the browser on page load**, then scored against the deck's slide-11 targets |
| 06–08 | Architecture (six layers), the phased rollout (Phase 1 "Twin & shadow" marked as live), and evidence from Surtrac, Green Light, BATCS and others |

There's a light/dark toggle in the nav. `index.html?ff=2&amb=1` opens the twin 30 min in with an ambulance just dispatched; add `&park=5` for illegal parking 5 min ago, and `&area=fco`, `&area=cp` or `&area=s62` for a real area. `index.html?whatif=vip` (or `protest` / `event`, add `&crash=1` for the disturbance) runs a what-if on load.

## Real areas from OpenStreetMap

`tools/osm-import.js` pulls every motorway, trunk, primary, secondary and tertiary road and every slip road (`*_link`) in the area from the Overpass API, plus turn restrictions, hospitals and metro stations, and writes `js/networks/<id>.js`:

| What the map has | How the twin uses it |
|---|---|
| Junctions | The 2–4 OSM nodes of a dual-carriageway crossing merge into one junction. Signalised where OSM maps a signal; a few crossings of 3+ main roads are inferred as signalised (shown in the area summary). Every other junction is a give-way junction |
| U-turns | Median openings and U-turns at junctions are allowed movements; a U-turn gives way to everyone |
| Slip roads | Kept as their own links; free-left slip roads bypass the signal and give way where they merge |
| Flyovers / underpasses | Grade-separated links with no junction where they cross a ground road; drawn above / below it |
| Roundabouts and one-way loops | Circulating traffic has priority, and entering cars wait for space so the loop can't lock |
| Lanes, speed limits, one-ways, turn restrictions | From OSM tags, with Indian defaults by road class where a tag is missing |

```
node tools/osm-import.js fco           # Film City corridor, Noida (DND Flyway to Mahamaya Flyover)
node tools/osm-import.js cp            # Connaught Place, New Delhi
node tools/osm-import.js s62           # Sector 62, Noida (NH-9, Delhi–Meerut Expressway)
node tools/osm-import.js all --refresh # pull fresh data (otherwise uses tools/osm-cache/)
```

Add an area by adding an entry to `AREAS` in the tool (centre, half-size in metres, which roads the ambulance, parking and surge events use) and a `<script>` tag for its network file in `index.html`.

## Green corridor lane

The SAARTHI twin has a **dedicated lane the city builds** along the ambulance route (Film City loop: DND → Greater Noida; real Film City: DND Flyway → Max Hospital; Connaught Place: Barakhamba Road → Lady Hardinge Medical College; Sector 62: NH-24 bypass flyover → Fortis). General traffic never enters it, so nothing has to be cleared when an ambulance comes. At each junction the signal holds cross traffic only for the few seconds the ambulance takes to cross. The lane is extra: general traffic keeps all its lanes. The fixed twin is today's road, with no lane and no pre-emption. Switching the layer off rebuilds the SAARTHI twin without the lane.

## Event stopwatch

Every injected event is timed in both twins from the same instant:

| Event | Measures |
|---|---|
| Illegal parking (and crashes) | Spotted (camera ~30 s vs patrol/complaint ~9 min), lane cleared (~6 vs ~15 min), traffic back to normal on that road and its approaches, vehicle-minutes lost |
| Ambulance | Time to reach the hospital exit, delay vs an empty road |
| Event surge | Surge over, queues back to normal network-wide, vehicle-minutes lost |
| Camera fault | Time SAARTHI runs on its fixed fallback plan |

The Results section adds the illegal-parking recovery time as a fifth card.

## Road friction

Both twins carry the same Indian-road friction, with the same drivers, stops and red-runners in each:

| Effect | Model |
|---|---|
| Turning speed | Each movement's radius comes from the junction geometry; drivers slow to √(a_lat · r) before the turn. Straight on ≤ 40 km/h, tight U-turn ~9 km/h; buses, trucks and autos accept less lateral acceleration than cars and two-wheelers |
| Driver temperament | Per-driver headway, acceleration and minimum gap vary ±20–25% (bold drivers follow closer), plus random hesitation (SUMO-style `sigma`), so queues start up unevenly and stop-and-go waves form |
| Red-light running | 25% of two-wheelers, 20% of autos, 8% of cars… carry on through the amber, all-red and first 2 s of the next green if already close and moving |
| Kerbside bus stops | No bus bays: a bus dwells 20–40 s in the kerb lane, and traffic behind it has to merge out |
| Auto / e-rickshaw pick-ups | 1 in 5 autos and e-rickshaws pulls over on a given road for 6–20 s |
| Two-wheeler lane sharing | Two-wheelers ride two abreast in a lane, so a bike in the other half of the lane doesn't hold them up. Behind crawling traffic (< 7 km/h) they filter forward on the lane line, at most ~15 km/h faster than the traffic alongside and past parked cars and dwelling buses, then rejoin once traffic moves. At a red, a bike is first at the line about 55% of the time against a 30% share of traffic |

The Film City loop's capacity was measured again with this friction in place: about 6150 veh/h under overload (about 6370 before any friction, about 5800 before lane sharing). The forecaster uses 88% of that (5400 veh/h), the same ratio as before.

## How the brief maps to the twin

| Brief stage | In the twin |
|---|---|
| Sense | Simulated edge-camera state per lane: queue, PCU, flow, speed, turning ratios, incidents |
| Predict | 60-min demand-vs-capacity forecast from the daily profile, tidal pattern and scheduled events, plus platoon look-ahead at each junction |
| Decide & act | Max-pressure, spillback-aware signal control on a hard safety floor (min/max green, inter-green, anti-starvation, camera-fault fallback to fixed plan); ambulance green corridor; perimeter metering at every loop entry; 70%-compliant VMS diversions |
| Enforce | Illegal parking towed in ~6 min vs ~15 min; box-blocking marshal response 60 s vs 180 s; 90% keep-clear compliance |
| Shape demand | Above 93% forecast load, 12% of car and two-wheeler commuters accept advice to leave 15 min later |

The baseline is a Webster-tuned fixed-time plan for the design peak hour. It is a fair benchmark, not a strawman.

## Headless runs

```
node tools/calibrate.js [startHour] [hours] [demandMult] [seed]
node tools/calibrate.js 8 2.5 1 7      # morning peak A/B
node tools/calibrate.js 8.5 1.75 1 7 cp --events   # Connaught Place, ambulance + illegal parking, event stopwatch
node tools/capacity.js 1.4 7           # both twins overloaded to 140%: trips/h each can carry
node tools/whatif.js protest segment=north start=10 duration=1 disturbance
node tools/whatif.js vip vipRoute=DND-GNO convoys=2 holiday=0.15
node tools/whatif.js event start=17 duration=1.5 surge=0.8
```

## Honest limits

- **What-if assumptions:** advance notice reaches 80% of drivers (25–30% today), VMS compliance is 70%, unannounced closures are spotted in 90 s, and a crash is cleared in 6 min with camera detection or 15 min without. Security needs can override the traffic ranking for VIP movements.
- **Film City geometry is schematic** (1 px = 1 m), so absolute minutes are shorter than the real 45–60 min crossing. Read the relative change.
- **Calibrated to Google Maps typical car times** (Tuesday, Oct 2026) on each real area's corridor, comparing the fixed twin (today's signals):

  | Corridor | Google 6 AM / 9 AM / 10 AM / 1 PM | Twin (middle half of trips) | demandScale |
  |---|---|---|---|
  | Film City: DND Flyway → Lt. Vijyant Thapar Marg | 5–7 / 10–18 / 12–20 / 7–12 min | 6.7–8.0 / 8.5–13.9 / 9.9–20.6 / 7.5–10.0 | 0.43 → 0.52 |
  | Connaught Place: Barakhamba Rd → Bhagat Singh Marg | 4–6 / 8–14 / — / 6–10 | 5.4–6.9 / 6.5–9.9 / 7.7–11.5 / 5.8–8.0 | 0.60 → 0.45 (no 10 AM time yet) |
  | Sector 62: NH-24 flyover → Vishwakarma Rd | 6–8 / 12–20 / — / 8–12 | 6.3–6.7 / 8.9–18.3 / 13.2–32.3 / 6.9–8.5 | 0.72 → 0.97 |

  Midday was too quiet on all three (1 PM at or below the fast end of Google's range), so the shared daily profile now has 12:00–13:00 at 0.95 of the design peak (was about 0.7), easing back to 0.75 by 15:00. Hours before 11:00 are unchanged, so the morning calibration and the website benchmark don't move. Sector 62 sits at its tipping point at midday (1.2× of the old midday was 6.7–7.4 min, 1.4× was 8.6–19.7), so it's left at the lower end.
- **Congestion stays slow but moving instead of flipping to gridlock.** At first Sector 62 couldn't be calibrated: above ~10,200 trips/h it collapsed to under half that. Three causes were fixed. (1) At give-way junctions a side road let one car through every 15 s in heavy traffic; now, when main-road traffic is crawling, drivers take turns (zipper merge). (2) One-way loops are detected up to 1.5 km and 14 roads (was 700 m, 7), so circulating traffic goes first and joiners wait for space. Both carriageways of Vishwakarma Road form a 1.1 km loop that used to fill and lock. (3) Any vehicle stuck in a junction box for 4 min is squeezed out with a 4-min penalty, as SUMO's per-vehicle "teleport" does (the old junction-level version rarely fired). Tried and rejected: a natural keep-clear habit at all junctions (no effect), and waiting at the line at give-way junctions, which moved the circular jam onto the approach roads, where nothing could break it.
- **Demand is calibrated by assumption**, not field counts. For the OSM areas, entry demand comes from road class and lane count, and the origin–destination split from exit capacity and distance. Both are scaled so the 09:00–10:00 peak sits at the edge of capacity.
- **OSM areas:** signal timings, phase plans and lane-level turn rules aren't in OpenStreetMap. Every signal runs one phase per approach (a Webster plan for fixed, the adaptive brain for SAARTHI). Residential and service roads are left out. On the real Film City corridor OSM maps only 2 signals: the corridor is almost all flyovers, loops and slip-road merges, so the signal brain has little to act on there, and most of SAARTHI's gain comes from metering, keep-clear enforcement and the green corridor lane. At the Google-calibrated demand (08:30–10:30, three seeds) SAARTHI vs fixed timers is:

  | Area | Avg trip | 95th pct | Corridor (median) | Gridlock events / day |
  |---|---|---|---|---|
  | Film City | 8.9 vs 8.8 min (tie) | 23.3 vs 22.1 | 12.8 vs 13.1 | 76 vs 141 |
  | Connaught Place | 5.4 vs 7.2 (−25%) | 8.5 vs 13.6 | 5.4 vs 8.3 | 25 vs 260 |
  | Sector 62 | 11.7 vs 13.5 (−13%) | 37.7 vs 46.4 | 14.4 vs 17.9 | 1361 vs 690 |

  On Sector 62 SAARTHI's trips are faster, yet it logs more junctions blocked for 30 s or more. Those are short blockages, not lasting gridlock, but it's not yet understood. Keep-clear only holds a driver back when the exit road is full and standing still. A blanket "wait for a car-length of room" rule wasted greens behind short slip roads and made SAARTHI lose on Film City. A marshal only waves stuck vehicles onto a detour at most 1.5× the original route, and on a real map a detoured trip still counts in the KPIs.- The control brain is a deterministic **stand-in** for the MARL policy (QMIX/MAPPO), with the same shape as its safety-floor fallback.
- **Queues beyond the map edge count like any other queue.** When an entry road fills to the edge, arriving vehicles wait off the map. That time counts as waiting for the first junction, and each time that queue moves again after standing 10 s counts as a fresh stop. Before this, fixed timers, which push about 3 min per trip off the map at the morning peak, looked better on wait and stops than they were.
- **SAARTHI's results depend on whether the loop is just over or just under capacity.** Before two-wheeler lane sharing, the morning peak sat just over SAARTHI's capacity: cars waited through two short greens and its stops gain was only about −20%. Lane sharing adds about 6% capacity and tips SAARTHI back under, while fixed timers stay overloaded. Across five seeds SAARTHI now cuts stops by about 42% and trip time by about half. Field calibration (saturation flow, two-wheeler share) decides which side of that edge the real corridor is on, so treat the size of the gain with care. Signal-timing alternatives that didn't help, over five seeds: longer or "finish the queue" greens back queues up into the junction behind; holding a green for an approaching platoon jams the loop; choosing the next green to catch a platoon changed nothing measurable.
- **Throughput: SAARTHI serves demand better, but it doesn't add road capacity.** With both twins fed the same overload (shaping off, trips finished per hour once saturated, three seeds), SAARTHI vs fixed is +5% at 100% demand, +1% at 120%, −3% at 140%, and +11% at 160%, where fixed timers start to gridlock (seeds vary from −3% to +28%). The roads cap throughput, and a well-tuned fixed plan pushes almost as much through when every approach is overloaded. SAARTHI's gain at the real peak comes from giving green where the demand is (the fixed plan starves the tidal DND approach), not from extra capacity. So the deck's +15–20% throughput target isn't supported by the twin. A fairer claim is "+5% more trips served at today's peak, holds flow when fixed timers gridlock". Reproduce with `node tools/capacity.js 1.4 7`.
- At extreme overload (about 120% evening demand) SAARTHI still wins on 95th-percentile trip time, but average wait and stops are slightly worse than fixed timers. This is worth tuning further in SUMO.

## Next steps

1. Rebuild the network from OpenStreetMap in **SUMO** and drive it through TraCI.
2. Calibrate against Sector 94 ITMS / ANPR counts, using the "twin matches reality" gate.
3. Train the MARL policy in the twin and keep this scheduler as its safety-floor fallback.

## Files

```
index.html          website
css/site.css        design tokens (light/dark) and layout
js/engine.js        simulation engine (DOM-free; also runs in Node), any road graph
js/networks/*.js    real road networks built from OpenStreetMap (fco, cp, s62)
js/render.js        canvas map renderer (polylines, flyovers, zoom/pan)
js/charts.js        time-series charts
js/lab.js           live twin lab (lockstep A/B)
js/planner.js       what-if planner: candidate plans, ranking, recommendation (DOM-free; also runs in Node)
js/whatif.js        Plan ahead section: scenario form, map, results
js/site.js          hero twin, live graph, closed-loop stepper, benchmark, nav/theme
tools/calibrate.js  headless A/B runner (any area, optional event stopwatch)
tools/capacity.js   headless capacity A/B (both twins overloaded, trips/h once saturated)
tools/osm-import.js OpenStreetMap → twin network builder (raw data cached in tools/osm-cache/)
tools/whatif.js     headless what-if runner
```
