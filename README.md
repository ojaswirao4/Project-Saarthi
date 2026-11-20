# Project SAARTHI: website and corridor digital twin

A presentation website for SAARTHI with a live digital twin of the Noida Film City / Sector 16A loop built in.
Open `index.html` in Chrome or Edge. No install is needed. An internet connection is used for the Inter web font and for the real map under each real area.

**Real map under the roads.** Every real area (not the schematic loop) is drawn on a real map, so buildings, apartments, parks and the sector and residential roads the twin doesn't simulate are still on screen. The live twin has a **Map** switch: *Streets*, *Satellite* or *Off*; the Plan ahead map follows it. Satellite (Esri imagery) works everywhere and is the default when the page is opened as a file. The OpenStreetMap street map, with building outlines and sector names, only loads when the site is served from a web address, because OSM's tile servers refuse requests from a local file. Run `node tools/serve.js` and open http://localhost:8765 for it. Opened as a file, *Streets* falls back to Esri's street map, which has no buildings for Noida. In the dark theme the street map is colour-inverted to match.

## The page, top to bottom

| Section | What it shows |
|---|---|
| Hero | The SAARTHI twin running live, plus headline results from the in-browser benchmark |
| 01 Problem | The five failure modes from the brief and the "Noida already owns the hardware" insight |
| 02 Approach | A live **graph view** of the corridor (edges coloured by occupancy, nodes sized by queue) and the closed loop: Sense → Predict → Decide & act → Enforce → Shape demand |
| 03 Live twin | Fixed timers vs SAARTHI side by side on identical traffic: an **area picker** (the schematic Film City loop, or the real road network of the **Film City corridor**, **Connaught Place**, **Sector 62 Noida** or **Sector 34 Noida** from OpenStreetMap), event injection with an **event stopwatch**, KPIs, charts, demand forecast, junction inspector (each road's queue and light in both twins), and a decision log. Zoom with Ctrl + scroll or the + / − buttons, drag to pan |
| 04 Analysis | The live twin measured as it runs (headline, rolling 15-min KPI table, 95th-percentile and vehicles-stopped charts, demand-vs-capacity forecast), and a full 08:00–10:30 morning peak **simulated in the browser on page load** (KPI cards and the 95th-percentile chart through the peak) |
| 05 Control console | The **traffic controller's screen** (see *Control console* below), with two tabs. **Live**: one live SAARTHI twin of a real area; log a road closure, crash, ambulance or event crowd, review the advisory SAARTHI drafts, send it, see what it did; camera alerts and marshals. **Plan ahead**: the what-if planner for a protest, VIP movement or big event, and scheduling the recommended plan into the live twin |
| 06 Results | The morning-peak run from Analysis scored against the deck's slide-11 targets, and the real-map comparison (measured offline) |
| 07–08 | Architecture (six system layers, and a table of the SAARTHI layers: what each does, which system layer it runs in, its status in the twin), the phased rollout (Phase 1 "Twin & shadow" marked as live), and the closing call to action |

There's a light/dark toggle in the nav. While the live twin is on screen, presenters can press Space to pause, F to jump 15 min, and A / P / E / C to fire an ambulance, illegal parking, an event surge or a camera fault. `index.html?ff=2&amb=1` opens the twin 30 min in with an ambulance just dispatched; add `&park=5` for illegal parking 5 min ago, and `&area=fco`, `&area=cp`, `&area=s62` or `&area=s34` for a real area. `index.html?whatif=vip` (or `protest` / `event`, add `&crash=1` for the disturbance, `&area=cp` / `s62` / `s34` for another area) opens the console's Plan ahead tab and runs a what-if on load.

## Control console

The control console (section 05) is the traffic controller's workspace: one live SAARTHI twin of a real area on the full screen, and a panel to log what is happening. It runs in real time on this computer's clock; there is no start time, speed or pause. There is no live detector feed yet, so the traffic in it is typical traffic for the current time of day. If the console has been off screen for over 30 minutes with nothing open, it starts again at the current time; otherwise it catches up. Activity-log lines about a junction name it by its roads and, when clicked, show it on the map. **Camera alerts** assume the junction cameras are connected: a junction blocked for 20 s or more (vehicles stuck inside because the road out is full) raises an alert with *Show on map* and *Send marshal*. A marshal sent reaches it in about 20 s and waves the stuck vehicles out; the card then says who cleared it (the marshal, or traffic moving again). Without one, a marshal on the ground notices after 3 min, as with no cameras. In the twin the "camera" is the simulation itself. The **Live** tab is described here; the **Plan ahead** tab is below. The controller logs a **road closure** (a known site or roads clicked on the map, both directions, a reason and how long), a **crash** (click the road; one lane or all; expected clearance), an **ambulance** (where it sets off, a map edge or a point clicked on the map, and which hospital on the map it is going to; the route is previewed; SAARTHI suggests each light change on the way (see *Smart signal priority* below) and it drives in the green corridor lane wherever its route uses it), or an **event crowd** (click the venue anywhere on the map, or use the area's preset venue; an optional name, crowd size and how long).

SAARTHI then drafts an advisory for travellers: how many drivers in the twin are heading for the affected roads, the way round for each direction of travel (busiest first; click one to see it on the map), and an editable title and message with a plain preview of what the traveller sees. **Nothing reaches drivers until the controller presses Send.** Before that, a closed road is found at the barricade. After it, drivers who get the advice route round it. A crash or crowd is advice only: the road stays open. Each incident card then reports what the advisory did in the twin: how many took the way round, went round before setting off, or were turned back at the barricade before and after sending.

Twin assumptions, shown on the draft: every driver heading that way receives the advisory, and 7 in 10 follow it. The ambulance message is informational; the twin does not model drivers' response to it (its lane and signal priority clear its way). `index.html?area=cp` (or `s62`, `s34`) opens it, and the live twin, on another area.

### Needs attention, manual override, action log

**Needs attention** (top of the side panel) is one list of what needs the controller now, most urgent first, with the action on each line: an ambulance's light suggestion (Urgent: Turn light green / Leave it / Show), gridlock and blocked junctions (Show / Send marshal), an incident whose advisory has not been sent (Draft advisory), a manual override about to end (+5 min / End now), a camera fault, a scheduled plan starting within 15 min. Anything but an ambulance's light can be acknowledged; it comes back after 5 min if it is still there.

**Manual override.** Click any signal on the map (also while drawing a closure) for its panel: each road coming in, its light, its queue and how long it has been red. The controller can take the signal over for 2, 5 or 15 min: hold green for one road, run the fixed plan, or switch it to flashing amber (signal off, drivers give way). Safety stays with the signal: every switch runs amber and all-red, the current green runs at least 5 s, and an ambulance with priority still gets its green (the hold resumes after it has crossed). It returns to SAARTHI by itself when the time is up; +5 min and End override are in the panel and in Needs attention. Overridden signals are labelled on the map.

**Action log** (third tab). Every decision taken in the console, with the controller on duty (the "On duty" box in the console bar, remembered in this browser): what SAARTHI suggested, what the controller chose, and how long after the alert. It records incidents logged and cleared, advisories sent (as drafted or edited) or held, ambulance lights turned green or left (and suggestions nobody answered before the ambulance got there), marshals sent, manual overrides, acknowledgements and plans scheduled or cancelled. Download CSV exports it; it is kept for the session only.

### Plan ahead tab

For something known in advance: a **protest** closing a named road, a **VIP movement** (G20-style: convoys, schools and offices closed by order) or a **big event** at a real landmark. It plans for the area open in the console. SAARTHI rehearses the event in fast-forward: today's usual approach and 2–3 SAARTHI plans on identical traffic. It ranks them and recommends one, with an action timeline, public diversions and, for a VIP, a separate convoy route. An optional unplanned crash checks that the plan is caught and corrected.

**Schedule this plan** puts it on the live twin's clock: today if its start time has not passed, otherwise tomorrow. At those times the closures, VIP lane and convoys, office-hour changes or event crowd happen in the live twin, with the plan's advance notice (the share of drivers told beforehand). The plan then shows under *Scheduled plans* in the Live tab with its timeline and status (starts in…, under way, finished), and can be cancelled or called off. *Compare in the live twin* still loads today's approach and the plan side by side in section 03. `index.html?whatif=protest` (or `vip` / `event`; add `&crash=1` for the disturbance) opens the tab and runs it.

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
node tools/osm-import.js s34           # Sector 34, Noida (Main Road Gijhor × Shaheed Captain Shashikant Sharma Marg)
node tools/osm-import.js all --refresh # pull fresh data (otherwise uses tools/osm-cache/)
```

Add an area by adding an entry to `AREAS` in the tool (centre, half-size in metres, which roads the ambulance, parking and surge events use) and a `<script>` tag for its network file in `index.html`.

## Green corridor lane

The SAARTHI twin has a **dedicated lane the city builds** along the ambulance route (Film City loop: DND → Greater Noida; real Film City: DND Flyway → Max Hospital; Connaught Place: Barakhamba Road → Lady Hardinge Medical College; Sector 62: NH-24 bypass flyover → Fortis; Sector 34: Main Road Gijhor → Surbhi Hospital). General traffic never enters it, so nothing has to be cleared when an ambulance comes. The lane is extra: general traffic keeps all its lanes. Switching the layer off rebuilds the SAARTHI twin without the lane.

**Every other route to every hospital** gets a green corridor on demand, as Indian cities do it: when an ambulance is dispatched, the median lane of each road on its route without a built lane is cleared for it (drawn as a dashed green lane). Drivers in it move out where they find a gap; in a standing queue they cannot, and whoever is ahead of the ambulance in that lane is let through the junction first. Each road opens again as soon as the ambulance has passed it. Single-lane roads cannot be cleared. Connaught Place 08:30, six routes from different edges to the five hospitals (1.4–2.1 km): fixed timers 4–8 min, SAARTHI 2–4 min.

**Signal groups.** A crossing of divided roads is several junction points in the network (each carriageway meets the other separately), so a signal mapped there cannot run at any single point. Signalised points within 80 m of each other that include such a point, and were confirmed by a signal survey, become one group: one signal whose phases are the roads coming in from outside it; the short links inside the crossing are not stopped by it. Groups are made only of surveyed or inferred signals, and are never wider than 70 m (nearby crossings stay separate). In a group, the two directions of the same road share a green, as at a divided-road crossing; other roads go one at a time. Vehicles on the short links inside a group clear the crossing, and keep-clear and the signal brain look past those links to the road the vehicle leaves by. Sector 62 has 3 OSM signals on Vishwakarma Road that the model cannot use: at each, the only roads coming in are the two directions of Vishwakarma Road, so nothing in the model crosses them (probably pedestrian or median-crossing signals; pedestrians are not modelled). They need checking on the ground (28.62785 N 77.37443 E, 28.62390 N 77.37426 E, 28.61789 N 77.37367 E).

**Inferred signals (Film City and Sector 62, until a survey).** OSM maps almost no signals in these two areas, so the ambulance light suggestions had nothing to work on. Until a signal survey arrives (`inferCrossings` in the import tool; a survey file switches it off), every at-grade crossing where 3 or more roads come in, from at least 2 different roads, without an OSM signal, is taken as signalised. Merges of two roads and anything on a motorway or expressway (e.g. the Delhi-Meerut Expressway) are not. Film City gets 3, Sector 62 gets 5; each is labelled "inferred, to be confirmed by survey" in the twin and in the ambulance suggestion. SAARTHI runs an inferred signal on its fixed plan (its real layout and phasing are not known); ambulance and VIP priority still apply there, and a survey makes it adaptive. Film City was re-calibrated with them (demand scale 0.52 → 0.42; fixed twin corridor 9 AM 10–15, 10 AM 11–13, 1 PM 7.4–10 min, Google 10–18, 12–20, 7–12; 6 AM 7–10 is above Google's 5–7 because the signals run one all-day plan). Sector 62 needed no change (6 AM 6.3–7.2, 9 AM 8.6–15.4, 1 PM 7.4–9.9 min; it still slows after 9:30, as before).

**Route advice change (all maps).** SAARTHI's VMS / navigation advice now only steps in when it recommends a clearly quicker alternative (under 80% of the time, every road on it under half full, counting how long the front vehicle has been standing at each junction on it). Before, when the two routes were about the same, it told 70% of drivers to take the first, piling traffic onto it instead of the usual split; with Film City's new signals that locked its give-way junctions and made SAARTHI slower than fixed timers. 08:00–10:00, seed 7, average trip fixed → SAARTHI: Film City loop 8:58 → 3:06, Connaught Place 6:54 → 5:19, Film City 11:37 → 9:59, Sector 62 15:38 → 15:28, Sector 34 2:51 → 2:48. The "On the real maps" table in section 05 predates this and needs re-measuring (5 seeds, 08:00–12:00).

**Signal survey.** OSM marks a signal at 1 of the 11 Film City crossings in the model. `node tools/signal-survey.js fco` writes `survey/fco-signals.html`: each at-grade crossing of mapped roads with Google Maps and Street View links, to be marked Signal / No signal / Can't tell, with who checked it, when and how. It downloads `fco.json`; put it at `tools/signals/fco.json` and `tools/osm-import.js` applies it on top of OSM (a point marked Signal signalises the junction within 40 m of it; No signal removes an OSM signal). After a survey, recalibrate the area against Google Maps times.

On top of the lane, **smart signal priority** turns each signal ahead of the ambulance green before it arrives (within about 350 m along its route, looking past short links to the next signal, once the current green has run 4 s; a light already green for it is kept green), and holds cross traffic for the few seconds it takes to cross. It is a separate switch and works with or without the lane: without the lane, the green also clears the queue in front of the ambulance. VIP convoys get the same priority. The fixed twin is today's road, with no lane and no signal priority.

In the control console, signal priority for an ambulance is a **suggestion to the controller**, one light at a time. When the ambulance comes within about 500 m of a signal on its route, SAARTHI suggests turning that light green for it, with two buttons: **Turn light green** and **Leave it on normal control**. It asks only where it is needed: a light already green for the ambulance's road is simply kept green until it has crossed, with a line in the timeline and nothing to press. A light turned green changes at once (the current green has run at least 4 s) and stays green until the ambulance has crossed, then goes back to normal control; a light nobody changes may catch it at red. A tick box changes the lights for ambulances automatically, without asking. In the **twin** (section 03) there is no asking: SAARTHI turns each light green itself, since the twin compares the lights, not the click. The *Ambulance run* panel below the maps shows the steps (reported, signals on its route, through on green, arrived), a timestamped step-by-step timeline (each light changing and how far away the ambulance was, each junction crossed, arrival, with the fixed-timer ambulance's red-light stops alongside) and the time difference at the end; each twin's progress and per-signal outcome sit just above its own map. *Follow on the map* keeps each twin's ambulance centred, and the map labels a light changed for it, or an ambulance waiting at red. In the **console** it runs in real time, so nothing pauses: the suggestion appears over the map (top left) with the buttons and a Show button, the signal is ringed in amber with "turn green?", and the ambulance's incident card lists every signal on its route with its status. The real Film City and Sector 62 ambulance routes have no signals (flyovers and merges), so there is nothing to change there; Connaught Place (5 signals) shows it best. Connaught Place 08:30: fixed timers 5 min 37 s; SAARTHI with every light turned green 2 min 39 s; with the suggestions ignored about 4 min. The Results section changes the lights automatically.

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
| Decide & act | Max-pressure, spillback-aware signal control on a hard safety floor (min/max green, inter-green, anti-starvation, camera-fault fallback to fixed plan); ambulance green corridor; perimeter metering at every loop entry (schematic loop only); 70%-compliant VMS diversions; merge control where a flyover slip road gives way (the road with the longer queue goes first) |
| Enforce | Illegal parking towed in ~6 min vs ~15 min; box-blocking marshal response 60 s vs 180 s; 90% keep-clear compliance |
| Shape demand | Above 93% forecast load, 12% of car and two-wheeler commuters accept advice to leave 15 min later |

The baseline is a Webster-tuned fixed-time plan for the design peak hour. It is a fair benchmark, not a strawman.

## Headless runs

```
node tools/calibrate.js [startHour] [hours] [demandMult] [seed]
node tools/calibrate.js 8 2.5 1 7      # morning peak A/B
node tools/calibrate.js 8.5 1.75 1 7 cp --events   # Connaught Place, ambulance + illegal parking, event stopwatch
node tools/capacity.js 1.4 7           # both twins overloaded to 140%: trips/h each can carry
node tools/whatif.js protest area=fco segment=vtm start=10 duration=1 disturbance
node tools/whatif.js vip area=cp vipRoute=barakhamba-sansad convoys=2 holiday=0.15
node tools/whatif.js event area=s62 start=17 duration=1.5 crowd=1000
node tools/whatif.js protest area=fc segment=north   # the schematic loop
```

## Honest limits

- **What-if assumptions:** advance notice reaches 80% of drivers (25–30% today), VMS compliance is 70%, unannounced closures are spotted in 90 s, and a crash is cleared in 6 min with camera detection or 15 min without. Security needs can override the traffic ranking for VIP movements.
- **What-if on real maps:** closure sites, VIP routes and event venues are listed per area in `js/planner.js`. A protest closes a named road in both directions wherever it lies within a set distance of a junction; a VIP route is the quickest road between two map-edge entries; an event's crowd drives off from the two roads nearest a landmark taken from OpenStreetMap (a metro station, or the centre of Connaught Place) and parks on the kerb lanes within 250 m. The real maps leave out residential and sector roads, so some closures leave trips with no way through on the mapped roads (65% of the Film City corridor's trips when Dadri Main Road closes, 0% for the Connaught Place sites). Those trips finish off the map with a penalty: +5 min if the driver knew before setting off (advance notice, or the VMS at the map edge), +10 min if turned back at the barricade. Both are assumptions; they make advance notice count, and the size of the gain depends on them.
- **Film City geometry is schematic** (1 px = 1 m), so absolute minutes are shorter than the real 45–60 min crossing. Read the relative change.
- **Calibrated to Google Maps typical car times** (Tuesday, Oct 2026) on each real area's corridor, comparing the fixed twin (today's signals):

  | Corridor | Google 6 AM / 9 AM / 10 AM / 1 PM | Twin (middle half of trips) | demandScale |
  |---|---|---|---|
  | Film City: DND Flyway → Lt. Vijyant Thapar Marg | 5–7 / 10–18 / 12–20 / 7–12 min | 6.7–8.0 / 8.5–13.9 / 9.9–20.6 / 7.5–10.0 | 0.43 → 0.52 |
  | Connaught Place: Barakhamba Rd → Bhagat Singh Marg | 4–6 / 8–14 / — / 6–10 | 5.4–6.9 / 6.5–9.9 / 7.7–11.5 / 5.8–8.0 | 0.60 → 0.45 (no 10 AM time yet) |
  | Sector 62: NH-24 flyover → Vishwakarma Rd | 6–8 / 12–20 / — / 8–12 | 6.3–6.7 / 8.9–18.3 / 13.2–32.3 / 6.9–8.5 | 0.72 → 0.97 |

  Midday was too quiet on all three (1 PM at or below the fast end of Google's range), so the shared daily profile now has 12:00–13:00 at 0.95 of the design peak (was about 0.7), easing back to 0.75 by 15:00. Hours before 11:00 are unchanged, so the morning calibration and the website benchmark don't move. Sector 62 sits at its tipping point at midday (1.2× of the old midday was 6.7–7.4 min, 1.4× was 8.6–19.7), so it's left at the lower end.
- **Congestion stays slow but moving instead of flipping to gridlock.** At first Sector 62 couldn't be calibrated: above ~10,200 trips/h it collapsed to under half that. Three causes were fixed. (1) At give-way junctions a side road let one car through every 15 s in heavy traffic; now, when main-road traffic is crawling, drivers take turns (zipper merge). (2) One-way loops are detected up to 1.5 km and 14 roads (was 700 m, 7), so circulating traffic goes first and joiners wait for space. Both carriageways of Vishwakarma Road form a 1.1 km loop that used to fill and lock. (3) Any vehicle stuck in a junction box for 4 min is squeezed out with a 4-min penalty, as SUMO's per-vehicle "teleport" does (the old junction-level version rarely fired). Tried and rejected: a natural keep-clear habit at all junctions (no effect), and waiting at the line at give-way junctions, which moved the circular jam onto the approach roads, where nothing could break it.
- **Sector 34 is not calibrated yet.** OSM maps no signals there, so at-grade junctions of main roads are inferred as signalised (2: Main Road Gijhor × Shaheed Captain Shashikant Sharma Marg by the metro, and one further up Gijhor). Its demand level (0.7) is a placeholder: at it the corridor (Shashikant Sharma Marg from the south-west edge, 28.5730 N 77.3536 E, to its underpass at the north-east edge, 28.5877 N 77.3733 E) takes about 5 min at 7 AM and at 9 AM alike, so the morning peak is too light. It needs Google Maps typical times for that corridor like the other areas. The ambulance and the corridor are fixed by entry and exit id (`ambulanceIds`, `corridorIds` in the import tool), because Surbhi Hospital is inside the area.
- **Demand is calibrated by assumption**, not field counts. For the OSM areas, entry demand comes from road class and lane count, and the origin–destination split from exit capacity and distance. Both are scaled so the 09:00–10:00 peak sits at the edge of capacity.
- **OSM areas:** signal timings, phase plans and lane-level turn rules aren't in OpenStreetMap. Every signal runs one phase per approach (a Webster plan for fixed, the adaptive brain for SAARTHI). Residential and service roads are left out. On the real Film City corridor OSM maps only 2 signals: the corridor is almost all flyovers, loops and slip-road merges, so the signal brain has little to act on there, and most of SAARTHI's gain comes from keep-clear enforcement, flyover-slip merge control and the green corridor lane. At the Google-calibrated demand (08:30–10:30, three seeds) SAARTHI vs fixed timers is:

  | Area | Avg trip | 95th pct | Corridor (median) | Gridlock events / day |
  |---|---|---|---|---|
  | Film City | 8.9 vs 8.8 min (tie) | 23.3 vs 22.1 | 12.8 vs 13.1 | 76 vs 141 |
  | Connaught Place | 5.4 vs 7.2 (−25%) | 8.5 vs 13.6 | 5.4 vs 8.3 | 25 vs 260 |
  | Sector 62 | 11.7 vs 13.5 (−13%) | 37.7 vs 46.4 | 14.4 vs 17.9 | 1361 vs 690 |

  On Sector 62 SAARTHI's trips are faster, yet it logs more junctions blocked for 30 s or more. Those are short blockages, not lasting gridlock, but it's not yet understood. Keep-clear only holds a driver back when the exit road is full and standing still. A blanket "wait for a car-length of room" rule wasted greens behind short slip roads and made SAARTHI lose on Film City. A marshal only waves stuck vehicles onto a detour at most 1.5× the original route, and on a real map a detoured trip still counts in the KPIs.
- **Merges on the Film City corridor.** Without signals to retime, SAARTHI only tied fixed timers there. Most of the waiting is at unsignalised merges and splits. Two fixes were tried over 5 seeds. Giving small pass-through and split points more room sped up both twins but removed SAARTHI's edge, so it wasn't kept. Letting the road with the longer queue go first at every corridor merge only moved the waiting from the main road to the ramps: at those merges the junction's capacity, not giving way, sets the pace. Doing it only where a flyover slip road gives way (P74, P88 and P121; Connaught Place and Sector 62 have none) was kept. Perimeter metering now runs on the schematic loop only: a real map's entries are just its edge, so holding traffic there only moved the queue off the map (with it off, SAARTHI's average trip was shorter on all 5 Film City seeds; Connaught Place unchanged, Sector 62 slightly better). 08:00–12:00, 5 seeds, SAARTHI vs fixed on Film City: average trip 8.4 vs 8.9 min (was 8.8), 95th percentile 22.0 vs 23.2 min (was 23.4). SAARTHI is better on all 5 seeds, though the margin is still modest.
- The control brain is a deterministic **stand-in** for the MARL policy (QMIX/MAPPO), with the same shape as its safety-floor fallback.
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
js/networks/*.js    real road networks built from OpenStreetMap (fco, cp, s62, s34)
js/render.js        canvas map renderer (polylines, flyovers, zoom/pan)
js/basemap.js       real map tiles (OpenStreetMap streets / Esri satellite) under the real areas
js/charts.js        time-series charts
js/lab.js           live twin lab (lockstep A/B)
js/console.js       control console (section 05): incidents, advisory drafts, what each advisory did
js/planner.js       what-if planner: candidate plans, ranking, recommendation (DOM-free; also runs in Node)
js/whatif.js        control console, Plan ahead tab: scenario form, map, results
js/site.js          hero twin, live graph, closed-loop stepper, benchmark, nav/theme
tools/calibrate.js  headless A/B runner (any area, optional event stopwatch)
tools/capacity.js   headless capacity A/B (both twins overloaded, trips/h once saturated)
tools/osm-import.js OpenStreetMap → twin network builder (raw data cached in tools/osm-cache/)
tools/whatif.js     headless what-if runner
tools/serve.js      local web server for the site (needed for the OpenStreetMap street map)
```
