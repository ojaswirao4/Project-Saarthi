/* Real map underneath a real area: web-map tiles (street map or satellite) placed in the twin's metre
 * coordinates, so everything the twin doesn't simulate (buildings, apartments, parks, sector and residential
 * roads) is still on screen. The simulated main roads are drawn on top.
 *
 * World coordinates follow tools/osm-import.js: x = (lon − lon0)·kx + w/2, y = −(lat − lat0)·ky + h/2.
 * Each tile's corners are placed with that projection, so Web Mercator tiles line up to well under a metre
 * over an area a few km across. */
(function () {
  'use strict';
  const KY = 110540;
  // OpenStreetMap's tile servers refuse requests that carry no web address (a page opened as a local file),
  // so off a web server the street map falls back to Esri's, which has local roads and sector names but no
  // buildings in Noida. `node tools/serve.js` serves the site at http://localhost:8765.
  const SERVED = /^https?:$/.test(location.protocol);
  const SOURCES = {
    streets: SERVED ? {
      label: 'Streets',
      url: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
      maxZ: 19, credit: 'Map © OpenStreetMap contributors', dim: 0, invertDark: true,
    } : {
      label: 'Streets',
      url: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/${z}/${y}/${x}`,
      maxZ: 19, credit: 'Map © Esri, HERE, Garmin, OpenStreetMap contributors', dim: 0, invertDark: true,
    },
    satellite: {
      label: 'Satellite',
      url: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
      maxZ: 19, credit: 'Imagery © Esri, Maxar, Earthstar Geographics', dim: 0.35,
    },
  };
  const DARK_FILTER = 'invert(1) hue-rotate(180deg) brightness(0.85) contrast(0.9)'; // a light street map, recoloured for the dark theme
  const MODES = ['streets', 'satellite', 'off'];
  // Satellite by default off a web server: it is the view that shows every building there
  let mode = SERVED ? 'streets' : 'satellite';
  try { const m = localStorage.getItem('saarthi-basemap'); if (MODES.includes(m)) mode = m; } catch (e) { /* storage blocked */ }

  const cache = new Map(); // url → Image (loading or loaded)
  const listeners = new Set();
  function tile(url) {
    let img = cache.get(url);
    if (!img) {
      img = new Image();
      img.onload = () => listeners.forEach(fn => fn());
      img.src = url;
      cache.set(url, img);
    }
    return img;
  }
  const ready = img => img && img.complete && img.naturalWidth > 0;

  // Web Mercator tile maths
  const lon2t = (lon, z) => (lon + 180) / 360 * 2 ** z;
  const lat2t = (lat, z) => { const r = lat * Math.PI / 180; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z; };
  const t2lon = (t, z) => t / 2 ** z * 360 - 180;
  const t2lat = (t, z) => { const n = Math.PI - 2 * Math.PI * t / 2 ** z; return 180 / Math.PI * Math.atan(Math.sinh(n)); };

  function proj(net) {
    const [lat0, lon0] = net.center, kx = Math.cos(lat0 * Math.PI / 180) * 111320, { w, h } = net.size;
    return {
      lat0, lon0,
      toXY: (lat, lon) => [(lon - lon0) * kx + w / 2, -(lat - lat0) * KY + h / 2],
      toLL: (x, y) => [lat0 - (y - h / 2) / KY, lon0 + (x - w / 2) / kx],
    };
  }

  function isDark(ground) { // theme ground colour, '#rrggbb' or 'rgb(r, g, b)'
    const m = String(ground || '').match(/#([0-9a-f]{6})/i), n = String(ground || '').match(/(\d+)\D+(\d+)\D+(\d+)/);
    const [r, g, b] = m ? [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16)) : n ? n.slice(1, 4).map(Number) : [0, 0, 0];
    return 0.299 * r + 0.587 * g + 0.114 * b < 128;
  }

  // Tiles covering world box [x0, y0]–[x1, y1] at a zoom where a tile pixel is about `mpp` metres.
  function tilesFor(net, x0, y0, x1, y1, mpp, src) {
    const P = proj(net);
    let z = Math.round(Math.log2(156543.03 * Math.cos(P.lat0 * Math.PI / 180) / Math.max(mpp, 0.05)));
    z = Math.max(12, Math.min(src.maxZ, z));
    const [latA, lonA] = P.toLL(x0, y0), [latB, lonB] = P.toLL(x1, y1);
    let tx0, tx1, ty0, ty1;
    for (;;) { // never more than ~120 tiles on screen
      tx0 = Math.floor(lon2t(Math.min(lonA, lonB), z)); tx1 = Math.floor(lon2t(Math.max(lonA, lonB), z));
      ty0 = Math.floor(lat2t(Math.max(latA, latB), z)); ty1 = Math.floor(lat2t(Math.min(latA, latB), z));
      if ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) <= 120 || z <= 12) break;
      z--;
    }
    const out = [];
    for (let tx = tx0; tx <= tx1; tx++) for (let ty = ty0; ty <= ty1; ty++) {
      const [ax, ay] = P.toXY(t2lat(ty, z), t2lon(tx, z)), [bx, by] = P.toXY(t2lat(ty + 1, z), t2lon(tx + 1, z));
      out.push({ z, tx, ty, x: ax, y: ay, w: bx - ax, h: by - ay });
    }
    return out;
  }

  const BM = {
    MODES, SOURCES,
    get mode() { return mode; },
    set mode(m) {
      if (!MODES.includes(m)) return;
      mode = m;
      try { localStorage.setItem('saarthi-basemap', m); } catch (e) { /* storage blocked */ }
      listeners.forEach(fn => fn());
      document.dispatchEvent(new CustomEvent('basemapchange'));
    },
    onLoad(fn) { listeners.add(fn); },
    credit() { return mode === 'off' ? '' : SOURCES[mode].credit; },

    // Draw under a Renderer's world transform (already set). `view` is the visible world box.
    drawCanvas(ctx, net, view, mpp, ground) {
      if (mode === 'off' || net.schematic || !net.center) return;
      const src = SOURCES[mode];
      ctx.save();
      if (src.invertDark && isDark(ground)) ctx.filter = DARK_FILTER;
      for (const t of tilesFor(net, view.x0, view.y0, view.x1, view.y1, mpp, src)) {
        const img = tile(src.url(t.z, t.tx, t.ty));
        if (!ready(img)) { // show the parent tile, cropped, while this one loads
          const p = { z: t.z - 1, tx: t.tx >> 1, ty: t.ty >> 1 }, pimg = cache.get(src.url(p.z, p.tx, p.ty));
          if (ready(pimg)) {
            const s = pimg.naturalWidth / 2, sx = (t.tx & 1) * s, sy = (t.ty & 1) * s;
            ctx.drawImage(pimg, sx, sy, s, s, t.x, t.y, t.w, t.h);
          }
          continue;
        }
        ctx.drawImage(img, t.x, t.y, t.w + 0.5 * mpp, t.h + 0.5 * mpp); // a hair of overlap hides seams
      }
      ctx.restore();
      if (src.dim) { // satellite: darken a little so the simulated roads and vehicles stand out
        ctx.save();
        ctx.globalAlpha = src.dim;
        ctx.fillStyle = ground || '#000';
        ctx.fillRect(view.x0, view.y0, view.x1 - view.x0, view.y1 - view.y0);
        ctx.restore();
      }
    },

    // SVG <image> tiles for a whole area (the Plan ahead map), behind everything else in `parent`.
    drawSvg(parent, net, pxWidth, ground) {
      if (mode === 'off' || net.schematic || !net.center) return;
      const src = SOURCES[mode], NS = 'http://www.w3.org/2000/svg';
      const mpp = net.size.w / Math.max(200, pxWidth) / 2; // sharp enough at 2× pixel density
      if (src.invertDark && isDark(ground)) parent.style.filter = DARK_FILTER;
      for (const t of tilesFor(net, 0, 0, net.size.w, net.size.h, mpp, src)) {
        const im = document.createElementNS(NS, 'image');
        im.setAttribute('href', src.url(t.z, t.tx, t.ty));
        for (const [k, v] of [['x', t.x], ['y', t.y], ['width', t.w + 1], ['height', t.h + 1]]) im.setAttribute(k, v.toFixed(1));
        im.setAttribute('preserveAspectRatio', 'none');
        parent.appendChild(im);
      }
      if (src.dim) {
        const r = document.createElementNS(NS, 'rect');
        for (const [k, v] of [['x', 0], ['y', 0], ['width', net.size.w], ['height', net.size.h]]) r.setAttribute(k, v);
        r.setAttribute('fill', ground || '#000'); r.setAttribute('opacity', src.dim);
        parent.appendChild(r);
      }
    },
  };
  window.SAARTHI_BASEMAP = BM;
})();
