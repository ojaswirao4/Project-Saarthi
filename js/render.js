/* Canvas renderer for one twin. World units are metres along roads; the schematic Film City loop is
 * 1000 × 640, real areas use their OpenStreetMap extent. Supports zoom and pan (shared between twins). */
(function () {
  'use strict';
  const { JR, lanePoint, laneOffset, sideOffset, frameAt, bezPoint, bezTangent } = window.SAARTHI;
  const TYPE_WIDTH = { car: 0.7, tw: 0.4, auto: 0.62, erick: 0.58, bus: 0.85, truck: 0.82, ev: 0.8, vip: 0.8 };
  const VIP = '#8b5cf6';
  const GC = '#16a34a';

  function rrect(ctx, cx, cy, ux, uy, len, wid) {
    const hx = ux * len / 2, hy = uy * len / 2, wx = -uy * wid / 2, wy = ux * wid / 2;
    ctx.moveTo(cx + hx + wx, cy + hy + wy);
    ctx.lineTo(cx + hx - wx, cy + hy - wy);
    ctx.lineTo(cx - hx - wx, cy - hy - wy);
    ctx.lineTo(cx - hx + wx, cy - hy + wy);
    ctx.closePath();
  }

  // A link's polyline shifted sideways by `off` (same side convention as lanePoint), mitred at bends.
  function offsetPath(L, off) {
    const key = off.toFixed(2);
    L._off = L._off || {};
    if (L._off[key]) return L._off[key];
    const P = L.pts, n = P.length, out = [];
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1), b = Math.min(n - 2, i);
      let nx = (L.sv[a] + L.sv[b]) / 2, ny = -(L.su[a] + L.su[b]) / 2;
      const d = Math.hypot(nx, ny) || 1;
      nx /= d; ny /= d;
      const k = Math.min(3, 1 / Math.max(0.33, nx * L.sv[b] - ny * L.su[b]));
      out.push([P[i][0] + nx * off * k, P[i][1] + ny * off * k]);
    }
    return (L._off[key] = out);
  }

  function strokePath(ctx, pts) {
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  }

  // The first `d` units of a polyline, and the last `d`.
  function headPts(pts, d) {
    const out = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1], [bx, by] = pts[i], s = Math.hypot(bx - ax, by - ay);
      if (s >= d) { const u = s ? d / s : 0; out.push([ax + (bx - ax) * u, ay + (by - ay) * u]); return out; }
      d -= s; out.push(pts[i]);
    }
    return out;
  }
  const tailPts = (pts, d) => headPts(pts.slice().reverse(), d).reverse();

  const lvl = L => (L.level > 0 ? 1 : 0);

  class Renderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.sim = null;
      this.theme = null;
      this.selected = 'FC-01';
      this.colorBy = 'speed';
      this.scale = 0;
      this.view = { z: 1, cx: null, cy: null }; // can be shared between renderers
    }

    get W() { return this.sim ? this.sim.net.size.w : 1000; }
    get H() { return this.sim ? this.sim.net.size.h : 640; }

    resize() {
      const r = this.canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
      if (!r.width) { this.scale = 0; return; }
      this.canvas.width = Math.round(r.width * dpr);
      this.canvas.height = Math.round(r.height * dpr);
      this.cw = r.width; this.ch = r.height;
      this.dpr = dpr;
      this.layout();
    }

    layout() {
      if (!this.cw) return;
      const v = this.view, W = this.W, H = this.H;
      this.base = Math.min(this.cw / W, this.ch / H);
      this.scale = this.base * v.z;
      // keep the view inside the map
      const hw = this.cw / 2 / this.scale, hh = this.ch / 2 / this.scale;
      let cx = v.cx == null ? W / 2 : v.cx, cy = v.cy == null ? H / 2 : v.cy;
      cx = hw * 2 >= W ? W / 2 : Math.min(W - hw, Math.max(hw, cx));
      cy = hh * 2 >= H ? H / 2 : Math.min(H - hh, Math.max(hh, cy));
      if (v.cx != null) { v.cx = cx; v.cy = cy; }
      this.ox = this.cw / 2 - cx * this.scale;
      this.oy = this.ch / 2 - cy * this.scale;
    }

    toWorld(clientX, clientY) {
      const r = this.canvas.getBoundingClientRect();
      return [(clientX - r.left - this.ox) / this.scale, (clientY - r.top - this.oy) / this.scale];
    }

    zoomAt(clientX, clientY, f) {
      const v = this.view, r = this.canvas.getBoundingClientRect();
      const [wx, wy] = this.toWorld(clientX, clientY);
      v.z = Math.min(14, Math.max(1, v.z * f));
      const s = this.base * v.z;
      v.cx = wx - (clientX - r.left - this.cw / 2) / s;
      v.cy = wy - (clientY - r.top - this.ch / 2) / s;
      if (v.z === 1) { v.cx = v.cy = null; }
      this.layout();
    }

    pan(dx, dy) {
      const v = this.view;
      if (v.cx == null) { v.cx = (this.cw / 2 - this.ox) / this.scale; v.cy = (this.ch / 2 - this.oy) / this.scale; }
      v.cx -= dx / this.scale; v.cy -= dy / this.scale;
      this.layout();
    }

    resetView() { this.view.z = 1; this.view.cx = this.view.cy = null; this.layout(); }

    hit(clientX, clientY) {
      if (!this.sim || !this.scale) return null;
      const [x, y] = this.toWorld(clientX, clientY);
      let best = null, bd = Math.max(60, 26 / this.scale);
      for (const j of this.sim.junctions) {
        const d = Math.hypot(j.x - x, j.y - y);
        if (d < bd) { bd = d; best = j.id; }
      }
      return best;
    }

    draw(now) {
      const { ctx, sim, theme } = this;
      if (!sim || !theme || !this.scale) return;
      this.layout();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = theme.ground;
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      this.px = 1 / this.scale; // one screen pixel in world units
      this.world();
      if (sim.net.schematic) this.drawBlock();
      else if (window.SAARTHI_BASEMAP) { // the real map under the simulated roads: buildings, apartments, local roads
        const s = this.scale, view = { x0: -this.ox / s, y0: -this.oy / s, x1: (this.cw - this.ox) / s, y1: (this.ch - this.oy) / s };
        window.SAARTHI_BASEMAP.drawCanvas(ctx, sim.net, view, 1 / (s * this.dpr), theme.ground);
      }
      this.evAt = []; // where each ambulance was drawn (the twin's "follow the ambulance" reads it)
      for (const level of [0, 1]) {
        this.drawRoads(level);
        this.drawPlan(level);
        this.drawSignals(level);
        this.drawVehicles(now, level);
      }
      this.drawOverlays(now);
      if (sim.net.schematic) this.drawLabels();
      else this.drawRealLabels();
      this.drawPlanLabels(); // green corridor, closures, VIP lanes: on top of the map's own labels
    }

    world() {
      const s = this.dpr * this.scale;
      this.ctx.setTransform(s, 0, 0, s, this.dpr * this.ox, this.dpr * this.oy);
    }

    screen() { this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); }

    sx(x) { return x * this.scale + this.ox; }
    sy(y) { return y * this.scale + this.oy; }

    centroid() {
      const js = this.sim.junctions;
      return [js.reduce((a, j) => a + j.x, 0) / js.length, js.reduce((a, j) => a + j.y, 0) / js.length];
    }

    drawBlock() {
      const { ctx, sim, theme } = this;
      const [cx, cy] = this.centroid();
      ctx.beginPath();
      sim.junctions.forEach((j, i) => {
        const dx = cx - j.x, dy = cy - j.y, d = Math.hypot(dx, dy), k = 50 / d;
        const x = j.x + dx * k, y = j.y + dy * k;
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      });
      ctx.closePath();
      ctx.fillStyle = theme.block;
      ctx.fill();
      ctx.fillStyle = theme.blockText;
      ctx.font = '600 15px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('FILM CITY', cx, cy - 8);
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillText('Sector 16A', cx, cy + 10);
    }

    drawRoads(level) {
      const { ctx, sim, theme } = this;
      const links = sim.linkList.filter(L => lvl(L) === level);
      const nodes = sim.isects.filter(j => j.level === level);
      if (!links.length && !nodes.length) return;
      ctx.lineCap = 'butt';
      ctx.lineJoin = 'round';
      if (level === 1) { // flyover deck: shadow and parapet so it reads as above the ground roads
        ctx.strokeStyle = 'rgba(0,0,0,0.35)';
        for (const L of links) {
          ctx.lineWidth = L.lanes * L.lw + 4;
          ctx.beginPath(); strokePath(ctx, offsetPath(L, L.base + L.lanes * L.lw / 2 + 1.5)); ctx.stroke();
        }
        ctx.strokeStyle = theme.kerb;
        for (const L of links) {
          ctx.lineWidth = L.lanes * L.lw + 1.6;
          ctx.beginPath(); strokePath(ctx, offsetPath(L, L.base + L.lanes * L.lw / 2)); ctx.stroke();
        }
      }
      for (const L of links) { // median strip between the two directions of a two-way road
        if (L.oneway) continue;
        ctx.strokeStyle = theme.median;
        ctx.lineWidth = 2 * L.base;
        ctx.beginPath(); strokePath(ctx, L.pts); ctx.stroke();
      }
      for (const L of links) {
        const w = L.lanes * L.lw;
        ctx.globalAlpha = L.level < 0 ? 0.55 : 1; // underpass
        ctx.strokeStyle = theme.road;
        ctx.lineWidth = w + 0.6;
        ctx.beginPath(); strokePath(ctx, offsetPath(L, L.base + w / 2)); ctx.stroke();
      }
      ctx.globalAlpha = 1;
      const pad = sim.net.schematic ? 7 : 2.5;
      ctx.fillStyle = theme.road;
      for (const j of nodes) { ctx.beginPath(); ctx.arc(j.x, j.y, j.r + pad, 0, Math.PI * 2); ctx.fill(); }
      if (this.scale * links[0].lw < 1.6) return; // markings only when a lane is wide enough to see
      this.drawMarkings(links);
    }

    // Road markings as painted (IRC-style, urban): dashed white lane lines, 3 m line / 5 m gap, solid for the
    // last 20 m before a signal (no lane changes on the approach); solid edge lines on the kerb and median
    // sides; a stop line across the approach at each signal. Widths never drop below a screen pixel.
    drawMarkings(links) {
      const { ctx, sim, theme } = this, px = this.px;
      const k = sim.net.schematic ? 1.5 : 1; // the schematic loop is drawn in px, not metres
      const sigEnd = L => { const j = sim.nodes[L.to]; return !!(j && j.sig && !L.free && L.kind !== 'exit'); };
      const NO_CHANGE = 20 * k;
      ctx.lineCap = 'butt';
      // lane lines
      ctx.strokeStyle = theme.lane;
      ctx.lineWidth = Math.max(0.15 * k, 0.9 * px);
      ctx.setLineDash([3 * k, 5 * k]);
      ctx.beginPath();
      for (const L of links) {
        const stop = sigEnd(L) && L.length > NO_CHANGE * 1.5;
        for (let i = 1; i < L.lanes; i++) {
          if (L.gc != null && i === L.lanes - L.gc - 1) continue; // the corridor lane has its own solid line
          const p = offsetPath(L, L.base + i * L.lw);
          strokePath(ctx, stop ? headPts(p, L.length - NO_CHANGE) : p);
        }
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath(); // solid on the signal approach
      for (const L of links) {
        if (!sigEnd(L) || L.length <= NO_CHANGE * 1.5) continue;
        for (let i = 1; i < L.lanes; i++) {
          if (L.gc != null && i === L.lanes - L.gc - 1) continue;
          strokePath(ctx, tailPts(offsetPath(L, L.base + i * L.lw), NO_CHANGE));
        }
      }
      ctx.stroke();
      // edge lines: kerb side, and the median side of a two-way road
      ctx.strokeStyle = theme.kerb;
      ctx.lineWidth = Math.max(0.2 * k, 1 * px);
      ctx.beginPath();
      for (const L of links) {
        strokePath(ctx, offsetPath(L, L.base + L.lanes * L.lw - 0.25 * k));
        if (!L.oneway) strokePath(ctx, offsetPath(L, L.base + 0.25 * k));
      }
      ctx.stroke();
      // stop lines
      ctx.lineWidth = Math.max(0.5 * k, 2 * px);
      ctx.beginPath();
      for (const L of links) {
        if (!sigEnd(L)) continue;
        const f = frameAt(L, Math.max(0, L.length - 1.5 * k)), nx = f[3], ny = -f[2];
        ctx.moveTo(f[0] + nx * L.base, f[1] + ny * L.base);
        ctx.lineTo(f[0] + nx * (L.base + L.lanes * L.lw), f[1] + ny * (L.base + L.lanes * L.lw));
      }
      ctx.stroke();
    }

    // Green corridor lane, closed roads, reserved or lost lanes.
    drawPlan(level) {
      const { ctx, sim, theme } = this;
      const vip = theme.vip || VIP;
      for (const L of sim.linkList) {
        if (lvl(L) !== level) continue;
        if (L.gc != null) { // green corridor lane: tinted surface, double solid line, AMBULANCE ONLY painted on it
          const px = this.px, edge = L.base + (L.lanes - L.gc - 1) * L.lw, wide = this.scale * L.lw;
          ctx.strokeStyle = GC;
          ctx.globalAlpha = wide < 1.6 ? 0.8 : 0.45;
          ctx.lineWidth = Math.max(L.lw * 0.96, 3 * px);
          ctx.beginPath(); strokePath(ctx, offsetPath(L, laneOffset(L, L.gc))); ctx.stroke();
          ctx.globalAlpha = 1;
          if (wide >= 1.6) {
            ctx.strokeStyle = '#ffffff'; // double solid line: general traffic may not cross into it
            ctx.lineWidth = Math.max(0.15, 0.9 * px);
            const gap = Math.max(0.2, 1.4 * px);
            ctx.beginPath();
            strokePath(ctx, offsetPath(L, edge - gap)); strokePath(ctx, offsetPath(L, edge + gap));
            ctx.stroke();
          }
          if (wide >= 9 && L.length > 40) { // close enough to read the paint
            ctx.fillStyle = '#ffffff';
            ctx.font = `700 ${(L.lw * 0.42).toFixed(2)}px system-ui, sans-serif`;
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            for (let s = Math.min(30, L.length / 2); s < L.length - 15; s += 90) {
              const [x, y] = lanePoint(L, L.gc, s), f = frameAt(L, s);
              ctx.save(); ctx.translate(x, y); ctx.rotate(Math.atan2(f[3], f[2]));
              ctx.fillText('AMBULANCE ONLY', 0, 0);
              ctx.restore();
            }
          }
        }
        if (L.evLane != null) { // median lane cleared for an ambulance now (green corridor on demand): green, dashed
          ctx.strokeStyle = GC; ctx.globalAlpha = 0.5;
          ctx.lineWidth = Math.max(L.lw * 0.9, 3 * this.px);
          ctx.setLineDash([L.lw * 2, L.lw]);
          ctx.beginPath(); strokePath(ctx, offsetPath(L, laneOffset(L, L.evLane))); ctx.stroke();
          ctx.setLineDash([]); ctx.globalAlpha = 1;
        }
        if (L.rule) {
          ctx.strokeStyle = L.rule.use === 'vip' ? vip : theme.amber;
          ctx.globalAlpha = 0.35;
          ctx.lineWidth = L.lw;
          ctx.beginPath(); strokePath(ctx, offsetPath(L, laneOffset(L, L.rule.lane))); ctx.stroke();
          ctx.globalAlpha = 1;
        }
        if (L.closed && L.closed.soft) { // advice only: drivers asked to avoid it, road still open
          if (L.closed.knownAt > sim.t) continue; // not sent yet
          const w = L.lanes * L.lw;
          ctx.strokeStyle = theme.amber; ctx.globalAlpha = 0.3; ctx.lineWidth = w;
          ctx.beginPath(); strokePath(ctx, offsetPath(L, L.base + w / 2)); ctx.stroke();
          ctx.globalAlpha = 1;
        } else if (L.closed) {
          const w = L.lanes * L.lw;
          ctx.strokeStyle = theme.red;
          ctx.globalAlpha = 0.28;
          ctx.lineWidth = w;
          ctx.beginPath(); strokePath(ctx, offsetPath(L, L.base + w / 2)); ctx.stroke();
          ctx.globalAlpha = 1;
          ctx.lineWidth = 3; // barricade across the mouth of the road
          ctx.setLineDash([3, 3]);
          const f = frameAt(L, 3), x = f[0], y = f[1], nx = f[3], ny = -f[2];
          for (const [col, dash] of [['#ffffff', 0], [theme.red, 3]]) {
            ctx.strokeStyle = col; ctx.lineDashOffset = dash;
            ctx.beginPath();
            ctx.moveTo(x + nx * L.base, y + ny * L.base);
            ctx.lineTo(x + nx * (L.base + w), y + ny * (L.base + w));
            ctx.stroke();
          }
          ctx.setLineDash([]); ctx.lineDashOffset = 0;
        }
      }
    }

    drawPlanLabels() {
      const { sim, theme } = this;
      const vip = theme.vip || VIP;
      let gcBest = null;
      const closedBest = new Map(); // one label per closure, on its longest road section
      for (const L of sim.linkList) {
        const f = frameAt(L, L.length / 2), out = L.base + L.lanes * L.lw + 12 * this.px;
        const mx = f[0], my = f[1], nx = f[3], ny = -f[2];
        if (L.closed && !(L.closed.soft && L.closed.knownAt > sim.t)) {
          const b = closedBest.get(L.closed);
          if (!b || L.length > b.length) closedBest.set(L.closed, L);
        }
        if (L.rule) this.pill(L.rule.use === 'vip' ? 'VIP lane' : L.rule.label.toLowerCase(), mx + nx * out, my + ny * out,
          L.rule.use === 'vip' ? '#fff' : '#1a1a19', L.rule.use === 'vip' ? vip : theme.amber, 'center');
        if (L.gc != null && L.kind !== 'entry' && L.kind !== 'exit' && (!gcBest || L.length > gcBest.length)) gcBest = L;
      }
      for (const [c, L] of closedBest) {
        const f = frameAt(L, L.length / 2), rev = sim.links[`${L.to}>${L.from}`], both = rev && rev.closed === c;
        const out = both ? 0 : L.base + L.lanes * L.lw + 12 * this.px;
        this.pill(c.soft ? `AVOID · ${c.label}` : `CLOSED · ${c.label}`, f[0] + f[3] * out, f[1] - f[2] * out, c.soft ? '#1a1a19' : '#fff', c.soft ? theme.amber : theme.red, 'center');
      }
      if (gcBest) {
        const f = frameAt(gcBest, gcBest.length / 2), off = laneOffset(gcBest, gcBest.gc) - 14 * this.px;
        this.pill('GREEN CORRIDOR · ambulance lane', f[0] + f[3] * off, f[1] - f[2] * off, '#fff', GC, 'center');
      }
    }

    drawSignals(level) {
      const { ctx, sim, theme } = this;
      ctx.lineWidth = Math.max(2.4, 2.2 * this.px);
      for (const j of sim.junctions) {
        if (j.level !== level) continue;
        const flash = j.ovr && j.ovr.mode === 'flash', on = Math.floor(performance.now() / 600) % 2 === 0;
        j.approaches.forEach((L, i) => {
          if (flash && !on) return; // flashing amber: the signal is off, drivers give way
          const st = flash ? 'Y' : j.sig.phase === i || (j.partner && j.partner[j.sig.phase] === i) ? j.sig.state : 'R';
          ctx.strokeStyle = st === 'G' ? theme.green : st === 'Y' ? theme.amber : theme.red;
          const f = frameAt(L, L.length - 1), w = L.lanes * L.lw, nx = f[3], ny = -f[2];
          ctx.beginPath();
          ctx.moveTo(f[0] + nx * L.base, f[1] + ny * L.base);
          ctx.lineTo(f[0] + nx * (L.base + w), f[1] + ny * (L.base + w));
          ctx.stroke();
        });
      }
    }

    vehColor(veh, vmax) {
      const th = this.theme;
      if (this.colorBy === 'type') return th.types[veh.type] || th.types.car;
      const r = veh.v / Math.min(veh.v0, vmax || 11);
      return r < 0.15 ? th.red : r < 0.5 ? th.amber : th.green;
    }

    drawVehicles(now, level) {
      const { ctx, sim } = this;
      const buckets = new Map();
      const evs = [];
      // on a zoomed-out real map, keep every vehicle at least a couple of pixels long
      const minLen = 2.6 * this.px, minWid = 1.3 * this.px;
      const push = (color, cx, cy, ux, uy, len, wid) => {
        let b = buckets.get(color);
        if (!b) buckets.set(color, (b = []));
        b.push(cx, cy, ux, uy, Math.max(len, minLen), Math.max(wid, minWid));
      };
      for (const L of sim.linkList) {
        if (lvl(L) !== level) continue;
        for (let li = 0; li < L.lanes; li++) {
          for (const veh of L.lane[li]) {
            let [cx, cy] = lanePoint(L, li, veh.pos - veh.len / 2);
            const f = frameAt(L, veh.pos - veh.len / 2);
            if (veh.isEV) { evs.push([cx, cy, f[2], f[3], veh]); continue; }
            const side = sideOffset(veh) * L.lw; // two-wheelers: half a lane, or on the lane line
            if (side) { cx += f[3] * side; cy -= f[2] * side; }
            push(this.vehColor(veh, L.vmax), cx, cy, f[2], f[3], veh.len, L.lw * TYPE_WIDTH[veh.type]);
          }
        }
      }
      for (const j of sim.isects) {
        if (j.level !== level) continue;
        for (const veh of j.box) {
          const b = veh.box, u = Math.min(1, b.s / b.len);
          const [cx, cy] = bezPoint(b.p0, b.p1, b.p2, u), [tx, ty] = bezTangent(b.p0, b.p1, b.p2, u);
          if (veh.isEV) { evs.push([cx, cy, tx, ty, veh]); continue; }
          push(this.vehColor(veh, 11), cx, cy, tx, ty, veh.len, sim.lw * TYPE_WIDTH[veh.type]);
        }
      }
      for (const [color, a] of buckets) {
        ctx.fillStyle = color;
        ctx.beginPath();
        for (let i = 0; i < a.length; i += 6) rrect(ctx, a[i], a[i + 1], a[i + 2], a[i + 3], a[i + 4], a[i + 5]);
        ctx.fill();
      }
      const flash = Math.floor(now / 250) % 2 === 0;
      const halo = Math.max(11, 9 * this.px), ew = Math.max(sim.lw * 0.8, 2.2 * this.px), el = 5.5 * Math.max(1, ew / (sim.lw * 0.8));
      for (const [cx, cy, , , veh] of evs) this.evAt.push({ veh, x: cx, y: cy });
      for (const [cx, cy, ux, uy, veh] of evs) {
        if (veh.vip) {
          const vip = this.theme.vip || VIP;
          ctx.fillStyle = vip;
          ctx.globalAlpha = 0.3;
          ctx.beginPath(); ctx.arc(cx, cy, halo * 0.9, 0, Math.PI * 2); ctx.fill();
          ctx.globalAlpha = 1;
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 1;
          ctx.beginPath(); rrect(ctx, cx, cy, ux, uy, Math.max(veh.len, el), ew); ctx.fill(); ctx.stroke();
          continue;
        }
        ctx.fillStyle = flash ? 'rgba(220,40,40,0.28)' : 'rgba(40,110,230,0.28)';
        ctx.beginPath(); ctx.arc(cx, cy, halo, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = flash ? '#dc2828' : '#286ee6';
        ctx.lineWidth = Math.max(1.2, 1.2 * this.px);
        ctx.beginPath(); rrect(ctx, cx, cy, ux, uy, Math.max(veh.len, el), ew); ctx.fill(); ctx.stroke();
      }
    }

    // Labels and badges are drawn in screen pixels so they stay readable at any zoom.
    pill(text, x, y, fg, bg, align) {
      const { ctx } = this;
      ctx.save();
      this.screen();
      const X = this.sx(x), Y = this.sy(y);
      ctx.font = '600 10px system-ui, sans-serif';
      const w = ctx.measureText(text).width + 10;
      const x0 = align === 'right' ? X - w : align === 'center' ? X - w / 2 : X;
      ctx.fillStyle = bg;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x0, Y - 8, w, 16, 8); else ctx.rect(x0, Y - 8, w, 16);
      ctx.fill();
      ctx.fillStyle = fg;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, x0 + 5, Y + 0.5);
      ctx.restore();
    }

    drawOverlays(now) {
      const { ctx, sim, theme } = this;
      const pulse = 0.55 + 0.45 * Math.sin(now / 180);
      const px = this.px, pad = sim.net.schematic ? 1 : 0.5;
      for (const L of sim.linkList) {
        if (!L.blockage) continue;
        const bl = L.blockage, lanes = bl.lanes || [bl.lane];
        const f = frameAt(L, bl.pos + 2.5), ux = f[2], uy = f[3];
        ctx.fillStyle = theme.parked;
        ctx.beginPath();
        for (const ln of lanes) { const [qx, qy] = lanePoint(L, ln, bl.pos + 2.5); rrect(ctx, qx, qy, ux, uy, Math.max(5, 2.6 * px), Math.max(L.lw * 0.7, 1.4 * px)); }
        ctx.fill();
        const mid = lanes[lanes.length >> 1];
        const [x, y] = lanePoint(L, mid, bl.pos + 2.5);
        ctx.strokeStyle = theme.red;
        ctx.lineWidth = Math.max(1.4, 1.4 * px);
        ctx.setLineDash([3 * Math.max(1, px), 2 * Math.max(1, px)]);
        ctx.beginPath(); ctx.arc(x, y, Math.max(9 + (lanes.length - 1) * 4, 9 * px), 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
        this.pill(bl.label === 'illegal parking' ? 'illegal parking' : 'crash', x + 12 * px, y - 12 * px, '#fff', theme.red);
      }
      // What a signal did for an ambulance: switched to green for it (SAARTHI), or kept it at red.
      for (const j of sim.junctions) {
        if (j.evSwitch && sim.t - j.evSwitch.t < 12 && sim.evs.some(e => !e.vip)) this.pill('light changed for ambulance', j.x, j.y - 14 * px, '#fff', '#16a34a', 'center');
      }
      for (const a of this.evAt || []) {
        const v = a.veh, L = v.link, j = L && sim.nodes[L.to];
        if (v.vip || v.state !== 'link' || v.v > 0.5 || !j || !j.sig || L.free || L.length - v.pos > 90) continue;
        const green = j.sig.state === 'G' && j.approaches[j.sig.phase] === L;
        this.pill(green ? 'ambulance stuck in queue' : 'ambulance waiting at red', a.x + 10 * px, a.y - 14 * px, '#fff', theme.red);
      }
      for (const j of sim.isects) {
        if (j.id === this.selected) {
          ctx.strokeStyle = theme.accent;
          ctx.lineWidth = Math.max(1.6, 1.6 * px);
          ctx.beginPath(); ctx.arc(j.x, j.y, Math.max(j.r + 13 * pad, 12 * px), 0, Math.PI * 2); ctx.stroke();
        }
        if (j.boxBlocked) {
          ctx.strokeStyle = theme.red;
          ctx.globalAlpha = pulse;
          ctx.lineWidth = Math.max(3, 2.4 * px);
          ctx.beginPath(); ctx.arc(j.x, j.y, Math.max(j.r + 8 * pad, 8 * px), 0, Math.PI * 2); ctx.stroke();
          ctx.globalAlpha = 1;
          if (j.inGridlock || sim.net.schematic || this.view.z > 2.5) this.pill(j.inGridlock ? 'GRIDLOCK' : 'box blocked', j.x, j.y, '#fff', theme.red, 'center');
        }
        if (sim.mode === 'adaptive' && j.faultUntil > sim.t) {
          ctx.strokeStyle = theme.amber;
          ctx.lineWidth = Math.max(2, 2 * px);
          ctx.setLineDash([5 * Math.max(1, px), 4 * Math.max(1, px)]);
          ctx.beginPath(); ctx.arc(j.x, j.y, Math.max(j.r + 18 * pad, 16 * px), 0, Math.PI * 2); ctx.stroke();
          ctx.setLineDash([]);
          this.pill('camera fault · fixed fallback', j.x, j.y + Math.max(j.r + 30 * pad, 26 * px), '#1a1a19', theme.amber, 'center');
        }
      }
      for (const x of sim.externals) {
        const L = x.entry;
        if (!L) continue;
        if (x.metered) {
          const [mx, my] = lanePoint(L, 0, L.length - Math.min(30, L.length / 2));
          const f = frameAt(L, L.length - 30);
          this.pill('METERED', mx + f[3] * 8 * Math.max(1, px), my - f[2] * 8 * Math.max(1, px), '#1a1a19', theme.amber, 'center');
        }
        if (x.backlog.length > 5) {
          const s = Math.min(22, L.length / 3);
          const [bx, by] = lanePoint(L, 0, s);
          const f = frameAt(L, s);
          this.pill(`+${x.backlog.length} queued upstream`, bx + f[3] * 10 * Math.max(1, px), by - f[2] * 10 * Math.max(1, px), '#fff', theme.red, 'center');
        }
      }
    }

    drawLabels() { // schematic loop: hand-placed labels
      const { ctx, sim, theme } = this;
      const [cx, cy] = this.centroid();
      for (const j of sim.junctions) {
        const left = j.x < cx, top = j.y < cy;
        const lx = j.x + (left ? 52 : -52), ly = j.y + (top ? 58 : -58);
        ctx.textAlign = left ? 'left' : 'right';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = theme.label;
        ctx.font = '700 13px system-ui, sans-serif';
        ctx.fillText(`${j.id} · ${j.corner}`, lx, ly - 8);
        ctx.fillStyle = theme.label2;
        ctx.font = '11.5px system-ui, sans-serif';
        ctx.fillText(j.name, lx, ly + 8);
      }
      ctx.font = '600 11.5px system-ui, sans-serif';
      for (const x of sim.externals) {
        const L = x.entry;
        const off = sim.median + L.lanes * L.lw + 9;
        const px = x.x + L.ux * 70 - L.nx * off, py = x.y + L.uy * 70 - L.ny * off;
        const w = ctx.measureText(x.name).width;
        const tx = Math.min(Math.max(px - w / 2, 6), this.W - 6 - w);
        ctx.fillStyle = theme.ground;
        ctx.globalAlpha = 0.85;
        ctx.fillRect(tx - 3, py - 8, w + 6, 16);
        ctx.globalAlpha = 1;
        ctx.fillStyle = theme.label2;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(x.name, tx, py);
      }
    }

    // Real map: road names along the road, junction ids, hospitals and metro stations.
    drawRealLabels() {
      const { ctx, sim, theme } = this;
      const net = sim.net;
      if (!this._roadLabels || this._roadLabelsFor !== sim) {
        const best = new Map();
        for (const L of sim.linkList) {
          if (!L.cls || L.kind === 'slip' || !/^[A-Z]/.test(L.name) || /road [A-Z]\d/.test(L.name)) continue;
          const b = best.get(L.name);
          if (!b || L.length > b.length) best.set(L.name, L);
        }
        this._roadLabels = [...best.values()].filter(L => L.length > 90).sort((a, b) => b.length - a.length);
        this._roadLabelsFor = sim;
      }
      ctx.save();
      this.screen();
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      const placed = [];
      for (const L of this._roadLabels) {
        const f = frameAt(L, L.length / 2);
        const X = this.sx(f[0]), Y = this.sy(f[1]);
        if (X < 0 || Y < 0 || X > this.cw || Y > this.ch) continue;
        if (placed.some(p => Math.hypot(p[0] - X, p[1] - Y) < 70)) continue;
        if (L.length * this.scale < ctx.measureText(L.name).width + 20) continue;
        placed.push([X, Y]);
        let ang = Math.atan2(f[3], f[2]);
        if (ang > Math.PI / 2) ang -= Math.PI; else if (ang < -Math.PI / 2) ang += Math.PI;
        const off = (L.base + L.lanes * L.lw) * this.scale + 8;
        ctx.save();
        ctx.translate(X + f[3] * off * (L.oneway ? 0.5 : 1), Y - f[2] * off * (L.oneway ? 0.5 : 1));
        ctx.rotate(ang);
        ctx.font = '600 11px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.strokeStyle = theme.ground; ctx.lineWidth = 3; ctx.globalAlpha = 0.9;
        ctx.strokeText(L.name, 0, 0);
        ctx.globalAlpha = 1;
        ctx.fillStyle = theme.label2;
        ctx.fillText(L.name, 0, 0);
        ctx.restore();
      }
      ctx.font = '700 10.5px system-ui, sans-serif';
      ctx.textAlign = 'left';
      for (const j of sim.junctions) {
        const X = this.sx(j.x), Y = this.sy(j.y);
        ctx.strokeStyle = theme.ground; ctx.lineWidth = 3;
        ctx.strokeText(j.id, X + 7, Y - 9);
        ctx.fillStyle = theme.label;
        ctx.fillText(j.id, X + 7, Y - 9);
      }
      for (const p of net.labels || []) {
        if (p.offmap) continue;
        const X = this.sx(p.x), Y = this.sy(p.y);
        if (X < -40 || Y < -20 || X > this.cw + 40 || Y > this.ch + 20) continue;
        const hosp = p.kind === 'hospital';
        ctx.fillStyle = hosp ? '#dc2626' : '#2563eb';
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(X - 7, Y - 7, 14, 14, 3); else ctx.rect(X - 7, Y - 7, 14, 14);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.font = '700 11px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(hosp ? '+' : 'M', X, Y + 0.5);
        ctx.textAlign = 'left';
        ctx.font = '600 11px system-ui, sans-serif';
        const t = p.text.length > 34 ? p.text.slice(0, 32) + '…' : p.text;
        ctx.strokeStyle = theme.ground; ctx.lineWidth = 3;
        ctx.strokeText(t, X + 10, Y);
        ctx.fillStyle = theme.label;
        ctx.fillText(t, X + 10, Y);
      }
      ctx.font = '10px system-ui, sans-serif';
      ctx.fillStyle = theme.label2;
      ctx.textAlign = 'right';
      const credit = window.SAARTHI_BASEMAP ? window.SAARTHI_BASEMAP.credit() : '';
      ctx.fillText(`Roads © OpenStreetMap contributors${credit ? ` · ${credit}` : ''} · ${this.view.z > 1 ? `${this.view.z.toFixed(1)}× · ` : ''}scroll + Ctrl to zoom, drag to pan`, this.cw - 8, this.ch - 8);
      ctx.restore();
    }
  }

  window.Renderer = Renderer;
})();
