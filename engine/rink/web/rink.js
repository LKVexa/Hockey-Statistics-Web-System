/**
 * RINK-VT rink canvas: a 200 × 85 ft rink (centre ice at 0,0; the home team attacks the right-hand net),
 * shot markers (area ∝ xG, goals filled), an optional kernel-density heat layer computed on the server's XPU, and
 * click-to-locate: a click reports rink feet so the command bar can append /x,y.
 */
(function (root) {
  'use strict';
  const W = 200, H = 85;
  function create(canvas, { onPick } = {}) {
    const ctx = canvas.getContext('2d');
    const st = { shots: [], home: null, heat: null, heatOn: true, hover: null };
    const css = (v, d) => (getComputedStyle(canvas).getPropertyValue(v) || '').trim() || d;
    function size() {
      const dpr = root.devicePixelRatio || 1; const w = canvas.clientWidth || 400; const h = Math.round(w * H / W);
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); canvas.style.height = h + 'px'; }
      return { dpr, w, h, s: (w / W) };
    }
    const toPx = (g, x, y) => [(x + 100) * g.s, (42.5 - y) * g.s];
    function rinkPath(g) {
      const r = 28 * g.s, w = g.w, h = g.h; const p = new Path2D();
      p.moveTo(r, 0); p.lineTo(w - r, 0); p.arcTo(w, 0, w, r, r); p.lineTo(w, h - r); p.arcTo(w, h, w - r, h, r); p.lineTo(r, h); p.arcTo(0, h, 0, h - r, r); p.lineTo(0, r); p.arcTo(0, 0, r, 0, r); p.closePath();
      return p;
    }
    function draw() {
      const g = size(); ctx.setTransform(g.dpr, 0, 0, g.dpr, 0, 0); ctx.clearRect(0, 0, g.w, g.h);
      const boards = rinkPath(g);
      ctx.fillStyle = css('--rink-ice', '#0f1419'); ctx.fill(boards);
      ctx.save(); ctx.clip(boards);
      // heat layer (server KDE: lanes = home attempts, away attempts on a 120 × 51 lattice)
      if (st.heatOn && st.heat) {
        const { cols, rows, lanes } = st.heat; const img = ctx.createImageData(cols, rows);
        const dec = lanes.map((l) => Uint8Array.from(atob(l.b64), (c) => c.charCodeAt(0)));
        for (let i = 0; i < cols * rows; i++) {
          const a = dec[0] ? dec[0][i] : 0, b = dec[1] ? dec[1][i] : 0;
          img.data[i * 4] = Math.round(47 * a / 255 + 228 * b / 255); img.data[i * 4 + 1] = Math.round(208 * a / 255 + 194 * b / 255); img.data[i * 4 + 2] = Math.round(228 * a / 255 + 106 * b / 255);
          img.data[i * 4 + 3] = Math.min(200, Math.round(Math.max(a, b) * 0.78));
        }
        const off = document.createElement('canvas'); off.width = cols; off.height = rows; off.getContext('2d').putImageData(img, 0, 0);
        ctx.imageSmoothingEnabled = true; ctx.drawImage(off, 0, 0, g.w, g.h);
      }
      const line = (x, col, wd) => { const [px] = toPx(g, x, 0); ctx.strokeStyle = col; ctx.lineWidth = wd; ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, g.h); ctx.stroke(); };
      line(0, 'rgba(239,107,115,.55)', 2.2 * g.s); line(-25, 'rgba(47,128,228,.55)', 1.6 * g.s); line(25, 'rgba(47,128,228,.55)', 1.6 * g.s);
      line(-89, 'rgba(239,107,115,.45)', 0.6 * g.s); line(89, 'rgba(239,107,115,.45)', 0.6 * g.s);
      const circle = (x, y, r, col) => { const [px, py] = toPx(g, x, y); ctx.strokeStyle = col; ctx.lineWidth = 0.5 * g.s; ctx.beginPath(); ctx.arc(px, py, r * g.s, 0, Math.PI * 2); ctx.stroke(); };
      circle(0, 0, 15, 'rgba(47,128,228,.45)');
      for (const [x, y] of [[69, 22], [69, -22], [-69, 22], [-69, -22]]) circle(x, y, 15, 'rgba(239,107,115,.35)');
      for (const sx of [-1, 1]) { const [px, py] = toPx(g, sx * 89, 4); ctx.fillStyle = 'rgba(47,128,228,.18)'; ctx.beginPath(); ctx.arc(px, py + 4 * g.s, 6 * g.s, sx > 0 ? Math.PI / 2 : -Math.PI / 2, sx > 0 ? Math.PI * 1.5 : Math.PI / 2); ctx.fill(); const [nx, ny] = toPx(g, sx * 89, 3); ctx.fillStyle = 'rgba(239,107,115,.6)'; ctx.fillRect(sx > 0 ? nx : nx - 3.3 * g.s, ny, 3.3 * g.s, 6 * g.s); }
      // shots (normalised attacking-right coordinates: home as is, away mirrored)
      for (const e of st.shots) {
        if (e.x === null || e.x === undefined || e.coordSource === 'prior') continue;
        const away = e.team !== st.home; const [px, py] = toPx(g, away ? -e.x : e.x, away ? -e.y : e.y);
        const r = Math.max(1.6, Math.sqrt(Math.max(0.004, e.xgF || e.xg || 0.02)) * 9) * g.s * 0.55;
        ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2);
        const col = away ? css('--warn', '#e4c26a') : css('--cyan', '#2fd0e4');
        if (e.stat === 'G') { ctx.fillStyle = col; ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.stroke(); }
        else { ctx.strokeStyle = col; ctx.lineWidth = e.stat === 'M' ? 0.8 : 1.3; ctx.globalAlpha = e.stat === 'M' ? 0.55 : 0.95; ctx.stroke(); ctx.globalAlpha = 1; }
      }
      if (st.hover) { const [px, py] = toPx(g, st.hover.x, st.hover.y); ctx.strokeStyle = 'rgba(233,239,244,.7)'; ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(px - 8, py); ctx.lineTo(px + 8, py); ctx.moveTo(px, py - 8); ctx.lineTo(px, py + 8); ctx.stroke(); ctx.setLineDash([]); }
      ctx.restore();
      ctx.strokeStyle = css('--graphite-4', '#343d48'); ctx.lineWidth = 1.5; ctx.stroke(boards);
    }
    const feet = (ev) => { const b = canvas.getBoundingClientRect(); const x = ((ev.clientX - b.left) / b.width) * W - 100; const y = 42.5 - ((ev.clientY - b.top) / b.height) * H; return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 }; };
    canvas.addEventListener('mousemove', (ev) => { st.hover = feet(ev); canvas.title = `${st.hover.x}, ${st.hover.y} ft — click to add /x,y to the command`; draw(); });
    canvas.addEventListener('mouseleave', () => { st.hover = null; draw(); });
    canvas.addEventListener('click', (ev) => { if (onPick) onPick(feet(ev)); });
    if (root.ResizeObserver) new ResizeObserver(() => draw()).observe(canvas);
    return { set(o) { Object.assign(st, o); draw(); }, draw, state: st };
  }
  root.RinkMap = { create };
})(typeof self !== 'undefined' ? self : this);
