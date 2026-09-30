/* TAMA-PIX — full-screen pixel-art scene renderer.
 *
 * The whole viewport is one low-res canvas (a few dozen logical pixels wide) scaled up by an integer factor
 * with crisp pixels. Gameplay is laid out on a fixed 48x24 "stage" (STAGE_W x STAGE_H) that sits on the grass
 * in the middle of the screen; everything else is scenery (sky, clouds, hills, meadow, flowers, stars...).
 *
 * Environments: 'day' | 'dusk' (asleep, lights on) | 'night' (lights off) | 'arena' (battles).
 * All drawing helpers below take STAGE coordinates unless the name says otherwise.
 */
(function (T) {
  'use strict';
  const C = T.CONFIG;
  const INK = T.INK;
  const PAPER = '#fff7e3', PAPER_SHADE = '#e9d6ae', HILITE = '#ffd84a';

  // ------------------------------------------------------------ colourising 1-bit art
  const artCache = {};
  function colorize(key) {
    if (artCache[key]) return artCache[key];
    const b = T.SPR[key], pal = T.ART[key] || { mode: 'outline', body: '#ffffff' };
    const w = b.w, h = b.h, W2 = w + 2, H2 = h + 2, ink = pal.ink || INK;
    const get = (x, y) => (x < 0 || y < 0 || x >= w || y >= h) ? 0 : b.data[y * w + x];
    // flood-fill "outside" over empty cells on a 1px padded grid
    const out = new Uint8Array(W2 * H2), st = [0];
    out[0] = 1;
    while (st.length) {
      const i = st.pop(), x = i % W2 - 1, y = Math.floor(i / W2) - 1;
      [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([dx, dy]) => {
        const nx = x + dx, ny = y + dy;
        if (nx < -1 || ny < -1 || nx > w || ny > h) return;
        const j = (ny + 1) * W2 + nx + 1;
        if (!out[j] && get(nx, ny) === 0) { out[j] = 1; st.push(j); }
      });
    }
    // sizes of enclosed empty components (small = eyes, big = belly/face)
    const comp = new Int32Array(W2 * H2).fill(-1), sizes = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const j = (y + 1) * W2 + x + 1;
      if (get(x, y) !== 0 || out[j] || comp[j] >= 0) continue;
      const id = sizes.length, q = [j]; comp[j] = id; let n = 0;
      while (q.length) {
        const k = q.pop(); n++;
        const kx = k % W2 - 1, ky = Math.floor(k / W2) - 1;
        [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([dx, dy]) => {
          const nx = kx + dx, ny = ky + dy, m = (ny + 1) * W2 + nx + 1;
          if (nx >= 0 && ny >= 0 && nx < w && ny < h && get(nx, ny) === 0 && !out[m] && comp[m] < 0) { comp[m] = id; q.push(m); }
        });
      }
      sizes.push(n);
    }
    const px = [];
    for (let y = -1; y <= h; y++) for (let x = -1; x <= w; x++) {
      const v = get(x, y), j = (y + 1) * W2 + x + 1;
      let c = null;
      if (pal.mode === 'filled') {
        if (v === 1) c = (get(x, y + 1) !== 1 && y > h * 0.45) ? (pal.shade || pal.body) : pal.body;
        else if (v === 2) c = '#ffffff';
        else if (!out[j]) c = sizes[comp[j]] <= 6 ? ink : (pal.belly || '#ffffff');
        else if (get(x + 1, y) === 1 || get(x - 1, y) === 1 || get(x, y + 1) === 1 || get(x, y - 1) === 1) c = ink;
      } else {
        if (v === 1) c = ink;
        else if (v === 2) c = '#ffffff';
        else if (!out[j]) c = (pal.shade && y > h * 0.55 && get(x, y + 1) === 1) ? pal.shade : pal.body;
      }
      if (c) px.push(x, y, c);
    }
    return (artCache[key] = { w, h, px });
  }

  // ------------------------------------------------------------ deterministic noise
  const hash = (n) => { n = (n ^ 61) ^ (n >>> 16); n = (n + (n << 3)) | 0; n ^= n >>> 4; n = Math.imul(n, 0x27d4eb2d); n ^= n >>> 15; return (n >>> 0) / 4294967295; };

  const ENV = {
    day:   { sky: ['#4fb3ff', '#6cc4ff', '#8ad3ff', '#a9e2ff', '#c9eeff'], hillFar: '#8fd18a', hillNear: '#63bb5c',
             grass: ['#6fcb4a', '#63bf40', '#58b23a', '#4ea634'], tuft: '#3f8f2a', tuftHi: '#8fe06a', flowers: ['#ffffff', '#ffe14d', '#ff8fb8', '#9fb8ff'] },
    dusk:  { sky: ['#1f2466', '#343087', '#553a9c', '#8a4c9f', '#d7708f'], hillFar: '#3c5f6e', hillNear: '#2f5a4a',
             grass: ['#3f7d4a', '#397244', '#33683e', '#2d5e38'], tuft: '#244d2d', tuftHi: '#5a9a5f', flowers: ['#d8d0f0', '#e8c96a', '#d88aa8', '#8a9ad8'] },
    night: { sky: ['#070a1f', '#0b1030', '#10173f', '#16204e', '#1d2b5c'], hillFar: '#1b2a45', hillNear: '#14263a',
             grass: ['#1d3a33', '#1a342e', '#172f2a', '#142a26'], tuft: '#0f211d', tuftHi: '#2d5248', flowers: ['#5a6480', '#6b6a4a', '#6a4a60', '#44507a'] },
    arena: { sky: ['#ff9a5a', '#ffb36b', '#ffc97d', '#ffdb95', '#ffe9b3'], hillFar: '#8a5a8c', hillNear: '#6d4a78',
             grass: ['#f0cf8a', '#e8c27a', '#dfb56c', '#d6a95f'], tuft: '#b88a48', tuftHi: '#fff0c0', flowers: [] }
  };

  function Scene(canvas) {
    this.c = canvas; this.ctx = canvas.getContext('2d');
    this.W = C.STAGE_W; this.H = C.STAGE_H;
    this.scale = 8; this.sw = 48; this.sh = 100; this.sx0 = 0; this.sy0 = 40; this.horizon = 44;
    this.bgCache = null;
  }
  const P = Scene.prototype;

  /** Size the scene to the viewport. topPx/botPx = height of the UI bars that overlay it. */
  P.resize = function (vw, vh, topPx, botPx) {
    const s = Math.max(3, Math.min(12, Math.floor(Math.min(vw / C.STAGE_W, vh / 70))));
    this.scale = s;
    this.sw = Math.max(C.STAGE_W, Math.ceil(vw / s));
    this.sh = Math.ceil(vh / s);
    const top = Math.ceil(topPx / s), bot = Math.ceil(botPx / s);
    this.top = top; this.bot = bot;
    const visible = this.sh - top - bot;
    this.sx0 = Math.floor((this.sw - this.W) / 2);
    this.sy0 = top + Math.max(0, Math.round((visible - this.H) * 0.5));
    this.horizon = this.sy0 + 4;
    this.c.width = this.sw; this.c.height = this.sh;
    const cw = this.sw * s, ch = this.sh * s;
    Object.assign(this.c.style, { width: cw + 'px', height: ch + 'px', left: Math.floor((vw - cw) / 2) + 'px', top: '0px' });
    this.bgCache = null;
    this.ctx.imageSmoothingEnabled = false;
  };
  /** Client (CSS px) -> stage coordinates. */
  P.toStage = function (clientX, clientY) {
    const r = this.c.getBoundingClientRect();
    return { x: (clientX - r.left) / this.scale - this.sx0, y: (clientY - r.top) / this.scale - this.sy0 };
  };
  P.toClient = function (sx, sy) {
    const r = this.c.getBoundingClientRect();
    return { x: r.left + (sx + this.sx0) * this.scale, y: r.top + (sy + this.sy0) * this.scale };
  };

  // ------------------------------------------------------------ background
  P.begin = function (t, env) {
    this.env = env;
    const ctx = this.ctx, E = ENV[env] || ENV.day;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1;
    const key = env + this.sw + 'x' + this.sh + ':' + this.horizon;
    if (!this.bgCache || this.bgCache.key !== key) this.bgCache = { key, img: this.paintStatic(E, env) };
    ctx.drawImage(this.bgCache.img, 0, 0);
    this.paintAnimated(t, E, env);
    ctx.setTransform(1, 0, 0, 1, this.sx0, this.sy0);
  };
  P.paintStatic = function (E, env) {
    const cv = document.createElement('canvas'); cv.width = this.sw; cv.height = this.sh;
    const g = cv.getContext('2d'), W = this.sw, hz = this.horizonFor(env);
    // sky bands with a dithered seam
    const n = E.sky.length, bh = Math.max(1, Math.ceil(hz / n));
    for (let y = 0; y < hz; y++) {
      const bi = Math.min(n - 1, Math.floor(y / bh)), last = (y % bh) === bh - 1 && bi < n - 1;
      g.fillStyle = E.sky[bi]; g.fillRect(0, y, W, 1);
      if (last) { g.fillStyle = E.sky[bi + 1]; for (let x = (y % 2); x < W; x += 2) g.fillRect(x, y, 1, 1); }
    }
    if (env === 'arena') {
      // stands with a crowd
      g.fillStyle = '#7a4b7e'; g.fillRect(0, hz - 7, W, 7);
      g.fillStyle = '#5e3a66'; g.fillRect(0, hz - 7, W, 1); g.fillRect(0, hz - 4, W, 1);
      const crowd = ['#ffe14d', '#ff8fb8', '#9fe0ff', '#ffffff', '#8fe06a'];
      for (let x = 0; x < W; x++) for (let r = 0; r < 2; r++) if (hash(x * 7 + r * 131) > 0.45) { g.fillStyle = crowd[Math.floor(hash(x + r * 99) * 5)]; g.fillRect(x, hz - 6 + r * 3, 1, 1); }
      for (let x = 2; x < W; x += 9) { g.fillStyle = '#e8263b'; g.fillRect(x, hz - 12, 1, 5); g.fillStyle = '#ffd84a'; g.fillRect(x + 1, hz - 12, 2, 2); }
    } else {
      // far & near hills
      for (let x = 0; x < W; x++) {
        const hf = Math.round(3 + 2 * Math.sin(x * 0.19 + 1.3) + Math.sin(x * 0.07));
        g.fillStyle = E.hillFar; g.fillRect(x, hz - hf, 1, hf);
        const hn = Math.round(1 + 1.5 * Math.sin(x * 0.31 + 4) + 0.8 * Math.sin(x * 0.11 + 2));
        if (hn > 0) { g.fillStyle = E.hillNear; g.fillRect(x, hz - hn, 1, hn); }
      }
    }
    // ground bands
    const gn = E.grass.length, gh = Math.max(2, Math.ceil((this.sh - hz) / gn));
    for (let y = hz; y < this.sh; y++) {
      const bi = Math.min(gn - 1, Math.floor((y - hz) / gh)), last = ((y - hz) % gh) === gh - 1 && bi < gn - 1;
      g.fillStyle = E.grass[bi]; g.fillRect(0, y, W, 1);
      if (last) { g.fillStyle = E.grass[bi + 1]; for (let x = (y % 2); x < W; x += 2) g.fillRect(x, y, 1, 1); }
    }
    if (env === 'arena') {
      // ring on the sand, centred under the fighters
      const cx = this.sx0 + this.W / 2, cy = this.sy0 + this.H - 1, rx = this.W / 2 - 1, ry = 3;
      g.fillStyle = '#fff4d8';
      for (let a = 0; a < Math.PI * 2; a += 0.02) g.fillRect(Math.round(cx + Math.cos(a) * rx), Math.round(cy + Math.sin(a) * ry), 1, 1);
      g.fillStyle = 'rgba(0,0,0,0.06)';
      for (let y = hz + 2; y < this.sh; y += 4) for (let x = (y % 8 ? 0 : 4); x < W; x += 8) g.fillRect(x, y, 2, 1);
    }
    if (env !== 'arena') this.paintDecor(g, E, env);
    return cv;
  };
  /** A tree on the left horizon and a couple of bushes / rocks in the foreground. */
  P.paintDecor = function (g, E, env) {
    const dark = env !== 'day', hz = this.horizon;
    const leaf = dark ? ['#16352c', '#1d4436', '#26543f'] : ['#2f8a3a', '#3fa548', '#5cc25a'];
    const trunk = dark ? '#2a1c1c' : '#7a4a2a';
    const tx = Math.max(1, this.sx0 - 6), ty = hz + 1;
    g.fillStyle = trunk; g.fillRect(tx + 4, ty - 6, 2, 7);
    const blob = (cx, cy, r, c) => { g.fillStyle = c; for (let y = -r; y <= r; y++) { const w = Math.round(Math.sqrt(r * r - y * y)); g.fillRect(cx - w, cy + y, w * 2 + 1, 1); } };
    blob(tx + 5, ty - 10, 5, leaf[0]); blob(tx + 4, ty - 11, 4, leaf[1]); blob(tx + 3, ty - 12, 2, leaf[2]);
    if (!dark) { g.fillStyle = '#ff5a5a'; g.fillRect(tx + 7, ty - 9, 1, 1); g.fillRect(tx + 2, ty - 8, 1, 1); g.fillRect(tx + 5, ty - 13, 1, 1); }
    // foreground bushes & rocks (below the pet lane)
    const fy = Math.min(this.sh - (this.bot || 0) - 4, this.sy0 + this.H + 12);
    if (fy > this.sy0 + this.H + 4) {
      const bx = this.sx0 + this.W - 12;
      blob(bx, fy, 3, leaf[0]); blob(bx + 4, fy + 1, 3, leaf[1]); blob(bx + 2, fy - 1, 2, leaf[2]);
      const rx = this.sx0 + 4;
      g.fillStyle = dark ? '#3a3f4a' : '#9aa0ad'; g.fillRect(rx, fy, 5, 2); g.fillRect(rx + 1, fy - 1, 3, 1);
      g.fillStyle = dark ? '#555b68' : '#c4c9d4'; g.fillRect(rx + 1, fy - 1, 2, 1);
    }
  };
  P.horizonFor = function (env) {
    return env === 'arena' ? Math.max((this.top || 0) + 9, this.sy0 - 22) : this.horizon;
  };
  P.paintAnimated = function (t, E, env) {
    const g = this.ctx, W = this.sw, hz = this.horizonFor(env), s = t / 1000;
    const dot = (x, y, c) => { g.fillStyle = c; g.fillRect(x, y, 1, 1); };
    if (env === 'night' || env === 'dusk') {
      const stars = Math.floor(W * hz / (env === 'night' ? 28 : 60));
      for (let i = 0; i < stars; i++) {
        const x = Math.floor(hash(i * 3 + 1) * W), y = Math.floor(hash(i * 3 + 2) * (hz - 6));
        const tw = Math.sin(s * (1.5 + hash(i) * 2) + i);
        if (tw > -0.3) dot(x, y, tw > 0.7 ? '#ffffff' : '#9fb0e0');
        if (tw > 0.93 && env === 'night') { dot(x - 1, y, '#6a7ab0'); dot(x + 1, y, '#6a7ab0'); dot(x, y - 1, '#6a7ab0'); dot(x, y + 1, '#6a7ab0'); }
      }
      // moon
      const mx = Math.floor(W * 0.72), my = (this.top || 0) + 3;
      g.fillStyle = env === 'night' ? '#fff6c8' : '#ffe9a8';
      [[1, 0, 3], [0, 1, 5], [0, 2, 5], [0, 3, 5], [1, 4, 3]].forEach(([dx, dy, w]) => g.fillRect(mx + dx, my + dy, w, 1));
      g.fillStyle = E.sky[0]; g.fillRect(mx + 3, my + 1, 2, 3);
    } else if (env === 'day') {
      // sun with twinkling rays
      const sx = Math.floor(W * 0.72), sy = (this.top || 0) + 4, on = Math.floor(s * 2) % 2;
      g.fillStyle = '#fff3a0'; [[1, 0, 3], [0, 1, 5], [0, 2, 5], [0, 3, 5], [1, 4, 3]].forEach(([dx, dy, w]) => g.fillRect(sx + dx, sy + dy, w, 1));
      g.fillStyle = '#ffd84a'; g.fillRect(sx + 1, sy + 1, 3, 3);
      g.fillStyle = '#fff3a0';
      if (on) { g.fillRect(sx + 2, sy - 2, 1, 1); g.fillRect(sx + 2, sy + 6, 1, 1); g.fillRect(sx - 2, sy + 2, 1, 1); g.fillRect(sx + 6, sy + 2, 1, 1); }
      else { g.fillRect(sx - 1, sy - 1, 1, 1); g.fillRect(sx + 5, sy - 1, 1, 1); g.fillRect(sx - 1, sy + 5, 1, 1); g.fillRect(sx + 5, sy + 5, 1, 1); }
    }
    if (env !== 'arena') {
      // drifting clouds
      const clouds = [['cloud', 0.9, 3, 0], ['cloudS', 0.55, 9, 17], ['cloud', 0.35, 14, 41], ['cloudS', 0.75, 1, 63]];
      g.globalAlpha = env === 'day' ? 1 : env === 'dusk' ? 0.45 : 0.18;
      for (const [k, sp, yy, off] of clouds) {
        const y = yy + (this.top || 0);
        if (y > hz - 8) continue;
        const a = colorize(k), span = W + a.w + 4;
        const x = Math.floor(((s * sp + off) % span + span) % span) - a.w - 2;
        this.drawArt(a, x, y, false);
      }
      g.globalAlpha = 1;
      // swaying grass tufts & flowers
      const area = W * (this.sh - hz), tufts = Math.floor(area / 10);
      for (let i = 0; i < tufts; i++) {
        const x = Math.floor(hash(i * 5 + 11) * W), y = hz + 2 + Math.floor(hash(i * 5 + 12) * (this.sh - hz - 2));
        const sway = Math.round(Math.sin(s * 1.6 + x * 0.35 + y * 0.2) * 0.8);
        dot(x, y, E.tuft); dot(x + sway, y - 1, E.tuft);
        if (hash(i * 5 + 13) > 0.6) dot(x + sway, y - 2, E.tuftHi);
      }
      if (E.flowers.length) {
        const fl = Math.floor(area / 70);
        for (let i = 0; i < fl; i++) {
          const x = 1 + Math.floor(hash(i * 7 + 501) * (W - 2)), y = hz + 4 + Math.floor(hash(i * 7 + 502) * (this.sh - hz - 5));
          if (y > this.sy0 + 9 && y < this.sy0 + this.H + 2 && x > this.sx0 - 2 && x < this.sx0 + this.W + 2) continue;   // keep the pet lane clear
          const sway = Math.round(Math.sin(s * 1.3 + i) * 0.6), col = E.flowers[Math.floor(hash(i * 7 + 503) * E.flowers.length)];
          dot(x, y, E.tuft); dot(x + sway, y - 1, E.tuft);
          const hx = x + sway, hy = y - 2;
          dot(hx, hy - 1, col); dot(hx - 1, hy, col); dot(hx + 1, hy, col); dot(hx, hy + 1, col);
          dot(hx, hy, env === 'day' ? '#ffb300' : '#8a7a40');
        }
      }
      if (env === 'night') {   // fireflies
        for (let i = 0; i < 6; i++) {
          const x = Math.floor((hash(i + 900) * W + Math.sin(s * 0.4 + i) * 6 + W) % W), y = hz + 3 + Math.floor(hash(i + 950) * 20 + Math.sin(s * 0.7 + i * 2) * 2);
          if (Math.sin(s * 2 + i * 1.7) > 0) dot(x, y, '#e8ff7a');
        }
      }
    }
  };

  // ------------------------------------------------------------ drawing API (stage coordinates)
  P.drawArt = function (a, x, y, flip, silhouette) {
    const g = this.ctx, px = a.px;
    for (let i = 0; i < px.length; i += 3) {
      const ix = flip ? a.w - 1 - px[i] : px[i];
      g.fillStyle = silhouette || px[i + 2];
      g.fillRect(x + ix, y + px[i + 1], 1, 1);
    }
  };
  /** Colourised sprite (creatures & props). opts: {flip, silhouette, alpha, clipX} */
  P.art = function (key, x, y, opts) {
    opts = opts || {};
    const a = colorize(key);
    const g = this.ctx;
    if (opts.alpha != null) g.globalAlpha = opts.alpha;
    if (opts.clipX) { g.save(); g.beginPath(); g.rect(x + opts.clipX, y - 2, a.w + 4, a.h + 4); g.clip(); }
    this.drawArt(a, Math.round(x), Math.round(y), !!opts.flip, opts.silhouette);
    if (opts.clipX) g.restore();
    g.globalAlpha = 1;
  };
  /** Single-colour 1-bit glyph. */
  P.glyph = function (key, x, y, color, flip) {
    const b = typeof key === 'string' ? T.SPR[key] : key, g = this.ctx;
    g.fillStyle = color || (typeof key === 'string' && T.TINT[key]) || INK;
    for (let j = 0; j < b.h; j++) for (let i = 0; i < b.w; i++) {
      if (b.data[j * b.w + (flip ? b.w - 1 - i : i)] === 1) g.fillRect(Math.round(x) + i, Math.round(y) + j, 1, 1);
    }
  };
  P.shadow = function (x, y, w) {
    const g = this.ctx; g.fillStyle = 'rgba(20, 40, 10, 0.25)';
    g.fillRect(Math.round(x + 1), Math.round(y), Math.max(1, w - 2), 1);
    g.fillRect(Math.round(x + 2), Math.round(y + 1), Math.max(1, w - 4), 1);
  };
  P.rect = function (x, y, w, h, c) { this.ctx.fillStyle = c || INK; this.ctx.fillRect(x, y, w, h); };
  P.frame = function (x, y, w, h, c) { this.rect(x, y, w, 1, c); this.rect(x, y + h - 1, w, 1, c); this.rect(x, y, 1, h, c); this.rect(x + w - 1, y, 1, h, c); };
  P.textW = function (s) { return String(s).length * 4 - 1; };
  P.text = function (s, x, y, c) {
    s = String(s).toUpperCase();
    for (let k = 0; k < s.length; k++) this.glyph(T.FONT[s[k]] || T.FONT['?'], x + k * 4, y, c || INK);
  };
  P.textC = function (s, y, c) { this.text(s, Math.floor((this.W - this.textW(s)) / 2), y, c); };
  /** Pixel panel: paper fill, ink border with cut corners, hard drop shadow. */
  P.panel = function (x, y, w, h, fill) {
    const g = this.ctx;
    g.fillStyle = 'rgba(43, 29, 46, 0.35)'; g.fillRect(x + 1, y + h, w - 1, 1); g.fillRect(x + w, y + 1, 1, h);
    g.fillStyle = fill || PAPER; g.fillRect(x + 1, y + 1, w - 2, h - 2);
    g.fillStyle = PAPER_SHADE; g.fillRect(x + 1, y + h - 2, w - 2, 1);
    g.fillStyle = INK;
    g.fillRect(x + 1, y, w - 2, 1); g.fillRect(x + 1, y + h - 1, w - 2, 1); g.fillRect(x, y + 1, 1, h - 2); g.fillRect(x + w - 1, y + 1, 1, h - 2);
  };
  /** Text on a small paper plate, centred horizontally at y. */
  P.label = function (s, y, c, fill) {
    const w = this.textW(s) + 4, x = Math.floor((this.W - w) / 2);
    this.panel(x, y - 2, w, 9, fill); this.text(s, x + 2, y, c);
  };
  P.flash = function (x, y, w, h, c) { this.ctx.fillStyle = c || 'rgba(255,255,255,0.55)'; this.ctx.fillRect(x, y, w, h); };
  /** Tint the whole screen (e.g. dark overlay at night, white flash on evolution). */
  P.overlay = function (c) {
    const g = this.ctx; g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = c; g.fillRect(0, 0, this.sw, this.sh); g.restore();
  };
  P.HILITE = HILITE; P.PAPER = PAPER; P.INK = INK;
  /** Visible stage-space bounds (the scene extends beyond the 48x24 stage). */
  P.bounds = function () { return { left: -this.sx0, right: this.sw - this.sx0, top: -this.sy0, bottom: this.sh - this.sy0 }; };

  /** Draw a 1-bit icon onto its own little canvas (menu bar buttons). */
  Scene.iconCanvas = function (cv, key, color, scale) {
    const b = T.SPR[key], s = scale || 3, pad = 1;
    cv.width = (b.w + pad * 2) * s; cv.height = (b.h + pad * 2) * s;
    const g = cv.getContext('2d'); g.clearRect(0, 0, cv.width, cv.height); g.fillStyle = color || INK;
    for (let j = 0; j < b.h; j++) for (let i = 0; i < b.w; i++) if (b.data[j * b.w + i] === 1) g.fillRect((i + pad) * s, (j + pad) * s, s, s);
  };
  /** Draw a colourised sprite onto a standalone canvas (debug gallery). */
  Scene.artCanvas = function (cv, key, scale, bg) {
    const a = colorize(key), s = scale || 4, W = 20, H = 20;
    cv.width = W * s; cv.height = H * s;
    const g = cv.getContext('2d'); g.fillStyle = bg || '#8fd18a'; g.fillRect(0, 0, cv.width, cv.height);
    const ox = Math.floor((W - a.w) / 2), oy = H - a.h - 1;
    for (let i = 0; i < a.px.length; i += 3) { g.fillStyle = a.px[i + 2]; g.fillRect((ox + a.px[i]) * s, (oy + a.px[i + 1]) * s, s, s); }
  };
  Scene.colorize = colorize;
  T.Scene = Scene;
})(window.Tama);
