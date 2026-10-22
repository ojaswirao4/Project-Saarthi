/* Minimal time-series line chart: one y-axis, 2px lines, end labels, crosshair tooltip. */
(function () {
  'use strict';

  function niceMax(v) {
    if (!(v > 0)) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v))), n = v / p;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
  }

  class LineChart {
    constructor(canvas, opts) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.tip = canvas.parentElement.querySelector('.tip');
      this.fmt = opts.fmt || (v => String(v));
      this.xfmt = opts.xfmt || (t => String(t));
      this.ref = opts.ref || null; // { v, label }: dashed reference line
      this.band = null;            // { from, to, label }: shaded time window
      this.series = [];
      this.theme = null;
      this.hoverX = null;
      canvas.addEventListener('pointermove', e => { this.hoverX = e.offsetX; this.draw(); });
      canvas.addEventListener('pointerleave', () => { this.hoverX = null; this.draw(); });
    }

    setData(series) { this.series = series; this.draw(); }

    draw() {
      const { canvas, ctx, theme } = this;
      if (!theme) return;
      const r = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
      if (!r.width) return;
      if (canvas.width !== Math.round(r.width * dpr)) { canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr); }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, r.width, r.height);
      const pad = { l: 40, r: 96, t: 8, b: 22 };
      const w = r.width - pad.l - pad.r, h = r.height - pad.t - pad.b;
      const all = this.series.flatMap(s => s.points.filter(p => p.v != null));
      if (all.length < 2) {
        ctx.fillStyle = theme.muted;
        ctx.font = '12px system-ui, sans-serif';
        ctx.fillText('Collecting data…', pad.l, pad.t + 20);
        if (this.tip) this.tip.hidden = true;
        return;
      }
      const t0 = Math.min(...all.map(p => p.t)), t1 = Math.max(...all.map(p => p.t));
      const ymax = niceMax(Math.max(...all.map(p => p.v), this.ref ? this.ref.v : 0) * 1.08);
      const X = t => pad.l + (t1 > t0 ? (t - t0) / (t1 - t0) : 0) * w;
      const Y = v => pad.t + h - v / ymax * h;

      ctx.font = '11px system-ui, sans-serif';
      if (this.band) {
        const x0 = X(Math.max(t0, this.band.from)), x1 = X(Math.min(t1, this.band.to));
        ctx.fillStyle = theme.grid;
        ctx.globalAlpha = 0.6;
        ctx.fillRect(x0, pad.t, Math.max(0, x1 - x0), h);
        ctx.globalAlpha = 1;
        ctx.fillStyle = theme.muted;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(this.band.label, x0 + 4, pad.t + 3);
      }
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'right';
      ctx.lineWidth = 1;
      for (let i = 0; i <= 4; i++) {
        const v = ymax * i / 4, y = Math.round(Y(v)) + 0.5;
        ctx.strokeStyle = i === 0 ? theme.axis : theme.grid;
        ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + w, y); ctx.stroke();
        ctx.fillStyle = theme.muted;
        ctx.fillText(this.fmt(v, true), pad.l - 6, y);
      }
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const ticks = Math.max(2, Math.min(5, Math.floor(w / 90)));
      for (let i = 0; i <= ticks; i++) {
        const t = t0 + (t1 - t0) * i / ticks;
        ctx.fillText(this.xfmt(t), X(t), pad.t + h + 6);
      }

      if (this.ref) {
        const y = Math.round(Y(this.ref.v)) + 0.5;
        ctx.strokeStyle = theme.muted;
        ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + w, y); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = theme.muted;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        ctx.fillText(this.ref.label, pad.l + 4, y - 3);
      }
      for (const s of this.series) {
        ctx.strokeStyle = s.color;
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';
        ctx.setLineDash(s.dash ? [5, 4] : []);
        ctx.beginPath();
        let started = false;
        for (const p of s.points) {
          if (p.v == null) { started = false; continue; }
          if (started) ctx.lineTo(X(p.t), Y(p.v)); else { ctx.moveTo(X(p.t), Y(p.v)); started = true; }
        }
        ctx.stroke();
        ctx.setLineDash([]);
      }
      // direct end labels (text in ink, mark carries the colour); nudge apart if they collide
      const ends = this.series.map(s => {
        const p = [...s.points].reverse().find(q => q.v != null);
        return p ? { s, p, y: Y(p.v) } : null;
      }).filter(Boolean).sort((a, b) => a.y - b.y);
      for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 14) ends[i].y = ends[i - 1].y + 14;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      for (const e of ends) {
        ctx.fillStyle = e.s.color;
        ctx.beginPath(); ctx.arc(X(e.p.t), Y(e.p.v), 3, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = theme.ink2;
        ctx.fillText(`${e.s.name} ${this.fmt(e.p.v)}`, pad.l + w + 8, e.y);
      }

      if (this.hoverX == null || !this.tip) { if (this.tip) this.tip.hidden = true; return; }
      const tq = t0 + Math.min(1, Math.max(0, (this.hoverX - pad.l) / w)) * (t1 - t0);
      const rows = this.series.map(s => {
        let best = null;
        for (const p of s.points) if (p.v != null && (!best || Math.abs(p.t - tq) < Math.abs(best.t - tq))) best = p;
        return { s, p: best };
      }).filter(r2 => r2.p);
      if (!rows.length) { this.tip.hidden = true; return; }
      const tx = X(rows[0].p.t);
      ctx.strokeStyle = theme.axis;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(Math.round(tx) + 0.5, pad.t); ctx.lineTo(Math.round(tx) + 0.5, pad.t + h); ctx.stroke();
      for (const { s, p } of rows) {
        ctx.fillStyle = theme.surface;
        ctx.beginPath(); ctx.arc(X(p.t), Y(p.v), 5, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = s.color;
        ctx.beginPath(); ctx.arc(X(p.t), Y(p.v), 3.5, 0, Math.PI * 2); ctx.fill();
      }
      this.tip.innerHTML = `<b>${this.xfmt(rows[0].p.t)}</b>` + rows.map(({ s, p }) =>
        `<div><span class="swatch" style="background:${s.color}"></span>${s.name}: ${this.fmt(p.v)}</div>`).join('');
      this.tip.hidden = false;
      const tw = this.tip.offsetWidth;
      this.tip.style.left = `${Math.min(Math.max(0, tx + 12), r.width - tw)}px`;
      this.tip.style.top = `${pad.t}px`;
    }
  }

  window.LineChart = LineChart;
})();
