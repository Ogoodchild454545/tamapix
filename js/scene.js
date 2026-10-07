/* TAMA-PIX — full-screen GBA-style scene renderer + dark RPG UI primitives.
 *
 * The viewport is one low-res canvas scaled up by an integer factor (crisp pixels). Gameplay happens on a
 * 96x48 "stage" (STAGE_W x STAGE_H) standing on a dirt path in a meadow; negative y reaches into the sky.
 * Environments: 'day' | 'dusk' (asleep, lights on) | 'night' (lights off) | 'battle' | 'mine' (Pix Town Jobs).
 * Drawing helpers take STAGE coordinates.
 */
(function (T) {
  'use strict';
  const C = T.CONFIG, M = T.Monsters;
  const UI = {
    panel: '#161c28', edge: '#0a0d13', border: '#7a8aa3', inner: '#2b3549',
    text: '#e6ebf2', dim: '#8e9bb0', accent: '#e0ad48', red: '#d4524a', green: '#5cb86a', yellow: '#dcc043', blue: '#6f9fd8'
  };
  T.UI = UI;
  T.INK = UI.text;

  // ------------------------------------------------------------ colour helpers
  const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const rgb = (c) => 'rgb(' + c.map(v => Math.max(0, Math.min(255, v | 0))).join(',') + ')';
  const TINT = {
    day: (c) => c,
    battle: (c) => [c[0] * 1.02, c[1] * 1.02, c[2] * 1.0],
    dusk: (c) => [c[0] * 0.72 + 22, c[1] * 0.58 + 12, c[2] * 0.62 + 30],
    night: (c) => [c[0] * 0.22 + 4, c[1] * 0.3 + 8, c[2] * 0.46 + 24],
    mine: (c) => [c[0] * 0.96 + 5, c[1] * 0.92 + 2, c[2] * 0.86]
  };
  const tint = (h, env) => rgb((TINT[env] || TINT.day)(hex(h)));
  const hash = (n) => { n = (n ^ 61) ^ (n >>> 16); n = (n + (n << 3)) | 0; n ^= n >>> 4; n = Math.imul(n, 0x27d4eb2d); n ^= n >>> 15; return (n >>> 0) / 4294967295; };
  const h2 = (x, y) => hash((x * 73856093) ^ (y * 19349663));
  const vnoise = (x, y, s) => {            // smooth value noise
    const X = Math.floor(x / s), Y = Math.floor(y / s), fx = x / s - X, fy = y / s - Y;
    const a = h2(X, Y), b = h2(X + 1, Y), c = h2(X, Y + 1), d = h2(X + 1, Y + 1);
    const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };

  const SKY = {
    day:    ['#6f8fae', '#7b99b6', '#89a4bf', '#98b0c7', '#a9bdcf'],
    battle: ['#6f8fae', '#7b99b6', '#89a4bf', '#98b0c7', '#a9bdcf'],
    dusk:   ['#262a45', '#363655', '#4d4461', '#6c5667', '#8a6a6a'],
    night:  ['#070b17', '#0a0f1e', '#0d1325', '#10182c', '#131d33'],
    mine:   ['#7d93ab', '#8a9db3', '#98a8bb', '#a8b5c4', '#b8c2cd']
  };
  const G = { g0: '#1c3019', g1: '#253f21', g2: '#30502a', g3: '#3d6133', g4: '#4f7541',
              t0: '#15241a', t1: '#1f3524', t2: '#2b472d', t3: '#3b5d38', t4: '#50764a',
              d0: '#3a2c1f', d1: '#4f3d2a', d2: '#654f37', d3: '#7b6447', mt: '#61778f', mt2: '#51677a' };

  function Scene(canvas) {
    this.c = canvas; this.ctx = canvas.getContext('2d');
    this.W = C.STAGE_W; this.H = C.STAGE_H;
    this.scale = 4; this.sw = 96; this.sh = 200; this.sx0 = 0; this.sy0 = 90; this.horizon = 100; this.top = 0; this.bot = 0;
    this.bgCache = null; this.frame = 0;
    // UI text is drawn on a full-resolution overlay canvas with a system font (crisp at any DPR).
    this.tc = document.createElement('canvas'); this.tc.id = 'sceneText'; this.tc.setAttribute('aria-hidden', 'true');
    this.tc.style.cssText = 'position:fixed;left:0;top:0;pointer-events:none;';
    if (canvas.parentNode) canvas.parentNode.insertBefore(this.tc, canvas.nextSibling);
    this.tctx = this.tc.getContext('2d'); this.tq = []; this.dpr = 1;
  }
  // ---- UI font: sizes are in stage pixels so layout scales with the scene
  const FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
  const FS = 4.4;                                   // font size (stage px); ~17-18 CSS px on a phone
  const isCaps = (s) => /[A-Z]/.test(s) && s === s.toUpperCase();
  const fontFor = (s, px) => (isCaps(s) ? '700 ' : '500 ') + px + 'px ' + FONT_FAMILY;
  const mctx = document.createElement('canvas').getContext('2d');
  const wCache = new Map();
  function measure(s) {
    s = String(s);
    let w = wCache.get(s);
    if (w == null) {
      if (wCache.size > 3000) wCache.clear();
      mctx.font = fontFor(s, 100); w = mctx.measureText(s).width / 100 * FS;
      wCache.set(s, w);
    }
    return w;
  }
  T.textWidth = measure;
  const P = Scene.prototype;

  P.resize = function (vw, vh, topPx, botPx) {
    const s = Math.max(2, Math.min(10, Math.floor(Math.min(vw / C.STAGE_W, vh / 150))));
    this.scale = s;
    this.sw = Math.max(C.STAGE_W, Math.ceil(vw / s));
    this.sh = Math.ceil(vh / s);
    this.top = Math.ceil(topPx / s); this.bot = Math.ceil(botPx / s);
    const visible = this.sh - this.top - this.bot;
    this.sx0 = Math.floor((this.sw - this.W) / 2);
    this.sy0 = this.top + Math.max(0, Math.round((visible - this.H) * 0.6));
    this.horizon = this.sy0 - 12;
    this.c.width = this.sw; this.c.height = this.sh;
    const cw = this.sw * s, ch = this.sh * s;
    Object.assign(this.c.style, { width: cw + 'px', height: ch + 'px', left: Math.floor((vw - cw) / 2) + 'px', top: '0px' });
    this.dpr = Math.min(3, window.devicePixelRatio || 1);
    this.tc.width = Math.round(cw * this.dpr); this.tc.height = Math.round(ch * this.dpr);
    Object.assign(this.tc.style, { width: cw + 'px', height: ch + 'px', left: this.c.style.left, top: '0px' });
    this.bgCache = null;
    this.ctx.imageSmoothingEnabled = false;
  };
  P.toStage = function (cx, cy) { const r = this.c.getBoundingClientRect(); return { x: (cx - r.left) / this.scale - this.sx0, y: (cy - r.top) / this.scale - this.sy0 }; };
  P.toClient = function (sx, sy) { const r = this.c.getBoundingClientRect(); return { x: r.left + (sx + this.sx0) * this.scale, y: r.top + (sy + this.sy0) * this.scale }; };
  /** Visible stage-space rectangle between the HUD bars. */
  P.bounds = function () { return { left: -this.sx0, right: this.sw - this.sx0, top: this.top - this.sy0, bottom: this.sh - this.bot - this.sy0 }; };
  P.horizonFor = function (env) {
    if (env === 'battle') { const b = this.bounds(); return this.sy0 + b.top + Math.round((b.bottom - b.top) * 0.3); }
    return this.horizon;
  };

  // ------------------------------------------------------------ background
  P.begin = function (t, env) {
    this.env = env; this.t = t; this.frame = Math.floor(t / 650) % 2;
    this.tq = [];
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1;
    const key = env + this.sw + 'x' + this.sh + ':' + this.sy0 + ':' + this.top + ':' + this.bot;
    if (!this.bgCache || this.bgCache.key !== key) this.bgCache = { key, img: this.paintStatic(env) };
    ctx.drawImage(this.bgCache.img, 0, 0);
    this.paintAnimated(t, env);
    ctx.setTransform(1, 0, 0, 1, this.sx0, this.sy0);
  };

  P.paintStatic = function (env) {
    const cv = document.createElement('canvas'); cv.width = this.sw; cv.height = this.sh;
    const g = cv.getContext('2d'), W = this.sw, Hh = this.sh, hz = this.horizonFor(env);
    const dot = (x, y, c) => { g.fillStyle = c; g.fillRect(x, y, 1, 1); };
    // --- ground & scenery in daylight colours (tinted per environment afterwards)
    // far mountains
    for (let x = 0; x < W; x++) {
      const h = Math.round(10 + 7 * vnoise(x, 3, 22) + 3 * vnoise(x, 9, 7));
      g.fillStyle = G.mt; g.fillRect(x, hz - 8 - h, 1, h + 8);
      const h2v = Math.round(5 + 5 * vnoise(x + 300, 1, 14));
      g.fillStyle = G.mt2; g.fillRect(x, hz - 6 - h2v, 1, h2v + 6);
    }
    // treeline (round crowns + a few conifers)
    for (let i = -2, x = -4; x < W + 6; i++) {
      const r = 3 + Math.floor(hash(i * 13 + 7) * 4), cy = hz - r - 1 - Math.floor(hash(i * 5 + 3) * 3);
      if (hash(i * 31 + 1) < 0.22) {            // conifer
        const hgt = 10 + Math.floor(hash(i + 77) * 6);
        for (let y = 0; y < hgt; y++) {
          const w = Math.floor((y / hgt) * 4.5) + ((y % 3) === 2 ? 1 : 0);
          for (let dx = -w; dx <= w; dx++) {
            const c = dx < -w / 3 ? G.t3 : dx > w / 3 ? G.t0 : G.t1;
            dot(x + dx, hz - hgt - 1 + y, h2(x + dx, y) > 0.85 ? G.t2 : c);
          }
        }
        x += 5;
      } else {
        for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
          const d = (dx * dx + dy * dy) / (r * r);
          if (d > 1 || (d > 0.75 && h2(x + dx, cy + dy) > 0.6)) continue;
          const l = -(dx + dy * 1.3) / (r * 1.8) + (h2(x + dx, cy + dy) - 0.5) * 0.5;
          dot(x + dx, cy + dy, l > 0.55 ? G.t4 : l > 0.15 ? G.t3 : l > -0.35 ? G.t2 : G.t1);
        }
        g.fillStyle = G.t1; g.fillRect(x - r + 1, cy + 1, r * 2 - 1, hz - cy - 1);
        x += r + 1 + Math.floor(hash(i * 3 + 9) * 3);
      }
    }
    g.fillStyle = G.t0; g.fillRect(0, hz - 1, W, 1);
    // grass field: mottled base + blade texture
    for (let y = hz; y < Hh; y++) {
      const depth = (y - hz) / Math.max(1, Hh - hz);
      for (let x = 0; x < W; x++) {
        const m = vnoise(x, y * 1.6, 9) * 0.7 + vnoise(x, y, 3) * 0.3, n = h2(x, y);
        let c = m > 0.62 ? G.g3 : m > 0.36 ? G.g2 : G.g1;
        if (n < 0.08) c = G.g1; else if (n > 0.93) c = G.g4;
        if (depth < 0.08 && n > 0.5) c = G.g2;
        dot(x, y, c);
      }
    }
    const blades = Math.floor(W * (Hh - hz) / 9);
    for (let i = 0; i < blades; i++) {
      const x = Math.floor(hash(i * 7 + 1) * W), y = hz + 2 + Math.floor(hash(i * 7 + 2) * (Hh - hz));
      const tall = 1 + Math.floor(((y - hz) / (Hh - hz)) * 2.5);
      for (let k = 0; k < tall; k++) dot(x, y - k, G.g0);
      dot(x + (hash(i) > 0.5 ? 1 : -1), y - tall, G.g4);
    }
    if (env !== 'battle') {
      // dirt path across the meadow under the pet's lane
      const py0 = this.sy0 + this.H - 8, py1 = this.sy0 + this.H + 5;
      for (let y = py0 - 2; y < py1 + 2; y++) for (let x = 0; x < W; x++) {
        const edgeT = py0 + Math.round(vnoise(x, 1, 6) * 3) - 1, edgeB = py1 - Math.round(vnoise(x, 7, 6) * 3) + 1;
        if (y < edgeT || y > edgeB) continue;
        const n = h2(x, y), m = vnoise(x, y, 4);
        let c = m > 0.6 ? G.d2 : m > 0.3 ? G.d1 : G.d1;
        if (y === edgeT) c = G.d0; else if (y === edgeT + 1 && n > 0.4) c = G.d3;
        if (n > 0.95) c = G.d3; else if (n < 0.05) c = G.d0;
        dot(x, y, c);
      }
      // pebbles
      for (let i = 0; i < W / 6; i++) {
        const x = Math.floor(hash(i * 11 + 400) * W), y = py0 + 2 + Math.floor(hash(i * 11 + 401) * (py1 - py0 - 3));
        dot(x, y, G.d3); dot(x + 1, y, G.d2); dot(x, y + 1, G.d0);
      }
      // rocks
      this.stampArt(g, 'rock', Math.floor(W * 0.08), Math.min(Hh - this.bot - 16, py1 + 14));
      this.stampArt(g, 'rockS', W - Math.floor(W * 0.2), hz + 3);
    }
    if (env === 'mine') this.paintMine(g, dot, hz);
    // --- tint to environment
    if (env !== 'day') {
      const id = g.getImageData(0, 0, W, Hh), d = id.data, f = TINT[env];
      for (let i = 0; i < d.length; i += 4) { if (!d[i + 3]) continue; const c = f([d[i], d[i + 1], d[i + 2]]); d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; }
      g.putImageData(id, 0, 0);
    }
    // --- sky behind everything
    g.globalCompositeOperation = 'destination-over';
    const sky = SKY[env] || SKY.day, n = sky.length, top = hz - 26, bh = Math.max(2, Math.ceil(Math.max(1, top) / n));
    for (let y = 0; y < hz; y++) {
      const bi = Math.min(n - 1, Math.max(0, Math.floor(y / bh))), last = (y % bh) === bh - 1 && bi < n - 1;
      g.fillStyle = sky[bi]; g.fillRect(0, y, W, 1);
      if (last) { g.fillStyle = sky[bi + 1]; for (let x = (y % 2); x < W; x += 2) g.fillRect(x, y, 1, 1); }
    }
    g.globalCompositeOperation = 'source-over';
    return cv;
  };
  /** Pix Town Mine: little town on the horizon, a rock cliff with a timber mine entrance, a sign and rails. */
  P.paintMine = function (g, dot, hz) {
    const W = this.sw, ox = this.sx0, oy = this.sy0, H = this.H, rect = (x, y, w, h, c) => { g.fillStyle = c; g.fillRect(x, y, w, h); };
    // Pix Town on the horizon (left)
    for (let i = 0; i < 4; i++) {
      const x = ox - 34 + i * 17 + (i % 2) * 3, w = 9 + (i % 2) * 3, h = 6 + (i % 3), y = hz - h;
      if (x + w < 0 || x > ox + 40) continue;
      rect(x, y, w, h, '#b7a386'); rect(x, y, w, 1, '#d2c2a4'); rect(x + w - 1, y, 1, h, '#8f7d64');
      for (let r = 0; r < 4; r++) rect(x - 1 + r, y - 1 - r, w + 2 - r * 2, 1, r ? '#8a3f32' : '#6d3027');
      rect(x + 2, y + 2, 2, 2, '#e8c870'); if (w > 10) rect(x + w - 4, y + 2, 2, 2, '#e8c870');
    }
    // rock cliff (right)
    const cx0 = ox + 42, base = oy + H - 9;
    for (let x = cx0; x < W; x++) {
      const k = Math.min(1, (x - cx0) / 18), top = Math.round(hz - 10 - k * 30 - vnoise(x, 5, 6) * 6 - vnoise(x, 50, 17) * 8);
      for (let y = top; y < base; y++) {
        const n = vnoise(x, y, 4), m = h2(x, y);
        let c = n > 0.62 ? '#857a6e' : n > 0.4 ? '#6d6259' : n > 0.22 ? '#574d45' : '#40372f';
        if (y === top) c = '#9a9082'; else if (y === top + 1) c = '#857a6e';
        if (m > 0.985) c = '#c2ad5a';
        if ((x + y * 3) % 23 === 0 && m > 0.5) c = '#40372f';
        dot(x, y, c);
      }
      if (x === cx0) for (let y = top; y < base; y++) dot(x, y, '#40372f');
    }
    // timber mine entrance
    const ex = ox + 60, ey = oy + 18, ew = 24, eb = oy + H - 2;
    rect(ex + 3, ey + 3, ew - 6, eb - ey - 3, '#0c0a09');
    for (let y = ey + 3; y < eb; y += 3) rect(ex + 3, y, ew - 6, 1, '#15110e');
    rect(ex, ey + 2, 3, eb - ey - 2, '#6b4a2a'); rect(ex + ew - 3, ey + 2, 3, eb - ey - 2, '#6b4a2a');
    rect(ex + 2, ey + 2, 1, eb - ey - 2, '#3e2a17'); rect(ex + ew - 1, ey + 2, 1, eb - ey - 2, '#3e2a17');
    rect(ex - 2, ey, ew + 4, 3, '#7d5932'); rect(ex - 2, ey + 2, ew + 4, 1, '#3e2a17'); rect(ex - 2, ey, ew + 4, 1, '#9a7446');
    // sign above the entrance
    const sx = ex + 5, sy = ey - 8;
    rect(sx + 2, sy + 5, 1, 3, '#3e2a17'); rect(sx + 11, sy + 5, 1, 3, '#3e2a17');
    rect(sx, sy, 14, 6, '#8a6a44'); rect(sx, sy, 14, 1, '#a8865a'); rect(sx, sy + 5, 14, 1, '#4f3a22');
    for (let i = 0; i < 4; i++) rect(sx + 2 + i * 3, sy + 2, 2, 2, '#2e2217');
    // rails along the path into the mine
    const r1 = oy + H - 1, r2 = oy + H + 2;
    for (let x = 0; x < ex + 16; x += 4) rect(x, r1 - 1, 2, 5, '#4a3524');
    rect(0, r1, ex + 16, 1, '#8d949e'); rect(0, r2, ex + 16, 1, '#8d949e'); rect(0, r1 + 1, ex + 16, 1, '#50565e'); rect(0, r2 + 1, ex + 16, 1, '#50565e');
    // ore pile + pickaxe by the entrance
    const px = ex + ew + 3, py = oy + H - 4;
    [[0, 2, 7], [1, 1, 5], [2, 0, 3]].forEach(([dy, dx, w]) => rect(px + dx, py + 2 - dy, w, 1, dy ? '#7d808a' : '#5a5d66'));
    dot(px + 3, py, '#c2ad5a'); dot(px + 5, py + 1, '#c2ad5a');
  };
  P.stampArt = function (g, key, x, y) {
    const a = M.get(key, 0); if (!a) return;
    for (let i = 0; i < a.px.length; i += 3) { g.fillStyle = a.px[i + 2]; g.fillRect(x + a.px[i], y - a.h + a.px[i + 1], 1, 1); }
  };

  P.paintAnimated = function (t, env) {
    const g = this.ctx, W = this.sw, Hh = this.sh, hz = this.horizonFor(env), s = t / 1000;
    const dot = (x, y, c) => { g.fillStyle = c; g.fillRect(x, y, 1, 1); };
    // stars (night: subtle; dusk: very few)
    if (env === 'night' || env === 'dusk') {
      const n = Math.floor(W * hz / (env === 'night' ? 70 : 220));
      for (let i = 0; i < n; i++) {
        const x = Math.floor(hash(i * 3 + 1) * W), y = Math.floor(hash(i * 3 + 2) * (hz - 30));
        const tw = Math.sin(s * (0.8 + hash(i) * 1.2) + i * 2.1);
        if (tw > -0.5) dot(x, y, tw > 0.85 && hash(i + 5) > 0.6 ? '#c9d2ea' : env === 'night' ? '#6f7c9c' : '#8c8aa0');
      }
      if (env === 'night') { const mx = Math.floor(W * 0.74), my = this.top + 8; g.fillStyle = '#c8ccd6'; g.fillRect(mx + 1, my, 2, 1); g.fillRect(mx, my + 1, 2, 2); g.fillRect(mx + 1, my + 3, 2, 1); }
    }
    // soft clouds
    if (env !== 'night') {
      const cl = env === 'dusk' ? ['#6d5a6c', '#5a4a60'] : ['#c9d3dc', '#aebccb'];
      const clouds = [[0.35, 10, 0, 14, 3], [0.22, 22, 37, 20, 4], [0.5, 34, 71, 10, 2]];
      for (const [sp, yy, off, w, hgt] of clouds) {
        const y = this.top + yy; if (y > hz - 30) continue;
        const span = W + w * 2, x0 = Math.floor(((s * sp + off) % span + span) % span) - w;
        for (let dy = 0; dy < hgt; dy++) {
          const ww = w - Math.abs(dy - hgt / 2) * 3;
          g.fillStyle = dy >= hgt - 1 ? cl[1] : cl[0];
          g.fillRect(x0 + Math.floor((w - ww) / 2), y + dy, Math.max(2, Math.floor(ww)), 1);
        }
      }
    }
    // tall grass tufts (sway between two frames)
    const pal = ['#132114', '#244222', '#355f2e', '#4b7a3d'].map(c => tint(c, env === 'battle' ? 'day' : env));
    const lane0 = this.sy0 + this.H - 12, lane1 = this.sy0 + this.H + 7;
    const count = Math.floor(W * (Hh - hz) / 170);
    for (let i = 0; i < count; i++) {
      const x = Math.floor(hash(i * 9 + 1000) * (W + 6)) - 3, y = hz + 4 + Math.floor(hash(i * 9 + 1001) * (Hh - hz - 4));
      if (env !== 'battle' && y > lane0 && y < lane1) continue;
      const depth = (y - hz) / (Hh - hz), size = 3 + Math.floor(depth * 5) + Math.floor(hash(i + 3) * 2);
      const sway = ((this.frame + (i % 2)) % 2) ? 1 : 0;
      for (let b = 0; b < 4; b++) {
        const bx = x + b * 2 - 3, hgt = size - (b === 0 || b === 3 ? 2 : 0), lean = (b - 1.5) * 0.6 + sway * 0.8;
        for (let k = 0; k < hgt; k++) {
          const px = Math.round(bx + lean * k / hgt), py = y - k;
          dot(px - 1, py, pal[0]);
          dot(px, py, k > hgt - 2 ? pal[3] : k > hgt / 2 ? pal[2] : pal[1]);
        }
      }
    }
    if (env === 'mine') {        // flickering lantern by the mine entrance
      const lx = this.sx0 + 56, ly = this.sy0 + 21, f = Math.sin(s * 9) + Math.sin(s * 23) > 0.2;
      g.fillStyle = '#3e2a17'; g.fillRect(lx + 1, ly - 3, 1, 3);
      g.fillStyle = '#2e2217'; g.fillRect(lx, ly, 3, 1); g.fillRect(lx, ly + 4, 3, 1);
      g.fillStyle = f ? '#ffd27a' : '#e0a040'; g.fillRect(lx, ly + 1, 3, 3);
      g.fillStyle = f ? 'rgba(255,210,120,0.22)' : 'rgba(255,190,90,0.14)'; g.fillRect(lx - 3, ly - 2, 9, 9);
    }
    if (env === 'night') {       // a few faint fireflies
      for (let i = 0; i < 4; i++) {
        const x = Math.floor((hash(i + 900) * W + Math.sin(s * 0.4 + i) * 5 + W) % W), y = hz + 6 + Math.floor(hash(i + 950) * 40 + Math.sin(s * 0.6 + i * 2) * 2);
        if (Math.sin(s * 1.6 + i * 1.7) > 0.3) dot(x, y, '#b9c86a');
      }
    }
  };

  // ------------------------------------------------------------ sprites
  /** Monster / prop sprite. opts: {flip, silhouette, alpha, clipX, frame} */
  P.art = function (key, x, y, opts) {
    opts = opts || {};
    const a = M.get(key, opts.frame || 0);
    if (!a) return;
    const g = this.ctx;
    if (opts.alpha != null) g.globalAlpha = opts.alpha;
    if (opts.clipX) { g.save(); g.beginPath(); g.rect(x + opts.clipX, y - 2, a.w + 4, a.h + 4); g.clip(); }
    const X = Math.round(x), Y = Math.round(y), px = a.px;
    for (let i = 0; i < px.length; i += 3) {
      g.fillStyle = opts.silhouette || px[i + 2];
      g.fillRect(X + (opts.flip ? a.w - 1 - px[i] : px[i]), Y + px[i + 1], 1, 1);
    }
    if (opts.clipX) g.restore();
    g.globalAlpha = 1;
  };
  P.size = function (key) { return M.size(key) || { w: 0, h: 0 }; };
  /** Single-colour 1-bit glyph (icons, emotes). */
  P.glyph = function (key, x, y, color, flip) {
    const b = typeof key === 'string' ? T.SPR[key] : key, g = this.ctx;
    g.fillStyle = color || UI.text;
    for (let j = 0; j < b.h; j++) for (let i = 0; i < b.w; i++) {
      if (b.data[j * b.w + (flip ? b.w - 1 - i : i)] === 1) g.fillRect(Math.round(x) + i, Math.round(y) + j, 1, 1);
    }
  };
  /** Small outlined emote glyph (subtle, no bubble). */
  P.emote = function (key, x, y, color) {
    const b = T.SPR[key]; if (!b) return;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1]]) this.glyph(b, x + dx, y + dy, 'rgba(8,10,14,0.85)');
    this.glyph(b, x, y, color);
  };
  P.shadow = function (x, y, w) {
    const g = this.ctx; g.fillStyle = 'rgba(10, 16, 8, 0.35)';
    g.fillRect(Math.round(x + 2), Math.round(y - 1), Math.max(1, w - 4), 2);
    g.fillRect(Math.round(x + 4), Math.round(y + 1), Math.max(1, w - 8), 1);
  };
  /** Grass battle platform (Gen-3 style). */
  P.platform = function (cx, cy, rx, ry) {
    const g = this.ctx;
    for (let y = -ry; y <= ry + 1; y++) for (let x = -rx; x <= rx; x++) {
      const d = (x * x) / (rx * rx) + (y * y) / (ry * ry);
      if (d > 1.05) continue;
      let c = d > 0.8 ? (y > 0 ? '#1f3a1c' : '#3f6a34') : (y < -ry * 0.3 ? '#6b9352' : '#5a8446');
      if (y > ry * 0.6 && d > 0.55) c = '#2a4a24';
      if (h2(x + 500, y + 500) > 0.9 && d < 0.8) c = '#4a7a3c';
      g.fillStyle = tint(c, this.env === 'battle' ? 'day' : this.env);
      g.fillRect(cx + x, cy + y, 1, 1);
    }
  };

  // ------------------------------------------------------------ UI primitives
  /** Map stage coords to low-res canvas pixels with the current transform. */
  P._pt = function (x, y) { const m = this.ctx.getTransform(); return [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f]; };
  /** Anything painted over queued text must hide/tint it on the text layer too. */
  P._cover = function (x, y, w, h, fill) {
    if (!this.tq.length) return;
    const [ax, ay] = this._pt(x, y), [bx, by] = this._pt(x + w, y + h);
    this.tq.push({ k: fill ? 'fill' : 'clear', x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay), c: fill, a: this.ctx.globalAlpha });
  };
  /** Paint the queued UI text (call once at the end of each frame). Text is drawn at its real device-pixel size
   *  (no scale transform): Safari rounds/clamps tiny canvas font sizes, which made drawn text wider than measured. */
  P.flush = function () {
    const g = this.tctx, k = this.scale * this.dpr, fpx = FS * k;
    g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, this.tc.width, this.tc.height);
    g.textBaseline = 'alphabetic';
    for (const o of this.tq) {
      g.globalAlpha = o.a;
      if (o.k === 'clear') g.clearRect(o.x * k, o.y * k, o.w * k, o.h * k);
      else if (o.k === 'fill') { g.fillStyle = o.c; g.fillRect(o.x * k, o.y * k, o.w * k, o.h * k); }
      else { g.font = fontFor(o.s, fpx); g.fillStyle = o.c; g.fillText(o.s, o.x * k, o.y * k); }
    }
    g.globalAlpha = 1;
  };
  P.rect = function (x, y, w, h, c) { this.ctx.fillStyle = c || UI.text; this.ctx.fillRect(x, y, w, h); if (w * h >= 4) this._cover(x, y, w, h, /rgba/.test(c || '') ? c : null); };
  P.frame = function (x, y, w, h, c) { this.rect(x, y, w, 1, c); this.rect(x, y + h - 1, w, 1, c); this.rect(x, y, 1, h, c); this.rect(x + w - 1, y, 1, h, c); };
  P.textW = function (s) { return T.textWidth(s); };
  /** UI text. (x, y) = top-left of the old 7px glyph cell; the real font is centred on that cell. */
  P.text = function (s, x, y, c) {
    s = String(s); if (!s) return;
    const [px, py] = this._pt(x, y + 3.5 + FS * 0.36);
    this.tq.push({ k: 'text', s, x: px, y: py, c: c || UI.text, a: this.ctx.globalAlpha });
  };
  P.textC = function (s, y, c, x0, w) { x0 = x0 || 0; w = w || this.W; this.text(s, x0 + Math.floor((w - this.textW(s)) / 2), y, c); };
  /** Word-wrap to lines no wider than w. */
  P.wrap = function (s, w) {
    const out = []; let line = '';
    String(s).split(' ').forEach(word => {
      const tryL = line ? line + ' ' + word : word;
      if (this.textW(tryL) <= w || !line) line = tryL; else { out.push(line); line = word; }
    });
    if (line) out.push(line);
    return out;
  };
  /** Flat slate panel: fill + single 1px border (no double-edge chrome). accent: highlight border. */
  P.panel = function (x, y, w, h, accent, fill) {
    const g = this.ctx;
    const x2 = Math.round(x + w), y2 = Math.round(y + h); x = Math.round(x); y = Math.round(y); w = x2 - x; h = y2 - y;   // text widths are fractional
    g.fillStyle = fill || UI.panel; g.fillRect(x, y, w, h);
    g.fillStyle = accent || UI.border;
    g.fillRect(x, y, w, 1); g.fillRect(x, y + h - 1, w, 1);
    g.fillRect(x, y, 1, h); g.fillRect(x + w - 1, y, 1, h);
    this._cover(x, y, w, h, null);
  };
  /** 1px rule used under titles / between rows. */
  P.rule = function (x, y, w, c) { this.rect(x, y, w, 1, c || UI.inner); };
  /** Vertically centre a 7px glyph string inside a box of height h. */
  P.textMid = function (s, x, y, h, c) {
    this.text(s, x, y + Math.floor((h - T.FONT_H) / 2), c);
  };
  /** Centred one-or-more-line label in a box sized from the real font (+ padding), kept inside the screen. */
  P.label = function (s, y, c, cx) {
    const b = this.bounds(), sw = Math.min(this.W, b.right - b.left);
    const lines = this.wrap(s, sw - 16), tw = Math.ceil(Math.max(...lines.map(l => this.textW(l))));
    const w = Math.min(b.right - b.left - 2, tw + 10);
    let x = cx != null ? Math.round(cx - w / 2) : Math.floor((this.W - w) / 2);
    x = Math.max(b.left + 1, Math.min(b.right - 1 - w, x));
    const pad = Math.floor((w - tw) / 2);
    this.panel(x, y - 2, w, 11 + (lines.length - 1) * 9);
    lines.forEach((l, i) => this.text(l, x + pad + Math.floor((tw - this.textW(l)) / 2), y + i * 9, c));
    return y - 2 + 11 + (lines.length - 1) * 9;       // bottom edge of the panel
  };
  P.button = function (x, y, w, h, label, hi, color) {
    const need = Math.ceil(this.textW(label)) + 4;    // never narrower than its own text
    if (need > w) { x -= Math.ceil((need - w) / 2); w = need; }
    this.panel(x, y, w, h, hi ? UI.accent : null);
    this.textMid(label, x + Math.floor((w - this.textW(label)) / 2), y, h, color || (hi ? UI.accent : UI.text));
  };
  /** HP bar: green > 50%, yellow > 20%, red otherwise. */
  P.hpBar = function (x, y, w, hp, max) {
    const r = max ? Math.max(0, hp) / max : 0, col = r > 0.5 ? UI.green : r > 0.2 ? UI.yellow : UI.red;
    this.text('HP', x, y - 1, UI.accent);
    const bx = x + 10;
    this.rect(bx, y, w - 10, 5, UI.edge); this.rect(bx + 1, y + 1, w - 12, 3, '#3a3f4a');
    const fw = Math.round((w - 12) * r);
    if (fw > 0) { this.rect(bx + 1, y + 1, fw, 3, col); this.rect(bx + 1, y + 1, fw, 1, 'rgba(255,255,255,0.25)'); }
  };
  P.flash = function (x, y, w, h, c) { this.ctx.fillStyle = c || 'rgba(224,173,72,0.35)'; this.ctx.fillRect(x, y, w, h); this._cover(x, y, w, h, this.ctx.fillStyle); };
  P.overlay = function (c) {
    const g = this.ctx; g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = c; g.fillRect(0, 0, this.sw, this.sh);
    if (this.tq.length) this.tq.push({ k: 'fill', x: 0, y: 0, w: this.sw, h: this.sh, c, a: g.globalAlpha });
    g.restore();
  };
  P.UI = UI;

  /** 1-bit icon on its own canvas (HUD buttons). */
  Scene.iconCanvas = function (cv, key, color, scale) {
    const b = T.SPR[key], s = scale || 3, pad = 1;
    cv.width = (b.w + pad * 2) * s; cv.height = (b.h + pad * 2) * s;
    const g = cv.getContext('2d'); g.clearRect(0, 0, cv.width, cv.height); g.fillStyle = color || UI.text;
    for (let j = 0; j < b.h; j++) for (let i = 0; i < b.w; i++) if (b.data[j * b.w + i] === 1) g.fillRect((i + pad) * s, (j + pad) * s, s, s);
  };
  /** Monster sprite on a standalone canvas (debug gallery). */
  Scene.artCanvas = function (cv, key, scale, bg) {
    const a = M.get(key, 0), s = scale || 4, W = 42, H = 42;
    cv.width = W * s; cv.height = H * s;
    const g = cv.getContext('2d'); g.fillStyle = bg || '#30502a'; g.fillRect(0, 0, cv.width, cv.height);
    if (!a) return;
    const ox = Math.floor((W - a.w) / 2), oy = H - a.h - 1;
    for (let i = 0; i < a.px.length; i += 3) { g.fillStyle = a.px[i + 2]; g.fillRect((ox + a.px[i]) * s, (oy + a.px[i + 1]) * s, s, s); }
  };
  T.Scene = Scene;
})(window.Tama);
