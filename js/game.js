/* TAMA-PIX — UI controller. The SERVER owns the pet: this file shows the state it gets from /api/state, sends
 * player intents to /api/act, plays battles over the live socket (net.js) and animates what happened.
 * Between polls it only extrapolates the clocks (age, job timer, sleep recharge) so the screen stays alive.
 *
 * Rendering: full-screen GBA-style scene (scene.js); gameplay on a 96x48 "stage", negative y reaches into the sky.
 * Input: HUD buttons + tappable "zones" registered while drawing (zone()); zones carry ids for tests/tools.
 * Keyboard (optional): 1/A next, 2/B ok, 3/C back, M mute.
 */
(function (T) {
  'use strict';
  const C = T.CONFIG, U = T.util, Pet = T.Pet, A = T.Audio, UI = T.UI, E = T.Economy, Api = T.Api, Net = T.Net;
  const W = C.STAGE_W, H = C.STAGE_H, FOOT = H - 2, TT = C.T, HOUR = 3600e3;
  const TOP_BAR = ['feed', 'light', 'play', 'medicine', 'bath', 'attention'];
  const BOTTOM_BAR = ['back', 'home', 'status', 'discipline', 'battle'];
  const CARE = ['feed', 'light', 'play', 'medicine', 'bath', 'discipline', 'battle'];
  const LABELS = { feed: 'Feed', light: 'Lights', play: 'Train', medicine: 'Medicine', bath: 'Clean up', status: 'Status',
                   discipline: 'Discipline', battle: 'Battle', attention: 'Needs attention', back: 'Back', home: 'Main menu' };
  const EMOTE_COL = { heart: '#c9505a', note: '#9fb3d1', angry: '#d0503c', zzz: '#9fb0d0', sweat: '#7fb4d8',
                      question: '#d8dde6', food: '#d8c9a0', skull: '#d8dde6', excl: UI.accent };
  const STATUS_PAGES = 5, HELP_PAGES = 6;
  const NOTIFY_KEY = 'tamapix.notify';

  let S, hud = {}, state, eco, chal = { incoming: [], outgoing: [] }, user = null, cfg = {}, ui;
  let base = null, lastFetch = 0, pollTimer = null, busy = false, session = false, offline = false, dueAt = 0;
  const notifyLog = [];

  function freshUI() {
    return {
      mode: 'main', sub: 0, page: 0,
      anim: null, queue: [], zones: [], rows: null, tapFx: null, tapLock: 0, lastInput: 'tap',
      pet: { x: 30, dir: 1, move: 'walk', lastStep: 0 }, petted: 0,
      emote: null, emoteUntil: 0, nextThink: 0, thought: '',
      play: null, battle: null, search: null, confirm: null, toast: null, discMsg: null,
      lastCallBeep: 0, fallbackReason: null
    };
  }

  // ---------------------------------------------------------------- helpers
  const now = () => performance.now();
  const petKey = (id) => (T.Monsters.has(id || state.formId) ? (id || state.formId) : 'blob');
  const sz = (k) => S.size(k);
  const blink = (t, ms) => Math.floor(t / (ms || 400)) % 2 === 0;
  const groundY = (k) => FOOT - sz(k).h + 1;
  const formName = (id) => (T.FORMS[id] || T.FORMS.blob).name;
  const poopSlot = (i) => [W - 12 - i * 11, FOOT - 6];
  const hatched = () => state && !state.dead && state.stage !== 'egg';
  function rightLimit() { return W - 2 - Math.min(4, state.poops.length) * 11; }
  /** "1d 4h" / "3h 12m" / "25m" / "<1m". */
  function fmtDur(ms) {
    const m = Math.max(0, Math.ceil(ms / 60000)), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
    if (d) return d + 'd' + (h ? ' ' + h + 'h' : '');
    if (h) return h + 'h' + (mm ? ' ' + mm + 'm' : '');
    return ms < 60000 ? '<1m' : mm + 'm';
  }
  /** Cut text to fit maxW pixels (adds an ellipsis). */
  function fitText(str, maxW) {
    str = String(str);
    if (S.textW(str) <= maxW) return str;
    while (str.length > 1 && S.textW(str + '…') > maxW) str = str.slice(0, -1);
    return str.trimEnd() + '…';
  }
  const jobLeft = () => (state.job ? Math.max(0, state.job.endT - state.simT) : 0);
  const energy = () => Math.floor(state.energy || 0);

  /** Register a tappable area (stage coords). box = area to flash; id = stable name for tests/tools. */
  function zone(x, y, w, h, fn, box, id) { ui.zones.push({ x, y, w, h, fn, box: box || null, id: id || null }); }
  function startAnim(dur, draw, onEnd, onStart) {
    const a = { dur, draw, onEnd, onStart, t0: 0 };
    if (ui.anim) ui.queue.push(a); else begin(a);
  }
  function begin(a) { a.t0 = now(); ui.anim = a; if (a.onStart) a.onStart(); }
  function endAnim() {
    const a = ui.anim; ui.anim = null;
    if (a && a.onEnd) a.onEnd();
    if (!ui.anim && ui.queue.length) begin(ui.queue.shift());
  }
  function back() { ui.mode = 'main'; ui.sub = 0; ui.page = 0; }
  function toast(line1, line2, ms) { ui.toast = { l1: line1, l2: line2 || '', until: now() + (ms || 2600) }; }
  function confirmBox(title, lines, yes, noLabel, id) { ui.confirm = { title, lines, yes, no: noLabel || 'NO', id: id || 'confirm' }; ui.sub = 0; }

  function drawPet(key, x, y, flip, opts) {
    S.shadow(x, FOOT + 1, sz(key).w);
    S.art(key, x, y, Object.assign({ flip, frame: S.frame }, opts || {}));
  }
  function drawEmote(name, px, py, pw) {
    const x = U.clamp(px + pw - 3, -4, W - 2), y = py - 7;
    S.emote('e_' + name, x, y, EMOTE_COL[name]);
  }
  function drawPoops(t) {
    state.poops.forEach((p, i) => { if (i < 4) { const [x, y] = poopSlot(i); S.art('dung', x, y); } });
    if (state.poops.length && blink(t, 700)) S.glyph('stink1', poopSlot(0)[0] + 3, FOOT - 11, 'rgba(160,150,110,0.55)');
  }
  function drawSparkles(t, cx, cy) {
    const r = 16 + (Math.floor(t / 150) % 3);
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([dx, dy], i) => {
      if ((Math.floor(t / 150) + i) % 2) S.glyph('sparkle', cx + dx * r - 2, cy + dy * (r - 6) - 2, '#e8dca0');
    });
  }
  function dim() { S.overlay('rgba(6, 8, 14, 0.5)'); }
  function bar(x, y, w, frac, col) {
    S.rect(x, y, w, 5, UI.edge); S.rect(x + 1, y + 1, w - 2, 3, '#343b48');
    const f = Math.round((w - 2) * U.clamp(frac, 0, 1)); if (f > 0) S.rect(x + 1, y + 1, f, 3, col);
  }

  /** Stacked choices: one flat card, clear labels + right notes. opts: [{label, icon, note, fn, id}]. */
  function drawOptions(opts, title) {
    const n = opts.length, rowH = 14, pad = 3, w = W - 8, x = 4;
    const head = title ? 13 : 2, total = head + n * rowH + pad;
    const y0 = Math.round(H / 2 - total / 2) - 2 - (n > 3 ? 8 : 0);
    S.panel(x, y0, w, total);
    if (title) {
      S.textMid(title, x + 5, y0 + 1, head - 1, UI.accent);
      S.rule(x + 4, y0 + head - 1, w - 8);
    }
    ui.rows = opts;
    opts.forEach((o, i) => {
      const y = y0 + head + i * rowH, hi = ui.lastInput === 'key' && ui.sub === i;
      if (hi) { S.rect(x + 1, y, w - 2, rowH, '#243044'); S.rect(x + 1, y + 2, 2, rowH - 4, UI.accent); }
      const lx = x + 6, ly = y + Math.floor((rowH - T.FONT_H) / 2);
      let rightW = 0;
      if (o.icon) rightW = Math.max(rightW, sz(o.icon).w + 6);
      if (o.note) rightW = Math.max(rightW, S.textW(o.note) + 3);
      S.text(fitText(o.label, w - 12 - rightW), lx, ly, hi ? UI.accent : UI.text);
      if (o.icon) { const a = sz(o.icon); S.art(o.icon, x + w - a.w - 4, y + Math.floor((rowH - a.h) / 2)); }
      if (o.note) S.text(o.note, x + w - 5 - S.textW(o.note), ly, o.noteCol || UI.dim);
      const zt = i === 0 ? y0 - 20 : y, zb = i === n - 1 ? y0 + total + 20 : y + rowH;
      zone(-20, zt, W + 40, zb - zt, o.fn, { x: x + 1, y, w: w - 2, h: rowH }, o.id || 'opt' + i);
    });
  }

  /** List screen: flat card, title rule, aligned icon/label/button baselines. rows: [{icon, label, sub, right, btn, fn, id, dim}] */
  function drawRows(title, rows, opts) {
    opts = opts || {};
    const FH = T.FONT_H, hasIcon = rows.some(r => r.icon), iconGutter = hasIcon ? 13 : 0;
    const b = S.bounds(), rowH = opts.rowH || (rows.some(r => r.sub) ? 18 : 13), x = 2, w = W - 4;
    const head = title ? 13 : 2, pad = 2, btnH = 11;
    const total = head + rows.length * rowH + pad;
    const y0 = opts.y != null ? opts.y : Math.max(b.top + 2, Math.min(b.bottom - total - 2, Math.round((b.top + b.bottom) / 2 - total / 2)));
    S.panel(x, y0, w, total);
    if (title) {
      S.textMid(title, x + 5, y0, head - 1, UI.accent);
      if (opts.right) {
        const rx = x + w - 5 - S.textW(opts.right);
        if (rx > x + 8 + S.textW(title)) S.textMid(opts.right, rx, y0, head - 1, opts.rightCol || UI.dim);
      }
      S.rule(x + 4, y0 + head - 2, w - 8);
    }
    ui.rows = rows;
    rows.forEach((r, i) => {
      const y = y0 + head + i * rowH, hi = ui.lastInput === 'key' && ui.sub === i;
      if (hi) { S.rect(x + 1, y, w - 2, rowH, '#243044'); S.rect(x + 1, y + 2, 2, rowH - 4, UI.accent); }
      const colX = x + 5;
      const tx = colX + iconGutter;
      let bw = r.btn ? Math.max(16, S.textW(r.btn.label) + 6) : 0;
      const maxT = x + w - 4 - (bw ? bw + 3 : 2) - tx;
      const label = fitText(r.label, maxT);
      // Shared baseline: icon / label / right / button text all on the same y
      const ly = r.sub ? y + 2 : y + Math.floor((rowH - FH) / 2);
      const by = ly - Math.floor((btnH - FH) / 2);
      if (r.icon) {
        const gl = T.SPR[r.icon];
        S.glyph(r.icon, colX + Math.floor((11 - gl.w) / 2), y + Math.floor((rowH - gl.h) / 2), r.iconCol || (r.dim ? UI.dim : UI.accent));
      }
      S.text(label, tx, ly, r.dim ? UI.dim : (r.col || UI.text));
      if (r.sub) S.text(fitText(r.sub, maxT), tx, ly + 8, r.subCol || UI.dim);
      if (r.btn) {
        const bx = x + w - 3 - bw;
        S.button(bx, by, bw, btnH, r.btn.label, false, r.btn.dim ? UI.dim : (r.btn.col || UI.accent));
        zone(bx - 2, y, bw + 4, rowH, r.btn.fn, { x: bx, y: by, w: bw, h: btnH }, r.btn.id);
      } else if (r.right && x + w - 4 - S.textW(r.right) > tx + S.textW(label) + 3) {
        S.text(r.right, x + w - 4 - S.textW(r.right), ly, r.rightCol || UI.dim);
      }
      if (r.fn) zone(x + 1, y, w - 2 - (bw ? bw + 5 : 0), rowH, r.fn, { x: x + 1, y, w: w - 2, h: rowH }, r.id);
    });
    return { y0, total };
  }

  function envFor() {
    if (ui.mode === 'battle') return 'battle';
    if (ui.mode === 'jobs') return 'mine';
    if (state.lightsOff) return 'night';
    if (state.asleep || state.dead) return 'dusk';
    return 'day';
  }

  // ---------------------------------------------------------------- server state
  /** Take a server view: the pet, wallet, challenges and the events that happened since the last look. */
  function applyView(v, opts) {
    if (!v || !v.pet) return;
    opts = opts || {};
    const prev = state;
    state = v.pet; eco = v.eco || eco; if (v.challenges) chal = v.challenges; if (v.user) user = v.user;
    base = { at: now(), simT: state.simT, ageMs: state.ageMs, eggMs: state.eggMs, energy: state.energy };
    lastFetch = now();
    if (prev && prev.formId !== state.formId && state.stage === 'egg') { ui = Object.assign(freshUI(), { lastInput: ui.lastInput }); }
    handleEvents(v.events || [], opts.boot);
    if (state.dead && ['play', 'search', 'jobs', 'shop', 'discipline'].includes(ui.mode)) { ui.play = null; back(); }
    if (state.job && ui.mode === 'play') { ui.play = null; back(); }
    updateWallet(); renderHUD();
  }
  /** Keep the clocks moving between polls (display only; the server recomputes everything). */
  function extrapolate() {
    if (!base || !state || state.dead) return;
    const el = now() - base.at;
    state.simT = base.simT + el;
    if (state.stage === 'egg') state.eggMs = Math.min(TT.HATCH, base.eggMs + el);
    else state.ageMs = base.ageMs + el;
    if (state.asleep && !state.job) {
      const rate = state.lightsOff ? C.ENERGY.SLEEP_PER_H : C.ENERGY.NAP_PER_H;
      state.energy = Math.min(C.ENERGY.MAX, base.energy + rate * el / HOUR);
    }
  }
  /** Something the server will change soon (hatch, job end, nap end, evolution)? Fetch right away. */
  function dueSoon() {
    if (!state || state.dead) return false;
    if (state.stage === 'egg') return state.eggMs >= TT.HATCH - 250;
    if (state.job && state.simT >= state.job.endT) return true;
    if (state.napping && state.energy >= C.ENERGY.NAP_WAKE_AT) return true;
    const ev = Pet.evolvesIn(state);
    return ev != null && ev <= 0;
  }
  async function refresh() {
    if (!session || busy) return;
    try {
      const r = await Api.get('/api/state');
      if (r.status === 401 || (r.status === 200 && r.data.auth === false)) return authLost();
      if (r.status === 200) { if (offline) hideOffline(); applyView(r.data); }
    } catch (e) { if (e && e.offline) goOffline(e); }
  }
  function schedulePoll() {
    clearTimeout(pollTimer);
    if (!session) return;
    pollTimer = setTimeout(async () => { await refresh(); schedulePoll(); }, document.hidden ? 60000 : C.POLL_MS);
  }
  /** Send an action. Resolves to the server's answer ({ok:true,...}) or null when refused (a message is shown). */
  async function act(type, extra, opt) {
    if (busy || !session) return null;
    busy = true; renderHUD();
    try {
      const r = await Api.post('/api/act', Object.assign({ type }, extra || {}));
      if (r.status === 401) { authLost(); return null; }
      const d = r.data || {};
      if (d.state) applyView(d.state);
      if (!d.ok) { if (!(opt && opt.quiet)) showFail(d); return null; }
      return d;
    } catch (e) { if (e && e.offline) goOffline(e); return null; }
    finally { busy = false; renderHUD(); }
  }
  function showFail(d) {
    A.sfx('no');
    if (d.error === 'energy') return tiredPanel(d.msg);
    if (d.error === 'asleep') { refuseAnim(null); return toast("It's asleep.", d.napping ? 'Let it nap.' : 'Turn the lights on to wake it.'); }
    if (d.error === 'coins') return toast('Not enough coins.', 'Earn them: jobs, battles, daily care.');
    if (d.error === 'battle') return toast('Finish your battle first.');
    if (d.error === 'rate') return toast('Slow down a little.');
    toast(d.msg || 'Not now.');
  }
  function tiredPanel(msg) {
    const fullIn = (C.ENERGY.MAX - (state.energy || 0)) / C.ENERGY.SLEEP_PER_H * HOUR;
    confirmBox('TOO TIRED', [msg || 'Not enough energy.', 'Sleep recharges energy:', 'lights off +' + C.ENERGY.SLEEP_PER_H + '/h,', 'full in about ' + fmtDur(fullIn) + '.'],
      { label: 'SLEEP', fn: () => setLights(false) }, 'OK', 'tired');
  }

  // ---------------------------------------------------------------- events from the server
  function handleEvents(ev, bootLoad) {
    let evo = null;
    for (const e of ev) {
      switch (e.type) {
        case 'hatch': if (!bootLoad) hatchAnim(); break;
        case 'evolve':
          evo = evo ? { from: evo.from, to: e.to } : { from: e.from, to: e.to };
          notify('evolve', state.name + ' evolved into ' + formName(e.to) + '!');
          break;
        case 'call': case 'sick':
          if (now() - ui.lastCallBeep > 3000) { ui.lastCallBeep = now(); A.sfx('call'); }
          if (e.type === 'sick') notify('sick', state.name + ' is sick! It needs medicine.');
          else if (e.why === 'hunger') notify('hungry', state.name + ' is hungry!');
          break;
        case 'death':
          if (ui.search && ui.search.session) ui.search.session.cancel();
          ui.anim = null; ui.queue = []; ui.play = null; ui.battle = null; ui.search = null; ui.confirm = null; back();
          closePanels(); A.sfx('death');
          notify('death', state.name + ' has died.');
          break;
        case 'jobDone':
          notify('job', state.name + ' is back from ' + e.name + ': +' + e.coins + ' coins' + (e.ore ? ', +' + e.ore + ' ore' : '') + '.');
          if (!bootLoad) { A.sfx('win'); toast('Back from ' + e.name + '!', '+' + e.coins + ' coins' + (e.ore ? '  +' + e.ore + ' ore' : ''), 3500); }
          break;
        case 'gift': noticeAnim('Daily gift: day ' + e.day + ' of 7', '+' + e.coins + ' coins. Come back tomorrow!', 2600); A.sfx('ok'); break;
        case 'careBonus': noticeAnim('Care bonus!', '+' + e.coins + ' coins for good care yesterday.', 2600); break;
        case 'tired': if (!bootLoad && !state.job) toast('Out of energy!', state.name + ' dozes off to recharge.', 3200); break;
        case 'sleep': if (ui.mode === 'play') { ui.play = null; back(); } break;
      }
    }
    if (evo && ui.mode !== 'battle' && ui.mode !== 'search') evolveAnim(evo.from, evo.to);
  }

  // ---------------------------------------------------------------- browser notifications (only while the page is open)
  const Notify = {
    supported() { return typeof window.Notification === 'function'; },
    on() { return this.supported() && localStorage.getItem(NOTIFY_KEY) === '1' && Notification.permission === 'granted'; },
    label() {
      if (!this.supported()) return 'N/A';
      if (Notification.permission === 'denied') return 'BLOCKED';
      return this.on() ? 'ON' : 'OFF';
    },
    async toggle() {
      if (!this.supported()) return toast('Notifications', 'are not supported here.');
      if (this.on()) { localStorage.setItem(NOTIFY_KEY, '0'); return toast('Notifications off.'); }
      let p = Notification.permission;
      if (p === 'default') { try { p = await Notification.requestPermission(); } catch (e) { p = 'denied'; } }
      if (p === 'granted') { localStorage.setItem(NOTIFY_KEY, '1'); toast('Notifications on.', 'Only while this page is open.'); }
      else toast('Notifications blocked.', 'Allow them in the browser settings.');
    },
    last: {},
    show(key, body) {
      if (!this.on()) return;
      if (!document.hidden && document.hasFocus()) return;           // the bell already shows it
      const t = Date.now(); if (this.last[key] && t - this.last[key] < 5 * 60e3) return;
      this.last[key] = t;
      try { const n = new Notification('TAMA·PIX', { body, tag: 'tamapix-' + key }); n.onclick = () => { window.focus(); n.close(); }; } catch (e) { return; }
      notifyLog.push({ key, body, at: t });
    }
  };
  function notify(key, body) { Notify.show(key, body); }

  // ---------------------------------------------------------------- the meadow
  function updatePet(t) {
    const k = petKey(), b = sz(k), p = ui.pet;
    if (!hatched() || state.job) return;
    if (t >= ui.nextThink) {
      const d = T.Personality.think(state);
      p.move = d.move; ui.thought = d.thought;
      if (d.move === 'turn') p.dir *= -1;
      if (d.emote) { ui.emote = d.emote; ui.emoteUntil = t + 2600; }
      ui.nextThink = t + U.rand(3000, 6000);
    }
    if (state.asleep) { p.x = Math.round((rightLimit() - b.w) / 2); return; }
    if (t - p.lastStep > 450) {
      p.lastStep = t;
      if (p.move === 'walk' && t > ui.petted) { if (U.chance(0.06)) p.dir *= -1; p.x += p.dir * 2; }
    }
    const maxX = rightLimit() - b.w - 1;
    if (p.x > maxX) { p.x = maxX; p.dir = -1; }
    if (p.x < 2) { p.x = 2; p.dir = 1; }
  }

  function drawMain(t, noZones) {
    if (state.dead) return drawDead(t, noZones);
    if (state.stage === 'egg') {
      const b = sz('egg'), poked = t < ui.petted;
      const wob = poked || state.eggMs > TT.HATCH * 0.6 ? (blink(t, 120) ? 1 : -1) : 0;
      const x = Math.floor((W - b.w) / 2);
      drawPet('egg', x + wob, groundY('egg'), false);
      if (!noZones) zone(x - 8, groundY('egg') - 10, b.w + 16, b.h + 14, () => { ui.petted = now() + 800; }, null, 'pet');
      return;
    }
    drawPoops(t);
    if (state.job) {                                   // away at work: an empty meadow and a sign
      S.label('Away at work: ' + state.job.name, 6, UI.text);
      S.label(fmtDur(jobLeft()) + ' left. Tap to check.', 20, UI.dim);
      if (!noZones) zone(-20, -10, W + 40, H + 20, () => { ui.mode = 'jobs'; }, { x: 8, y: 3, w: W - 16, h: 30 }, 'away');
      return;
    }
    const key = petKey(), b = sz(key), p = ui.pet;
    const hop = !state.asleep && (p.move === 'hop' || t < ui.petted);
    const bob = hop ? (blink(t, 220) ? -2 : 0) : 0;
    drawPet(key, p.x, groundY(key) + bob, !state.asleep && p.dir > 0, state.asleep ? { frame: 2 } : null);
    if (state.lightsOff) S.overlay('rgba(3, 6, 24, 0.5)');
    if (state.asleep) {
      const k = Math.floor(t / 700) % 4;
      for (let i = 0; i < 3; i++) if (i <= k) S.text('z', p.x + b.w - 2 + i * 4, groundY(key) + 2 - i * 5, state.lightsOff ? '#7f8fb0' : '#aab6cc');
      if (state.napping && !noZones && t % 6000 < 3000) S.label('Exhausted: napping till energy ' + C.ENERGY.NAP_WAKE_AT, -20, UI.dim);
    } else {
      if (state.sick && blink(t, 600)) S.emote('e_skull', p.x - 7, groundY(key) + 2, EMOTE_COL.skull);
      if (state.fakeCall && blink(t, 500)) drawEmote('excl', p.x, groundY(key), b.w);
      else if (ui.emote && t < ui.emoteUntil) drawEmote(ui.emote, p.x, groundY(key), b.w);
    }
    if (noZones) return;
    zone(p.x - 4, groundY(key) - 6, b.w + 8, b.h + 8, () => {
      ui.petted = now() + 1400;
      ui.emote = state.asleep ? 'angry' : state.sick ? 'sweat' : (state.happy >= 2 ? U.pick(['heart', 'note']) : 'question');
      ui.emoteUntil = now() + 1800; ui.nextThink = now() + 2500;
    }, null, 'pet');
  }

  function drawDead(t, noZones) {
    const key = petKey(), b = sz(key), tb = sz('tomb');
    const tx = W - tb.w - 10;
    S.shadow(tx, FOOT + 1, tb.w); S.art('tomb', tx, FOOT - tb.h + 1);
    const bob = Math.round(Math.sin(t / 500) * 1.5);
    S.art(key, 10, FOOT - b.h - 8 + bob, { alpha: 0.45, frame: S.frame });
    if (noZones) return;
    if (t % 2400 < 1800) S.label('Rest in peace. Tap for a new egg.', -24, UI.dim);
    zone(-20, -40, W + 40, H + 40, () => confirmBox('NEW EGG?', ['Hatch a new egg?'], { label: 'YES', fn: newEgg }, 'NO', 'newegg'), { x: 0, y: -27, w: W, h: 13 }, 'dead');
  }

  // ---------------------------------------------------------------- small menus
  const FEED_OPTS = () => [
    { label: 'MEAL', icon: 'meat', fn: () => feed(false), id: 'meal' },
    { label: 'SNACK', icon: 'berry', fn: () => feed(true), id: 'snack' }];
  const LIGHT_OPTS = () => [
    { label: 'LIGHTS ON', note: state.lightsOff ? '' : 'ON', fn: () => setLights(true), id: 'lightsOn' },
    { label: 'LIGHTS OFF', note: state.lightsOff ? 'ON' : 'sleep', fn: () => setLights(false), id: 'lightsOff' }];
  const BATTLE_OPTS = () => [
    { label: 'RANDOM', note: E.COST.online + ' EN', fn: () => startBattle('find'), id: 'bRandom' },
    { label: 'VS CPU', note: E.COST.cpu + ' EN', fn: () => startBattle('cpu'), id: 'bCpu' },
    { label: 'FRIEND CODE', note: 'free', fn: openLinkPanel, id: 'bFriend' },
    { label: 'CHALLENGE', note: 'free', fn: openChallengePanel, id: 'bChallenge' }];

  // ---------------------------------------------------------------- main menu hub
  function menuRows() {
    const jobHint = state.job ? fmtDur(jobLeft()) : (eco && eco.lastJob && !eco.lastJob.seen ? 'DONE' : '');
    return [
      { icon: 'i_home', label: 'MEADOW', fn: () => back(), id: 'mMeadow' },
      { icon: 'i_battle', label: 'BATTLE', fn: () => { if (canAct('battle')) { ui.mode = 'battleMenu'; ui.sub = 0; } }, id: 'mBattle' },
      { icon: 'i_pick', iconCol: jobHint === 'DONE' ? UI.green : null, label: 'PIX TOWN JOBS', fn: () => { ui.mode = 'jobs'; ui.sub = 0; }, id: 'mJobs' },
      { icon: 'i_shop', label: 'SHOP', right: (eco ? eco.coins : 0) + 'c', fn: () => { ui.mode = 'shop'; ui.sub = 0; }, id: 'mShop' },
      { icon: 'i_status', label: 'STATUS', fn: () => { ui.mode = 'status'; ui.page = 0; }, id: 'mStatus' },
      { icon: 'i_help', label: 'HELP', fn: () => { ui.mode = 'help'; ui.page = 0; }, id: 'mHelp' },
      { icon: 'i_gear', label: 'SETTINGS', fn: () => { ui.mode = 'settings'; ui.sub = 0; }, id: 'mSettings' }];
  }
  function settingsRows() {
    const nl = Notify.label(), nb = nl === 'BLOCKED' ? 'NO' : nl === 'N/A' ? '--' : nl;
    return [
      { icon: A.muted ? 'i_mute' : 'i_sound', label: 'SOUND', btn: { label: A.muted ? 'OFF' : 'ON', fn: toggleMute, id: 'sSound', col: A.muted ? UI.dim : UI.accent } },
      { icon: 'i_attention', label: 'ALERTS', sub: 'notify', btn: { label: nb, fn: () => Notify.toggle(), id: 'sNotify', col: nb === 'ON' ? UI.accent : UI.dim } },
      { icon: 'i_status', label: 'ACCOUNT', sub: user ? (user.isGuest ? 'guest' : user.username) : '', btn: { label: 'OPEN', fn: openAccount, id: 'sAccount' } },
      { icon: 'i_back', label: 'LOG OUT', btn: { label: 'GO', fn: askLogout, id: 'sLogout' } }];
  }
  function askLogout() {
    if (user && user.isGuest) confirmBox('LOG OUT?', ['Guests cannot log back in!', 'Save as an account first', '(Settings > Account).'], { label: 'LOG OUT', fn: logout }, 'CANCEL', 'logout');
    else confirmBox('LOG OUT?', ['Your monster keeps living', 'on the server.'], { label: 'LOG OUT', fn: logout }, 'CANCEL', 'logout');
  }

  // ---------------------------------------------------------------- help (the numbers, published)
  function helpPage(i) {
    const EN = C.ENERGY, K = E.COINS, J = E.JOBS.map(j => j.name + ' ' + fmtDur(j.ms) + ': -' + j.energy + ' energy, ' + j.coins + 'c' + (j.ore ? ' +' + j.ore + ' ore' : ''));
    return [
      ['CARE', ['Care is always free. The bell shows what is wrong: tap it for quick fixes.', 'The ! button is discipline: scold only when it acts up for no reason.', 'The house button opens the main menu.']],
      ['ENERGY', ['Max ' + EN.MAX + '. Train -' + E.COST.train + ', CPU battle -' + E.COST.cpu + ', online -' + E.COST.online + ', friend battles free.',
                  'Sleep refills: lights off +' + EN.SLEEP_PER_H + '/h. At 0 it naps (+' + EN.NAP_PER_H + '/h) till ' + EN.NAP_WAKE_AT + '.', 'On-time care +' + EN.EARNBACK + ' (max ' + EN.EARNBACK_MAX + '/day).']],
      ['COINS', ['Jobs pay fixed coins. Battles: CPU win ' + K.cpuWin + ', online win ' + K.onlineWin + ' / loss ' + K.onlineLoss + ' (max ' + K.battleCapPerDay + '/day).',
                 'Level up +' + K.levelUp + ', evolve +' + K.evolve + ', good care all day +' + K.careBonus + '. Login gift ' + E.GIFT[0] + '-' + E.GIFT[E.GIFT.length - 1] + '.']],
      ['JOBS', J.concat(['The pet is away and gets hungry faster.'])],
      ['SHOP', E.SKUS.map(k => k.name + ' ' + k.price.coins + 'c: ' + k.desc)],
      ['XP', ['First ' + E.TAPER[0].upTo + ' energy actions a day: full XP, next ' + (E.TAPER[1].upTo - E.TAPER[0].upTo) + ' half, then a quarter.',
              'Level caps: baby ' + C.LEVEL_CAP.baby + ', day-2 form ' + C.LEVEL_CAP.teen + ', final ' + C.LEVEL_CAP.adult + '.', 'Friend battles: XP from ' + E.FRIEND_XP_PER_DAY + ' a day, no coins.']]
    ][i];
  }
  function drawPaged(t, title, lines, page, pages, onNext, id) {
    const b = S.bounds(), x = 3, w = W - 6, y = Math.max(b.top + 2, -66), h = Math.min(b.bottom - 2 - y, 150);
    S.panel(x, y, w, h);
    S.textMid(title, x + 5, y + 2, 11, UI.accent);
    const pg = (page + 1) + '/' + pages; S.textMid(pg, x + w - 5 - S.textW(pg), y + 2, 11, UI.dim);
    S.rule(x + 4, y + 14, w - 8);
    let ly = y + 18;
    for (const para of lines) { for (const ln of S.wrap(para, w - 12)) { if (ly < y + h - 16) S.text(ln, x + 6, ly, UI.text); ly += 8; } ly += 3; }
    for (let i = 0; i < pages; i++) S.rect(x + w / 2 - pages * 3 + i * 6, y + h - 8, 3, 3, i === page ? UI.accent : '#4a5366');
    if (blink(t, 500)) S.text('>', x + w - 10, y + h - 11, UI.accent);
    zone(-20, -90, W + 40, H + 140, onNext, { x: x + w - 14, y: y + h - 14, w: 10, h: 10 }, id);
  }

  // ---------------------------------------------------------------- status pages
  function evolveLine(s) {
    const left = Pet.evolvesIn(s);
    if (left == null) return T.FORMS[s.formId].secret ? 'Secret final form' : 'Final form';
    if (left <= 0) return 'Evolving...';
    return 'Evolves in ' + fmtDur(left);
  }
  function pips(x, y, n, max, col) {
    for (let i = 0; i < max; i++) { S.rect(x + i * 14, y, 12, 6, UI.edge); S.rect(x + i * 14 + 1, y + 1, 10, 4, i < n ? col : '#343b48'); }
  }
  function drawStatus(t) {
    const s = state, f = T.FORMS[s.formId];
    drawMain(t, true); dim();
    const x = 4, y = -58, w = 88, h = 106;
    S.panel(x, y, w, h);
    const titles = ['PROFILE', 'CARE', 'ENERGY', 'WALLET', 'RECORD'];
    S.textMid(titles[ui.page], x + 5, y + 2, 12, UI.accent);
    S.textMid((ui.page + 1) + '/' + STATUS_PAGES, x + w - 5 - S.textW('5/5'), y + 2, 12, UI.dim);
    S.rule(x + 4, y + 15, w - 8);
    const cx = x + 5, cy = y + 21, X = T.Battle, L = Pet.level(s);
    switch (ui.page) {
      case 0: {
        const k = petKey(), a = sz(k);
        if (s.stage !== 'egg') S.art(k, x + w - a.w - 5, y + 74 - a.h, { frame: S.frame });
        S.text(s.name, cx, cy, UI.text);
        S.text(f.name, cx, cy + 10, UI.accent);
        S.text('Lv ' + L + ' / ' + E.levelCap(s.stage), cx, cy + 22, UI.text);
        const lo = X.xpFor(L), hi = X.xpFor(L + 1), pr = L >= X.XP.MAX_LEVEL ? 1 : (s.xp - lo) / Math.max(1, hi - lo);
        bar(cx, cy + 31, 34, pr, UI.blue);
        S.text('XP ' + s.xp, cx, cy + 38, UI.dim);
        S.text('Age ' + fmtDur(s.ageMs), cx, cy + 48, UI.dim);
        S.rect(x + 5, y + 78, w - 10, 1, UI.inner);
        S.text(evolveLine(s), cx, y + 83, Pet.evolvesIn(s) == null ? UI.dim : UI.text);
        break;
      }
      case 1:
        S.text('Hunger', cx, cy, UI.dim); pips(cx, cy + 9, s.hunger, 4, UI.accent);
        S.text('Mood', cx, cy + 20, UI.dim); pips(cx, cy + 29, s.happy, 4, UI.blue);
        S.text('Weight ' + s.weight + '   Mistakes ' + s.careMistakes, cx, cy + 42, UI.dim);
        S.text(s.sick ? 'Sick!' : s.poops.length ? 'Needs cleaning' : 'Healthy', cx, cy + 54, s.sick ? UI.red : UI.text);
        break;
      case 2: {
        const EN = C.ENERGY;
        S.text('Energy ' + energy() + ' / ' + EN.MAX, cx, cy, UI.text);
        bar(cx, cy + 10, 72, (s.energy || 0) / EN.MAX, UI.yellow);
        const st = s.job ? 'At work' : s.asleep ? (s.lightsOff ? 'Sleeping +' + EN.SLEEP_PER_H + '/h' : 'Napping +' + EN.NAP_PER_H + '/h') : 'Awake';
        S.text(st, cx, cy + 20, UI.text);
        const full = (EN.MAX - (s.energy || 0)) / EN.SLEEP_PER_H * HOUR;
        S.text(s.energy >= EN.MAX ? 'Full.' : 'Lights off: full in ' + fmtDur(full), cx, cy + 32, UI.dim);
        S.text('XP now x' + (eco ? eco.taperMult : 1) + ' (' + (eco ? eco.daily.actions : 0) + ' actions)', cx, cy + 44, UI.dim);
        S.text('Fizz today ' + (eco ? eco.daily.drinks : 0) + '/' + E.sku('fizz').perDay, cx, cy + 54, UI.dim);
        break;
      }
      case 3: {
        const inv = (eco && eco.inventory) || {};
        S.text('Coins ' + (eco ? eco.coins : 0), cx, cy, UI.accent);
        S.text('Ore ' + (inv.ore || 0), cx, cy + 10, UI.text);
        S.text('Pickaxe ' + ['I', 'II', 'III'][(inv.pickaxe || 1) - 1] + ' (+' + Math.round(E.workBonus(inv) * 100) + '%)', cx, cy + 20, UI.text);
        S.text('Battle coins today', cx, cy + 32, UI.dim);
        S.text((eco ? eco.daily.battleCoins : 0) + ' / ' + E.COINS.battleCapPerDay, cx, cy + 41, UI.dim);
        S.text('Login gift day ' + (((eco && eco.gift.idx) || 0) || 7) + '/7', cx, cy + 52, UI.dim);
        break;
      }
      case 4: {
        const st = s.st || {};
        S.text('Wins ' + s.wins + '  Losses ' + (s.battles - s.wins), cx, cy, UI.text);
        S.text('Training ' + s.training, cx, cy + 10, UI.text);
        S.text('This stage: W' + (st.wins || 0) + ' L' + (st.losses || 0), cx, cy + 22, UI.dim);
        S.text('Discipline ' + s.discipline + '%', cx, cy + 32, UI.dim);
        if (f.move) S.text('Move: ' + f.move, cx, cy + 44, UI.dim);
        if (f.special) S.text('Special: ' + f.special.name, cx, cy + 54, UI.dim);
        break;
      }
    }
    for (let i = 0; i < STATUS_PAGES; i++) S.rect(x + w / 2 - 12 + i * 6, y + h - 8, 3, 3, i === ui.page ? UI.accent : '#4a5366');
    if (blink(t, 500)) S.text('>', x + w - 10, y + h - 11, UI.accent);
    zone(-20, -90, W + 40, H + 140, nextStatusPage, { x: x + w - 14, y: y + h - 14, w: 10, h: 10 }, 'status');
  }
  function nextStatusPage() { ui.page++; if (ui.page >= STATUS_PAGES) back(); }

  // ---------------------------------------------------------------- discipline ("!")
  function drawDiscipline(t) {
    drawMain(t, true); dim();
    const b = S.bounds(), x = 3, w = W - 6, y = Math.max(b.top + 2, -58), h = 104;
    S.panel(x, y, w, h);
    S.textMid('DISCIPLINE', x + 5, y + 2, 11, UI.accent);
    S.rule(x + 4, y + 14, w - 8);
    S.text('Obedience ' + state.discipline + '%', x + 5, y + 19, UI.text);
    bar(x + 6, y + 28, w - 12, state.discipline / 100, UI.green);
    const acting = state.fakeCall;
    S.text(acting ? 'Acting up now? YES!' : 'Acting up now? No.', x + 6, y + 37, acting ? UI.red : UI.dim);
    const help = ui.discMsg || 'When it calls for no reason (a ! over it), scold it. Scolding a good monster makes it sad.';
    S.wrap(help, w - 12).slice(0, 4).forEach((ln, i) => S.text(ln, x + 6, y + 48 + i * 8, ui.discMsg ? UI.accent : UI.dim));
    const bw = 38, by = y + h - 18;
    S.button(x + 6, by, bw, 14, 'SCOLD', acting, acting ? UI.accent : UI.text);
    S.button(x + w - 6 - bw, by, bw, 14, 'BACK');
    zone(x + 2, by - 3, bw + 8, 20, doScold, { x: x + 6, y: by, w: bw, h: 14 }, 'scold');
    zone(x + w - 10 - bw, by - 3, bw + 8, 20, back, { x: x + w - 6 - bw, y: by, w: bw, h: 14 }, 'discBack');
  }

  // ---------------------------------------------------------------- shop
  function shopRows() {
    const inv = (eco && eco.inventory) || {}, coins = eco ? eco.coins : 0, d = (eco && eco.daily) || {};
    return E.SKUS.map(k => {
      const price = k.price.coins, poor = coins < price;
      let sub = k.short || k.desc, dimRow = false, right = null;
      if (k.kind === 'drink') {
        const left = k.perDay - (d.drinks || 0);
        sub = '+' + k.energy + ' EN · ' + (left > 0 ? left + ' left' : 'sold out');
        if (left <= 0) dimRow = true;
      }
      if (k.kind === 'tool' && (inv[k.tool] || 1) >= k.tier) { right = 'OWNED'; dimRow = true; }
      const row = { label: k.name, sub, dim: dimRow, id: 'sku_' + k.id };
      if (right) row.right = right;
      else row.btn = { label: price + 'c', dim: poor || dimRow, fn: () => askBuy(k), id: 'buy_' + k.id };
      return row;
    });
  }
  function askBuy(k) {
    const d = (eco && eco.daily) || {};
    if (k.kind === 'drink' && (d.drinks || 0) >= k.perDay) { A.sfx('no'); return toast("Enough fizz for today!", 'The limit resets at midnight.'); }
    if (eco.coins < k.price.coins) { A.sfx('no'); return toast('Not enough coins (' + eco.coins + '/' + k.price.coins + ').', 'Earn them: jobs, battles, daily care.'); }
    confirmBox('BUY?', [k.name + ' for ' + k.price.coins + ' coins?', k.desc, 'You have ' + eco.coins + ' coins.'], { label: 'BUY', fn: () => buy(k) }, 'CANCEL', 'buy');
  }
  async function buy(k) {
    const d = await act('buy', { sku: k.id });
    if (!d) return;
    A.sfx('ok');
    if (k.kind === 'drink') { toast('Glug glug! +' + k.energy + ' energy.', d.drinksLeft + ' fizz left today.'); }
    else if (k.kind === 'food') { back(); eatAnim(k.hunger ? 'meat' : 'berry', 'ok'); }
    else toast(k.name + ' bought!', k.desc);
  }

  // ---------------------------------------------------------------- Pix Town Jobs (the mine)
  function jobRows() {
    return E.JOBS.map(j => {
      const ok = j.stages.includes(state.stage), pay = E.jobPay(j, eco && eco.inventory);
      const row = { label: j.name + ' ' + fmtDur(j.ms), sub: ok ? '-' + j.energy + ' EN  +' + pay + 'c' : (j.stages[0] === 'adult' ? 'Final forms only' : 'Unlocks at day 2'), dim: !ok, id: 'job_' + j.id };
      if (ok) row.btn = { label: 'GO', dim: energy() < j.energy, fn: () => askJob(j), id: 'go_' + j.id };
      return row;
    });
  }
  function askJob(j) {
    if (!canAct('play', true)) return;
    const pay = E.jobPay(j, eco.inventory);
    confirmBox(j.name + '?', [j.desc, 'Away ' + fmtDur(j.ms) + ', -' + j.energy + ' energy.', 'Pays ' + pay + ' coins' + (j.ore ? ' + ' + j.ore + ' ore' : '') + '.', 'Gets hungry faster at work.'],
      { label: 'SEND', fn: () => startJob(j) }, 'NO', 'job');
  }
  async function startJob(j) {
    const d = await act('job_start', { id: j.id });
    if (d) { A.sfx('ok'); toast(state.name + ' heads to work!', 'Back in ' + fmtDur(j.ms) + '.'); }
  }
  function askRecall() {
    confirmBox('RECALL?', ['Bring it home now?', 'No pay, and the energy', 'is not refunded.'], { label: 'RECALL', fn: async () => { const d = await act('job_recall'); if (d) toast(state.name + ' came home.', 'No pay this time.'); } }, 'NO', 'recall');
  }
  function drawJobs(t) {
    const b = S.bounds();
    // the cart rolls in and out of the mine while the pet is working
    const cartY = FOOT - 9;
    if (state.job) {
      const ph = (t / 5200) % 1, cx = ph < 0.5 ? Math.round(64 - ph * 2 * 58) : Math.round(6 + (ph - 0.5) * 2 * 58);
      drawCart(cx, cartY, ph < 0.5);
    } else {
      drawCart(28, cartY, false);
      if (hatched()) { const k = petKey(), a = sz(k); drawPet(k, 6, groundY(k), true); if (a.w > 26) {} }
    }
    const lj = eco && eco.lastJob;
    if (state.job) {
      const j = state.job, x = 3, w = W - 6, y = Math.max(b.top + 2, -60), h = 72, total = (j.endT - j.startT) || 1;
      S.panel(x, y, w, h);
      S.textMid('AT WORK', x + 5, y + 2, 11, UI.accent);
      S.textMid(j.name, x + w - 5 - S.textW(j.name), y + 2, 11, UI.text);
      S.rule(x + 4, y + 14, w - 8);
      bar(x + 5, y + 18, w - 10, 1 - jobLeft() / total, UI.accent);
      S.text('Back in ' + fmtDur(jobLeft()), x + 5, y + 27, UI.text);
      S.text('Pays ' + j.pay + 'c' + (j.ore ? ' +' + j.ore + ' ore' : ''), x + 5, y + 36, UI.dim);
      S.text('Gets hungry faster.', x + 5, y + 45, UI.dim);
      S.button(x + w - 46, y + h - 16, 40, 13, 'RECALL');
      zone(x + w - 50, y + h - 19, 48, 18, askRecall, { x: x + w - 46, y: y + h - 16, w: 40, h: 13 }, 'recall');
    } else if (lj && !lj.seen) {
      const x = 8, w = W - 16, y = Math.max(b.top + 4, -50), h = 46;
      S.panel(x, y, w, h, UI.accent);
      S.textC('SHIFT DONE!', y + 6, UI.accent, x, w);
      S.textC(lj.name + ': +' + lj.coins + 'c' + (lj.ore ? ' +' + lj.ore + ' ore' : ''), y + 17, UI.text, x, w);
      S.button(x + w / 2 - 16, y + h - 18, 32, 14, 'OK', true);
      zone(x, y + h - 22, w, 22, () => act('job_seen', null, { quiet: true }), { x: x + w / 2 - 16, y: y + h - 18, w: 32, h: 14 }, 'jobSeen');
    } else {
      drawRows('PIX TOWN JOBS', jobRows(), { y: Math.max(b.top + 2, -72), rowH: 18 });
    }
  }
  function drawCart(x, y, full) {
    S.rect(x, y, 14, 7, '#4a3a2c'); S.rect(x + 1, y + 1, 12, 5, '#6b5440'); S.rect(x, y, 14, 1, '#8a7258');
    if (full) { S.rect(x + 2, y - 2, 4, 2, '#8d8f99'); S.rect(x + 6, y - 3, 5, 3, '#b0a070'); S.rect(x + 9, y - 1, 3, 1, '#7d808a'); }
    S.rect(x + 2, y + 7, 3, 2, '#22262e'); S.rect(x + 9, y + 7, 3, 2, '#22262e');
  }

  // ---------------------------------------------------------------- confirm dialog + toast
  function drawConfirm() {
    const c = ui.confirm, b = S.bounds();
    dim();
    const x = 6, w = W - 12, lines = [].concat(...c.lines.map(l => S.wrap(l, w - 12)));
    const h = 36 + lines.length * 9, y = Math.max(b.top + 2, Math.round((b.top + b.bottom) / 2 - h / 2) - 10);
    S.panel(x, y, w, h, UI.accent);
    S.textMid(c.title, x + 5, y + 2, 11, UI.accent);
    S.rule(x + 4, y + 14, w - 8);
    lines.forEach((l, i) => S.text(l, x + 5, y + 18 + i * 9, UI.text));
    const bw = 36, by = y + h - 17;
    const hi = ui.lastInput === 'key';
    S.button(x + 5, by, bw, 13, c.yes.label, hi && ui.sub === 0, UI.accent);
    S.button(x + w - 5 - bw, by, bw, 13, c.no, hi && ui.sub === 1);
    const yes = () => { ui.confirm = null; c.yes.fn(); }, no = () => { ui.confirm = null; };
    zone(-20, -200, W + 40, 400, () => {}, null, null);                // swallow taps outside
    zone(x + 1, by - 4, bw + 8, 21, yes, { x: x + 5, y: by, w: bw, h: 13 }, c.id + 'Yes');
    zone(x + w - 9 - bw, by - 4, bw + 8, 21, no, { x: x + w - 5 - bw, y: by, w: bw, h: 13 }, c.id + 'No');
    ui.rows = [{ fn: yes }, { fn: no }];
  }
  function drawToast(t) {
    const q = ui.toast; if (!q || t > q.until) { ui.toast = null; return; }
    const b = S.bounds(), l2 = (q.l2 ? S.wrap(q.l2, W - 12) : []).slice(0, 3), h = 14 + l2.length * 9, y = b.bottom - h - 2;
    S.panel(0, y, W, h);
    S.textMid(fitText(q.l1, W - 12), 5, y + 1, l2.length ? 11 : h - 2, UI.accent);
    l2.forEach((ln, i) => S.text(ln, 5, y + 14 + i * 9, UI.text));
  }

  // ---------------------------------------------------------------- care actions (server-validated)
  function canAct(name, quiet) {
    const no = (l1, l2) => { if (!quiet || true) { A.sfx('no'); toast(l1, l2); } return false; };
    if (!state || !session) return false;
    if (state.dead) return no('Your monster has died.', 'Tap the meadow for a new egg.');
    if (state.stage === 'egg') return no("It's still an egg.", 'It hatches in ' + fmtDur(TT.HATCH - state.eggMs) + '.');
    if (state.job && name !== 'status') return no('Away at work (' + state.job.name + ').', 'Back in ' + fmtDur(jobLeft()) + '. Recall it from Pix Town Jobs.');
    if (state.asleep && name !== 'light' && name !== 'discipline') {
      refuseAnim(null);
      return no("It's asleep.", state.napping ? 'Exhausted: napping till energy ' + C.ENERGY.NAP_WAKE_AT + '.' : 'Turn the lights on to wake it.');
    }
    if (state.sick && (name === 'play' || name === 'battle')) { refuseAnim(null); return no("It's sick.", 'Give it medicine first.'); }
    return true;
  }
  async function feed(snack) {
    back();
    const d = await act('feed', { snack: !!snack });
    if (!d) return;
    eatAnim(snack ? 'berry' : 'meat', d.result);
    if (d.energy) toast('Right on time!', '+' + d.energy + ' energy for good care.');
  }
  async function setLights(on) {
    back();
    const d = await act('lights', { on: !!on });
    if (!d) return;
    A.sfx('ok');
    if (d.result === 'sleep') toast('Lights off. Sleep tight.', 'Recharging +' + C.ENERGY.SLEEP_PER_H + ' energy an hour.');
    else if (d.result === 'wake') toast(state.name + ' wakes up.', 'Energy ' + energy() + '.');
  }
  async function doClean() {
    const old = state.poops.slice();
    const d = await act('clean');
    if (!d) return;
    cleanAnim(old);
    if (d.result === 'none') toast('Nothing to clean.');
    else if (d.energy) toast('Nice and tidy!', '+' + d.energy + ' energy for good care.');
  }
  async function doMedicine() {
    const d = await act('medicine');
    if (!d) return;
    medicineAnim(d.result);
    if (d.result === 'refuse') toast("It isn't sick.");
    else if (d.result === 'dose') toast('One more dose needed.');
  }
  async function doScold() {
    const d = await act('scold');
    if (!d) return;
    scoldAnim(d.result);
    ui.discMsg = d.result === 'ok' ? 'Good call! Obedience ' + d.before + '% > ' + d.discipline + '%.' + (d.energy ? ' +' + d.energy + ' energy.' : '')
      : 'That was unfair: it was behaving. Mood -1.';
  }
  async function newEgg() {
    const d = await act('new_egg');
    if (d) { ui = Object.assign(freshUI(), { lastInput: ui.lastInput }); A.sfx('ok'); }
  }

  // ---------------------------------------------------------------- care animations
  function eatAnim(food, result) {
    const key = petKey(), fb = sz(food);
    if (result === 'refuse') { toast("It's full."); return refuseAnim(food); }
    A.sfx('eat');
    startAnim(2400, (t, pr) => {
      const bite = Math.min(3, Math.floor(pr * 4));
      const px = Math.floor(W / 2) - 4, fx = px - fb.w - 1, fy = FOOT - fb.h + 1;
      if (bite < 3) S.art(food, fx, fy, { clipX: 0, frame: 0, alpha: 1 - bite * 0.25 });
      drawPet(key, px, groundY(key) + (blink(t, 300) ? 0 : 1), false);
      if (Math.floor(t / 600) !== Math.floor((t - 100) / 600)) A.sfx('eat');
    }, () => { if (result === 'sick') { ui.emote = 'skull'; ui.emoteUntil = now() + 2500; toast('Too many snacks!', 'It got sick.'); } });
  }
  function refuseAnim(prop) {
    if (!hatched() || state.job) return;
    A.sfx('no');
    const key = petKey(), b = sz(key);
    startAnim(1400, (t) => {
      const x = Math.floor((W - b.w) / 2);
      drawPet(key, x + (blink(t, 120) ? 1 : -1), groundY(key), false, state.asleep ? { frame: 2 } : null);
      if (prop) { const a = sz(prop); S.art(prop, 4, FOOT - a.h + 1); }
      drawEmote(state.asleep ? 'zzz' : 'angry', x, groundY(key), b.w);
    });
  }
  function happyAnim(emote, ms) {
    A.sfx('happy');
    const key = petKey(), b = sz(key);
    startAnim(ms || 1500, (t) => {
      const x = Math.floor((W - b.w) / 2);
      drawPet(key, x, groundY(key) - (blink(t, 250) ? 2 : 0), false);
      if (emote) drawEmote(emote, x, groundY(key), b.w);
    });
  }
  function cleanAnim(oldPoops) {
    const key = petKey(), had = oldPoops.length;
    A.sfx('ok');
    startAnim(1500, (t, pr) => {
      const wx = Math.floor(pr * (W + 16)) - 8;
      oldPoops.forEach((p, i) => { const [x, y] = poopSlot(i); if (i < 4 && x < W - wx) S.art('dung', x, y); });
      drawPet(key, ui.pet.x, groundY(key), false);
      for (let y = FOOT - 14; y <= FOOT; y++) {
        const o = (y >> 1) % 2;
        S.rect(W - wx - o, y, 2, 1, 'rgba(190,210,225,0.8)'); S.rect(W - wx + 2 - o, y, 3, 1, 'rgba(190,210,225,0.3)');
      }
    }, () => { if (had) happyAnim('note', 1200); });
  }
  function medicineAnim(result) {
    if (result === 'refuse') return refuseAnim('potion');
    A.sfx('ok');
    const key = petKey(), b = sz(key), pb = sz('potion');
    startAnim(1700, (t, pr) => {
      const px = Math.floor((W - b.w) / 2); drawPet(key, px, groundY(key), false);
      if (pr < 0.7) S.art('potion', px + b.w / 2 - pb.w / 2, groundY(key) - pb.h - 4 + pr * 10, { alpha: 1 - pr });
      else drawSparkles(t, px + b.w / 2, groundY(key) + b.h / 2);
    }, () => {
      if (result === 'cured') happyAnim('heart', 1400);
      else { ui.emote = 'sweat'; ui.emoteUntil = now() + 2000; }
    });
  }
  function scoldAnim(result) {
    const key = petKey(), b = sz(key);
    A.sfx(result === 'ok' ? 'ok' : 'no');
    startAnim(1500, (t, pr) => {
      const x = Math.floor((W - b.w) / 2) + 8;
      drawPet(key, x, groundY(key), false);
      if (blink(t, 200)) S.label('!', 10, UI.red, 14);
      if (pr > 0.5) drawEmote(result === 'ok' ? 'sweat' : 'angry', x, groundY(key), b.w);
    });
  }
  function noticeAnim(line1, line2, ms, onEnd) {
    startAnim(ms || 2000, (t) => {
      drawMain(t, true);
      const L = battleLayout();
      S.panel(0, L.tb, W, 38);
      if (t > 150) S.wrap(line1, W - 12).slice(0, 1).forEach((ln) => S.text(ln, 6, L.tb + 6, UI.accent));
      if (line2 && t > 500) S.wrap(line2, W - 12).slice(0, 2).forEach((ln, i) => S.text(ln, 6, L.tb + 16 + i * 10, UI.text));
    }, onEnd);
  }
  function hatchAnim() {
    A.sfx('hatch');
    startAnim(2600, (t, pr) => {
      const e = sz('egg'), ex = Math.floor((W - e.w) / 2), ey = groundY('egg'), wob = blink(t, 90) ? 1 : -1;
      if (pr < 0.65) {
        drawPet('egg', ex + wob, ey, false);
        if (pr > 0.35) for (let i = 2; i < e.w - 2; i++) S.rect(ex + i + wob, ey + 9 + (i % 2), 1, 1, T.Monsters.GLOW.cyan);
      } else if (pr < 0.75) {
        S.overlay('rgba(230,240,255,0.85)');
      } else {
        const key = petKey(), b = sz(key), x = Math.floor((W - b.w) / 2);
        drawPet(key, x, groundY(key), false);
        drawSparkles(t, x + b.w / 2, groundY(key) + b.h / 2);
      }
    });
  }
  function evolveAnim(from, to) {
    startAnim(3800, (t, pr) => {
      const fk = petKey(from), tk = petKey(to), ob = sz(fk), nb = sz(tk);
      const cx = (b) => Math.floor((W - b.w) / 2);
      dim();
      if (pr < 0.62) {
        const period = 320 - 270 * (pr / 0.62);
        if (Math.floor(t / period) % 2) S.art(tk, cx(nb), groundY(tk), { silhouette: '#e8eef8' });
        else S.art(fk, cx(ob), groundY(fk), { silhouette: '#e8eef8' });
        if (t < 1400) S.label('What? ' + formName(from) + ' is evolving!', -24, UI.text);
      } else if (pr < 0.7) {
        S.overlay(blink(t, 60) ? 'rgba(240,244,255,0.95)' : 'rgba(240,244,255,0.5)');
      } else {
        drawPet(tk, cx(nb), groundY(tk), false);
        drawSparkles(t, W / 2, groundY(tk) + nb.h / 2);
        S.label(formName(from) + ' became ' + T.FORMS[to].name + '!', -24, UI.accent);
      }
    }, null, () => A.sfx('evolve'));
  }

  // ---------------------------------------------------------------- training (the server hides the dodges)
  async function startPlay() {
    back();
    const d = await act('train_start');
    if (!d) return;
    ui.mode = 'play';
    ui.play = { round: 1, score: 0, phase: 'wait', t0: now(), guess: null, dir: null, mult: d.mult };
  }
  async function playGuess(g) {
    const P = ui.play;
    if (!P || P.phase !== 'wait') return;
    P.phase = 'sending'; P.guess = g;
    const d = await act('train_guess', { round: P.round, g });
    if (ui.play !== P) return;
    if (!d) { ui.play = null; back(); return; }
    P.dir = d.dir; P.hit = d.hit; P.score = d.hits; P.done = d.done; P.gain = d.gain || null;
    P.phase = 'reveal'; P.t0 = now();
    A.sfx(P.hit ? 'ok' : 'no');
  }
  function drawPlay(t) {
    const P = ui.play, key = petKey(), b = sz(key), cx = Math.floor((W - b.w) / 2);
    S.label('TRAINING  ' + P.round + '/5   HITS ' + P.score, -26, UI.text);
    if (P.phase === 'wait' || P.phase === 'sending') {
      drawPet(key, cx, groundY(key), false);
      const hl = ui.lastInput === 'key' && blink(t, 500);
      S.button(0, 8, 16, 24, '<', hl); S.button(W - 16, 8, 16, 24, '>', ui.lastInput === 'key' && !hl);
      S.textC('Which way will it dodge?', -10, UI.dim);
      zone(-20, -40, W / 2 + 20, H + 60, () => playGuess(-1), { x: 0, y: 8, w: 16, h: 24 }, 'left');
      zone(W / 2, -40, W / 2 + 20, H + 60, () => playGuess(1), { x: W - 16, y: 8, w: 16, h: 24 }, 'right');
    } else if (P.phase === 'reveal') {
      const el = t - P.t0, x = cx + P.dir * 16;
      drawPet(key, x, groundY(key) - (P.hit && blink(t, 200) ? 2 : 0), P.dir > 0);
      if (el > 300) drawEmote(P.hit ? 'heart' : 'sweat', x, groundY(key), b.w);
      if (el > 1300) {
        if (P.done) { P.phase = 'done'; P.t0 = t; P.result = P.gain ? P.gain.result : 'lose'; A.sfx(P.result === 'win' ? 'win' : 'lose'); }
        else { P.round++; P.phase = 'wait'; }
      }
    } else {
      const g = P.gain || { xp: 0 };
      drawPet(key, cx, groundY(key) - (P.result === 'win' && blink(t, 200) ? 2 : 0), false);
      S.label(P.result === 'win' ? 'Good session!' : 'Sloppy today...', -18, P.result === 'win' ? UI.green : UI.red);
      S.label('+' + g.xp + ' XP' + (g.levelUp ? '   Lv ' + g.level + '!' : '') + (g.capped ? '  (level cap)' : ''), -2, g.levelUp ? UI.accent : UI.text);
      if (g.mult != null && g.mult < 1) S.label('Tired: XP x' + g.mult + ' today', 12, UI.dim);
      if (t - P.t0 > 2400) { ui.play = null; back(); }
    }
  }

  // ---------------------------------------------------------------- battles (all run on the server, over the socket)
  /* ui.battle = { kind:'cpu'|'friend'|'online', me, opp (display: {card,hp,max}), phase, queue, driver, role, cur }
   * phase: found -> intro -> idle/choose/wait/anim ... -> end. Server messages push events into B.queue:
   *   {type:'turn', role:'atk'|'def'}  {type:'result', attacker:'me'|'opp', res, hp:{me,opp}}  {type:'end', won, reason, gain} */
  const ANIM_MS = 1900;
  function newBattle(kind, meView, oppView, driver) {
    const B = { kind, me: meView, opp: oppView, phase: kind === 'online' ? 'found' : 'intro', t0: now(), queue: [], driver, role: null, cur: null };
    ui.battle = B; ui.mode = 'battle'; ui.anim = null; ui.queue = []; ui.confirm = null;
    A.sfx('ok');
    return B;
  }
  function startBattle(kind, payload) {
    if (kind !== 'accept' && !canAct('battle')) return;
    if (!Net.url()) return toast('Offline.', 'Battles need the server.');
    back(); ui.mode = 'search';
    const Q = ui.search = { t0: now(), kind, B: null, session: null };
    Q.session = Net.battle(kind, payload, handlersFor(Q));
  }
  function handlersFor(Q) {
    const alive = () => Q.B && ui.battle === Q.B;
    return {
      onMatched(m) {
        if (ui.search !== Q) { Q.session.leave(); return; }
        ui.search = null; closePanels();
        const view = (v) => ({ card: v.card, hp: v.hp, max: v.max });
        const kind = m.kind === 'online' ? 'online' : m.kind === 'cpu' ? 'cpu' : 'friend';
        Q.B = newBattle(m.ghost || kind !== 'online' ? kind : 'online', view(m.you), view(m.opp), {
          move: (dir) => Q.session.move(dir), leave: () => Q.session.leave() });
        Q.B.ghost = !!m.ghost; Q.B.live = !m.ghost && kind !== 'cpu';
      },
      onTurn(m) { if (alive()) Q.B.queue.push({ type: 'turn', role: m.role }); },
      onResult(m) { if (alive()) Q.B.queue.push({ type: 'result', attacker: m.attacker === 'you' ? 'me' : 'opp', res: m.res, hp: { me: m.hp.you, opp: m.hp.opp } }); },
      onEnd(m) {
        if (!alive()) return;
        Q.B.queue.push(m.result === 'lost' ? { type: 'end', won: false, reason: 'lost' } : { type: 'end', won: m.result === 'win', reason: m.reason, gain: m.gain });
      },
      onFail(why, msg) {
        if (ui.search !== Q) return;
        ui.search = null; back(); A.sfx('no');
        if (why === 'nomatch') { ui.fallbackReason = why; noticeAnim('No rival online right now.', 'A wild monster appears instead!', 2200, () => startBattle('cpu')); }
        else if (why === 'offline') toast('Offline.', 'Battles need the server.');
        else if (why === 'rejected:energy') tiredPanel(msg);
        else toast(msg || 'The server refused.');
        refresh();
      }
    };
  }
  /** A challenger gets pulled into a live battle when the other player accepts. */
  function incomingBattle(m, s) {
    if (ui.search && ui.search.session && ui.search.session !== s) ui.search.session.cancel();
    ui.play = null; ui.anim = null; ui.queue = []; ui.confirm = null; closePanels();
    const Q = ui.search = { t0: now(), kind: 'accept', B: null, session: s };
    s.h = handlersFor(Q);
  }
  function battleMove(dir) {
    const B = ui.battle;
    if (!B || B.phase !== 'choose') return;
    B.phase = 'wait'; B.t0 = now();
    B.driver.move(dir);
  }
  function fleeBattle() {
    const B = ui.battle;
    if (!B || B.phase === 'end') return;
    if (B.driver) B.driver.leave();
    finishBattle(B, false, 'fled', null);
  }
  function finishBattle(B, won, reason, gain) {
    B.phase = 'end'; B.won = won; B.reason = reason; B.t0 = now(); B.gain = gain || null;
    A.sfx(reason === 'lost' ? 'no' : won ? 'win' : 'lose');
    setTimeout(refresh, 400);
  }
  function battleStep(t) {
    const B = ui.battle;
    if (B.phase === 'found' && t - B.t0 > 1300) { B.phase = 'intro'; B.t0 = t; }
    if (B.phase === 'intro' && t - B.t0 > 1800) { B.phase = 'idle'; B.t0 = t; }
    if (B.phase === 'anim' && t - B.t0 > ANIM_MS) { B.me.hp = B.cur.hp.me; B.opp.hp = B.cur.hp.opp; B.phase = 'idle'; B.t0 = t; }
    if ((B.phase === 'idle' || B.phase === 'wait') && B.queue.length) {
      const e = B.queue.shift();
      if (e.type === 'turn') { B.phase = 'choose'; B.role = e.role; B.t0 = t; }
      else if (e.type === 'result') { B.phase = 'anim'; B.cur = e; B.t0 = t; B.from = { me: B.me.hp, opp: B.opp.hp }; A.sfx('shoot'); }
      else if (e.type === 'end') finishBattle(B, e.won, e.reason, e.gain);
    }
    if (B.phase === 'end' && t - B.t0 > 3600) { ui.battle = null; back(); }
  }
  function battleLayout() {
    const b = S.bounds(), top = b.top, tb = b.bottom - 40;
    return { top, tb, pcx: 21, pcy: tb - 6, ocx: 70, ocy: top + Math.max(52, Math.min(70, Math.round((tb - top) * 0.5))) };
  }
  function plate(x, y, w, f, hp, nums, right) {
    const name = formName(f.card.formId), lv = 'Lv' + T.Battle.level(f.card);
    const need = S.textW(name) + 10;
    if (need > w) { if (right) x -= need - w; w = need; }
    S.panel(x, y, w, 30);
    S.text(name, x + 5, y + 4, UI.text);
    S.hpBar(x + 5, y + 13, w - 10, hp, f.max);
    S.text(lv, x + 5, y + 21, UI.dim);
    if (nums) { const n = Math.ceil(hp * 10) + '/' + f.max * 10; S.text(n, x + w - 5 - S.textW(n), y + 21, UI.text); }
  }
  function textBox(L, lines, color) {
    S.panel(0, L.tb, W, 38);
    lines.slice(0, 3).forEach((ln, i) => S.text(ln, 6, L.tb + 6 + i * 10, color || UI.text));
  }
  function msgLines(s) { return S.wrap(s, W - 12); }

  function drawBattle(t) {
    battleStep(t);
    const B = ui.battle;
    if (!B) return drawMain(t);
    const L = battleLayout(), el = t - B.t0;
    const mk = petKey(B.me.card.formId), ok = petKey(B.opp.card.formId), mb = sz(mk), ob = sz(ok);
    const myName = formName(B.me.card.formId), opName = formName(B.opp.card.formId), foe = 'Foe ' + opName;
    let myX = L.pcx - Math.floor(mb.w / 2), myY = L.pcy - mb.h + 2, opX = L.ocx - Math.floor(ob.w / 2), opY = L.ocy - ob.h + 2;
    let meVis = true, oppVis = true, meWhite = false, oppWhite = false, shake = 0, fx = null, msg = [], plates = true, meAlpha = 1, oppAlpha = 1;
    let hpMe = B.me.hp, hpOpp = B.opp.hp;

    if (B.phase === 'found') {
      plates = false; meVis = false;
      oppAlpha = Math.min(1, el / 900); oppWhite = el < 400;
      msg = msgLines('Rival found! ' + B.opp.card.name + ' wants to battle!');
    } else if (B.phase === 'intro') {
      const k = Math.max(0, 1 - el / 700);
      opX += Math.round(k * 60); myX -= Math.round(k * 60);
      plates = el > 700;
      msg = msgLines(B.kind === 'cpu' ? 'A wild ' + opName + ' appeared!' : B.opp.card.name + ' sent out ' + opName + '!');
      if (el > 1000) msg = msgLines('Go, ' + myName + '!');
    } else if (B.phase === 'choose' && B.role === 'def' && el < 700) {
      msg = msgLines(foe + ' is about to attack!');
    } else if (B.phase === 'choose') {
      const atk = B.role === 'atk', hl = ui.lastInput === 'key' && blink(t, 500);
      msg = null;
      S.panel(0, L.tb, W, 38);
      S.text(atk ? 'Strike HIGH or LOW?' : 'Guard HIGH or LOW?', 6, L.tb + 5, atk ? UI.text : UI.accent);
      const by = L.tb + 16, bh = 18, bw = 43;
      S.panel(3, by, bw, bh, hl ? UI.accent : null); S.panel(W - 3 - bw, by, bw, bh, hl ? UI.accent : null);
      const l1 = 'HIGH', l2 = 'LOW';
      S.text(l1, 3 + 8, by + 6); S.glyph('up3', 3 + bw - 11, by + 8, UI.accent);
      S.text(l2, W - 3 - bw + 8, by + 6); S.glyph('down3', W - 3 - 11, by + 8, UI.accent);
      zone(-20, L.tb + 12, W / 2 + 20, 60, () => battleMove('hi'), { x: 3, y: by, w: bw, h: bh }, 'hi');
      zone(W / 2, L.tb + 12, W / 2 + 20, 60, () => battleMove('lo'), { x: W - 3 - bw, y: by, w: bw, h: bh }, 'lo');
    } else if (B.phase === 'wait' || B.phase === 'idle') {
      msg = msgLines(B.live ? 'Waiting for ' + B.opp.card.name + '...' : '...');
    } else if (B.phase === 'anim') {
      const r = B.cur.res, mine = B.cur.attacker === 'me', atkName = mine ? myName : foe, defName = mine ? foe : myName;
      const move = r.special || (T.FORMS[(mine ? B.me : B.opp).card.formId] || {}).move || 'TACKLE';
      // HP drains between 450ms and 1000ms
      const k = U.clamp((el - 450) / 550, 0, 1);
      hpMe = B.from.me + (B.cur.hp.me - B.from.me) * k; hpOpp = B.from.opp + (B.cur.hp.opp - B.from.opp) * k;
      if (r.stunned) msg = msgLines(atkName + ' is stunned and can\'t move!');
      else {
        const lunge = el < 350 ? Math.round(Math.sin(el / 350 * Math.PI) * 7) : 0;
        if (mine) { myX += lunge; myY -= Math.round(lunge / 3); } else { opX -= lunge; opY += Math.round(lunge / 3); }
        msg = msgLines(atkName + ' used ' + move + '!');
        if (el > 380 && el < 1000) {
          const tx = mine ? opX : myX, ty = mine ? opY : myY, tw = mine ? ob.w : mb.w, th = mine ? ob.h : mb.h;
          const fy = ty + (r.dir === 'hi' ? Math.round(th * 0.3) : Math.round(th * 0.72));
          if (r.hit) {
            if (Math.floor(el / 70) % 2) { if (mine) oppWhite = true; else meWhite = true; }
            shake = (Math.floor(el / 40) % 2 ? 1 : -1) * (r.dmg > 1 ? 2 : 1);
            fx = { type: 'slash', x: tx + Math.floor(tw / 2), y: fy };
          } else if (r.blocked || r.absorbed) fx = { type: 'block', x: tx + (mine ? -2 : tw + 1), y: fy };
          else if (r.dodged) { if (mine) opX += 8; else myX -= 8; }
        }
        if (el > 1000) {
          const out = r.hit ? (r.dmg > 1 ? 'A crushing blow!' : 'It hit ' + defName + '!') :
            r.blocked ? defName + ' blocked it!' : r.dodged ? defName + ' dodged the attack!' : r.absorbed ? defName + ' absorbed the blow!' :
            r.heal ? '' : 'Nothing happened.';
          msg = msgLines([out, r.heal ? atkName + ' recovered HP!' : ''].filter(Boolean).join(' '));
        }
      }
    } else if (B.phase === 'end') {
      const k = U.clamp(el / 600, 0, 1);
      if (B.reason !== 'lost') { if (B.won) { oppAlpha = 1 - k; opY += Math.round(k * 10); } else if (B.reason !== 'fled') { meAlpha = 1 - k; myY += Math.round(k * 10); } }
      msg = msgLines(B.reason === 'lost' ? 'The link was lost.' : B.reason === 'fled' && !B.won ? 'Got away safely!' :
        B.won ? (B.reason === 'ko' ? foe + ' fainted! You win!' : 'The rival fled. You win!') : myName + ' fainted... You lost.').slice(0, 2);
      if (B.gain && el > 700) msg.push(('+' + B.gain.xp + ' XP' + (B.gain.coins ? '  +' + B.gain.coins + 'c' : '') + (B.gain.levelUp ? '  Lv ' + B.gain.level + '!' : '')).trim());
    }

    // platforms + monsters (+ shake)
    S.ctx.save(); S.ctx.translate(shake, 0);
    S.platform(L.ocx, L.ocy, 26, 6); S.platform(L.pcx, L.pcy, 28, 7);
    if (oppVis) S.art(ok, opX, opY, { frame: S.frame, alpha: oppAlpha, silhouette: oppWhite ? '#f4f6ff' : null });
    if (meVis) S.art(mk, myX, myY, { flip: true, frame: S.frame, alpha: meAlpha, silhouette: meWhite ? '#f4f6ff' : null });
    if (fx && fx.type === 'slash') for (let i = -1; i <= 1; i++) for (let j = -4; j <= 4; j++) S.rect(fx.x + j + i * 3, fx.y + j, 1, 1, i === 0 ? '#ffffff' : 'rgba(255,240,200,0.8)');
    if (fx && fx.type === 'block') for (let j = -5; j <= 5; j++) S.rect(fx.x + Math.round(Math.abs(j) / 3), fx.y + j, 1, 1, '#9fd4ff');
    S.ctx.restore();
    if (plates) {
      plate(2, L.top + 3, 54, B.opp, hpOpp, false);
      plate(W - 57, L.tb - 34, 56, B.me, hpMe, true, true);
    }
    if (msg) textBox(L, msg);
  }


  function cancelSearch() {
    const Q = ui.search;
    if (Q && Q.session) Q.session.cancel();
    ui.search = null; back(); refresh();
  }
  function drawSearch(t) {
    const Q = ui.search, key = petKey(), b = sz(key), el = t - Q.t0, L = battleLayout();
    const x = Math.floor((W - b.w) / 2) - 16;
    if (hatched()) drawPet(key, x, groundY(key), true);
    const cx = x + b.w + 3, cy = groundY(key) + 8, w = Math.floor(el / 250) % 4;
    if (w >= 1) S.glyph('wave1', cx, cy - 2, UI.blue);
    if (w >= 2) S.glyph('wave2', cx + 4, cy - 4, UI.blue);
    if (w >= 3) S.glyph('wave3', cx + 9, cy - 6, UI.blue);
    const k = Math.floor(el / 400) % 4;
    S.panel(0, L.tb, W, 38);
    S.text((Q.kind === 'find' ? 'Finding a rival' : 'Connecting') + '.'.repeat(k), 6, L.tb + 6);
    if (Q.kind === 'find') {
      const left = U.clamp(1 - el / C.SEARCH_MS, 0, 1);
      S.rect(6, L.tb + 18, W - 12, 5, UI.edge); S.rect(7, L.tb + 19, Math.round((W - 14) * left), 3, UI.blue);
    }
    S.text('Back to cancel', 6, L.tb + 27, UI.dim);
  }

  // ---------------------------------------------------------------- DOM panels: friend code, challenge, attention
  const $ = (id) => document.getElementById(id);
  function closePanels() { ['linkPanel', 'challengePanel', 'attnPanel', 'accountPanel'].forEach(id => { const el = $(id); if (el) el.hidden = true; }); }
  function openLinkPanel() {
    back();
    if (!canAct('battle')) return;
    $('myCode').textContent = (user && user.friendCode) || '…';
    $('linkError').textContent = '';
    $('linkPanel').hidden = false;
  }
  function linkFight() {
    const raw = $('friendCode').value.trim(), code = T.Battle.normCode(raw);
    if (T.Battle.isLegacyCode(raw)) { $('linkError').textContent = 'Old codes no longer work. Ask your friend for their new PX- code.'; A.sfx('no'); return; }
    if (!T.Battle.CODE_RE.test(code)) { $('linkError').textContent = 'Codes look like PX-ABC234.'; A.sfx('no'); return; }
    if (user && code === user.friendCode) { $('linkError').textContent = "That's your own code."; A.sfx('no'); return; }
    $('linkPanel').hidden = true;
    startBattle('friend', { code });
  }
  function openChallengePanel(prefill) {
    back(); closePanels();
    if (user && user.isGuest && false) return;
    $('chError').textContent = ''; $('chError').classList.remove('ok');
    if (typeof prefill === 'string') $('chTarget').value = prefill;
    renderOutgoing();
    $('challengePanel').hidden = false;
  }
  function renderOutgoing() {
    const ul = $('chList'); ul.innerHTML = '';
    (chal.outgoing || []).slice(0, 4).forEach(c => {
      const li = document.createElement('li');
      const st = c.status === 'pending' ? 'waiting' : c.status === 'done' ? (c.result ? c.result : 'fought') : c.status;
      li.textContent = 'You → ' + c.to + ': ' + st;
      ul.appendChild(li);
    });
  }
  async function sendChallenge() {
    const target = $('chTarget').value.trim(), err = $('chError');
    err.classList.remove('ok');
    if (!target) { err.textContent = 'Type a username or a PX- code.'; return; }
    try {
      const r = await Api.post('/api/challenge', { target });
      if (r.status === 401) return authLost();
      if (!r.data.ok) { err.textContent = r.data.msg || 'Could not send.'; A.sfx('no'); return; }
      A.sfx('ok'); err.classList.add('ok');
      err.textContent = 'Challenge sent to ' + r.data.to + (r.data.online ? ' (online now).' : '. They will see it next time they play.');
      $('chTarget').value = '';
      await refresh(); renderOutgoing();
    } catch (e) { if (e && e.offline) goOffline(e); }
  }
  async function declineChallenge(id) {
    try {
      const r = await Api.post('/api/challenge/decline', { id });
      if (r.status === 401) return authLost();
      chal.incoming = (chal.incoming || []).filter(c => c.id !== id);
      toast(r.data.ok ? 'Challenge declined.' : (r.data.msg || 'That challenge is gone.'));
      renderHUD(); refresh();
    } catch (e) { if (e && e.offline) goOffline(e); }
  }
  function acceptChallenge(id) {
    closePanels();
    if (!canAct('battle')) return;
    chal.incoming = (chal.incoming || []).filter(c => c.id !== id);
    startBattle('accept', { id });
  }

  /** Everything that needs the player, most urgent first: [{id, icon, text, sub, sev, actions:[{label, fn, id}]}] */
  function attentionItems() {
    const out = [];
    if (!state) return out;
    const name = state.name;
    if (state.dead) out.push({ id: 'dead', icon: 'i_attention', sev: 3, text: name + ' has died.', sub: 'Hatch a new egg to start again.', actions: [{ label: 'New egg', fn: newEgg }] });
    const map = {
      sick: { icon: 'i_medicine', sev: 3, rank: 1, sub: 'Give medicine now.', actions: [{ label: 'Medicine', fn: doMedicine }] },
      hungry: { icon: 'i_feed', sev: 3, rank: 2, sub: 'Feed it a meal.', actions: [{ label: 'Feed', fn: () => feed(false) }] },
      poop: { icon: 'i_poop', sev: 2, rank: 3, sub: 'Clean up within an hour.', actions: [{ label: 'Clean', fn: doClean }] },
      tired: { icon: 'i_energy', sev: 2, rank: 4, sub: 'Lights off to sleep and recharge.', actions: [{ label: 'Sleep', fn: () => setLights(false) }] },
      sad: { icon: 'i_sad', sev: 1, rank: 8, sub: 'A snack or training cheers it up.', actions: [{ label: 'Snack', fn: () => feed(true) }] },
      fake: { icon: 'i_discipline', sev: 1, rank: 9, sub: 'Scold it on the "!" screen.', actions: [{ label: 'Scold', fn: () => { ui.mode = 'discipline'; ui.discMsg = null; doScold(); } }] }
    };
    const list = [];
    Pet.attention(state).forEach(a => { const m = map[a.id]; if (m) list.push(Object.assign({ id: a.id, text: a.text }, m)); });
    (chal.incoming || []).forEach(c => list.push({ id: 'challenge', cid: c.id, icon: 'i_battle', sev: 2, rank: 5,
      text: c.from + ' challenged you to a fight!', sub: c.online ? 'Online now: accept for a live battle.' : 'Offline: you fight their monster.',
      actions: [{ label: 'Accept', fn: () => acceptChallenge(c.id), id: 'acc' }, { label: 'Decline', fn: () => declineChallenge(c.id), id: 'dec', ghost: true }] }));
    const lj = eco && eco.lastJob;
    if (lj && !lj.seen) list.push({ id: 'jobDone', icon: 'i_pick', sev: 1, rank: 6, text: 'Back from ' + lj.name + '!', sub: '+' + lj.coins + ' coins' + (lj.ore ? ', +' + lj.ore + ' ore' : '') + '.',
      actions: [{ label: 'OK', fn: () => act('job_seen', null, { quiet: true }) }] });
    if (hatched() && !state.job) {
      const ev = Pet.evolvesIn(state);
      if (ev != null && ev <= 3 * HOUR) list.push({ id: 'evolve', icon: 'i_evolve', sev: 1, rank: 7, text: ev > 0 ? 'Evolving in ' + fmtDur(ev) + '!' : 'Evolving now!', sub: 'Good care now shapes its next form.',
        actions: [{ label: 'Status', fn: () => { ui.mode = 'status'; ui.page = 0; } }] });
    }
    list.sort((a, b) => a.rank - b.rank);
    return out.concat(list);
  }
  function openAttention() {
    back(); closePanels();
    const items = attentionItems(), ul = $('attnList');
    ul.innerHTML = '';
    items.forEach((it, i) => {
      const li = document.createElement('li'); li.className = 'sev' + it.sev; li.dataset.item = it.id;
      const cv = document.createElement('canvas'); cv.className = 'aicon'; T.Scene.iconCanvas(cv, it.icon, it.sev >= 3 ? '#e0786e' : '#e0ad48', 2);
      const txt = document.createElement('div'); txt.className = 'atxt';
      const b1 = document.createElement('b'); b1.textContent = it.text; const s1 = document.createElement('small'); s1.textContent = it.sub || '';
      txt.append(b1, s1);
      const acts = document.createElement('div'); acts.className = 'aacts';
      it.actions.forEach(a => {
        const bt = document.createElement('button'); bt.type = 'button'; bt.textContent = a.label; if (a.ghost) bt.className = 'ghost';
        bt.dataset.action = it.id + ':' + (a.id || a.label.toLowerCase());
        bt.addEventListener('click', () => { A.unlock(); A.sfx('click'); closePanels(); a.fn(); });
        acts.appendChild(bt);
      });
      li.append(cv, txt, acts); ul.appendChild(li);
    });
    $('attnEmpty').hidden = items.length > 0;
    $('attnPanel').hidden = false;
  }

  // ---------------------------------------------------------------- HUD: bell badge + wallet strip
  function renderBell() {
    const b = hud.attention; if (!b) return;
    const items = session ? attentionItems() : [], top = items[0];
    const key = top ? top.icon + ':' + top.sev + ':' + items.length : '';
    b.classList.toggle('alert', items.length > 0);
    b.classList.toggle('urgent', !!top && top.sev >= 3);
    if (b.dataset.badge === key) return;
    b.dataset.badge = key;
    const badge = b.querySelector('.badge');
    badge.hidden = !top;
    if (top) {
      T.Scene.iconCanvas(badge.querySelector('canvas'), top.icon, '#161c28', 2);
      badge.querySelector('b').textContent = items.length > 1 ? String(items.length) : '';
      badge.classList.toggle('many', items.length > 1);
      badge.dataset.top = top.id;
    }
    b.setAttribute('aria-label', top ? 'Needs attention: ' + items.map(i => i.text).join('; ') : 'Needs attention: nothing right now');
    b.title = top ? items.map(i => i.text).join('\n') : 'All good';
  }
  function updateWallet() {
    if (!state || !eco) return;
    const e = energy(), EN = C.ENERGY.MAX;
    $('energyFill').style.width = Math.round(100 * U.clamp((state.energy || 0) / EN, 0, 1)) + '%';
    $('energyNum').textContent = e + (state.asleep && e < EN ? '+' : '');
    $('coinNum').textContent = String(eco.coins);
    $('wallet').classList.toggle('low', e < 20);
    $('wallet').setAttribute('aria-label', 'Energy ' + e + ' of ' + EN + ', ' + eco.coins + ' coins');
  }

  // ---------------------------------------------------------------- session: boot, login, logout, offline
  function tz() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; } }
  async function boot() {
    try {
      const c = await Api.get('/api/config'); cfg = c.data || {};
      const r = await Api.get('/api/state');
      if (offline) hideOffline();
      if (r.status === 401 || (r.status === 200 && r.data.auth === false)) { showLogin(); return; }
      if (r.status !== 200) throw { offline: true, why: 'no_api', status: r.status };
      startSession(r.data, true);
    } catch (e) { goOffline(e); }
  }
  function showLogin() {
    session = false; clearTimeout(pollTimer); Net.disconnect();
    state = placeholderPet(); eco = null; user = null; chal = { incoming: [], outgoing: [] };
    ui = Object.assign(freshUI(), { lastInput: ui ? ui.lastInput : 'tap' });
    closePanels();
    document.body.classList.remove('booting');
    document.body.classList.add('signed-out');
    T.Account.showLogin(cfg);
    renderHUD();
  }
  function placeholderPet() { const p = Pet.create(); p.eggMs = 0; return p; }
  function startSession(view, first) {
    session = true;
    document.body.classList.remove('booting', 'signed-out');
    ui = Object.assign(freshUI(), { lastInput: ui ? ui.lastInput : 'tap' });
    applyView(view, { boot: first });
    Net.connect();
    schedulePoll();
    maybeImport();
  }
  /** Called by account.js after a successful log in / sign up / guest start. */
  async function onLoggedIn() {
    try {
      const r = await Api.get('/api/state');
      if (r.status === 200 && r.data.pet) startSession(r.data, true); else showLogin();
    } catch (e) { goOffline(e); }
  }
  function maybeImport() {
    const save = Pet.readLocalSave();
    if (!save || !user || user.imported) return;
    T.Account.offerImport(save).then((res) => {
      if (!res) return;
      if (res.state) applyView(res.state);
      if (res.imported) {
        try { localStorage.setItem(C.SAVE_KEY + '.imported', localStorage.getItem(C.SAVE_KEY)); localStorage.removeItem(C.SAVE_KEY); } catch (e) {}
        user.imported = true;
        noticeAnim('Welcome back, ' + state.name + '!', res.notes && res.notes.length ? 'Some values were adjusted: ' + res.notes.join(', ') + '.' : 'Your monster moved in.', 3200);
      } else user.imported = true;
    });
  }
  function authLost() { showLogin(); }
  async function logout() {
    try { await Api.post('/api/logout', {}); } catch (e) {}
    showLogin();
  }
  function goOffline(e) {
    offline = true;
    const why = e && e.why;
    $('offDetail').textContent = why === 'file' ? 'This page was opened as a file. Start the server (npm start) and open http://localhost:8080.'
      : why === 'no_api' ? 'This address serves the page but not the game server.' : 'Check your internet connection, then retry.';
    $('offlinePanel').hidden = false;
    document.body.classList.remove('booting');
    clearTimeout(pollTimer);
  }
  function hideOffline() { offline = false; $('offlinePanel').hidden = true; if (session) schedulePoll(); }
  async function retryOnline() {
    $('offRetry').disabled = true;
    try { if (session) { await refresh(); if (!offline) hideOffline(); } else { hideOffline(); await boot(); } }
    finally { $('offRetry').disabled = false; }
  }
  function openAccount() { closePanels(); T.Account.openAccount(user); }

  // ---------------------------------------------------------------- input
  const BUSY = ['play', 'battle', 'search'];
  function iconEnabled(name) {
    if (!session || ui.anim || busy || BUSY.includes(ui.mode) || offline) return false;
    if (name === 'home' || name === 'status' || name === 'attention') return true;
    return hatched();
  }
  function tapIcon(name) {
    A.unlock(); ui.lastInput = 'tap';
    if (!iconEnabled(name)) { if (!ui.anim) A.sfx('no'); return; }
    A.sfx('click');
    ui.confirm = null;
    switch (name) {
      case 'home': ui.mode = ui.mode === 'menu' ? 'main' : 'menu'; ui.sub = 0; break;
      case 'status': ui.mode = 'status'; ui.page = 0; break;
      case 'attention': openAttention(); break;
      case 'feed': back(); if (canAct('feed')) { ui.mode = 'feedMenu'; ui.sub = 0; } break;
      case 'light': back(); if (canAct('light')) { ui.mode = 'lightMenu'; ui.sub = state.lightsOff ? 1 : 0; } break;
      case 'play': back(); if (canAct('play')) startPlay(); break;
      case 'medicine': back(); if (canAct('medicine')) doMedicine(); break;
      case 'bath': back(); if (canAct('bath')) doClean(); break;
      case 'discipline': if (state.job) { canAct('discipline'); break; } ui.mode = 'discipline'; ui.discMsg = null; break;
      case 'battle': back(); if (canAct('battle')) { ui.mode = 'battleMenu'; ui.sub = 0; } break;
    }
    renderHUD();
  }
  function backAvailable() { return !ui.anim && (ui.mode !== 'main' || !!ui.confirm); }
  function goBack() {
    if (ui.anim) return;
    if (ui.confirm) { ui.confirm = null; renderHUD(); return; }
    switch (ui.mode) {
      case 'main': break;
      case 'play': toast('Finish the session first.', 'Pick left or right.'); break;
      case 'battle': fleeBattle(); break;
      case 'search': cancelSearch(); break;
      case 'settings': case 'help': case 'shop': case 'jobs': case 'battleMenu': ui.mode = 'menu'; ui.sub = 0; break;
      default: back();
    }
    renderHUD();
  }
  function tapScene(e) {
    e.preventDefault(); A.unlock(); ui.lastInput = 'tap';
    const t = now();
    if (ui.anim || t < ui.tapLock || !session) return;
    render();
    if (ui.anim) return;
    const p = S.toStage(e.clientX, e.clientY);
    let z = null;
    for (let i = ui.zones.length - 1; i >= 0; i--) {
      const q = ui.zones[i];
      if (p.x >= q.x && p.x < q.x + q.w && p.y >= q.y && p.y < q.y + q.h) { z = q; break; }
    }
    if (!z || !z.id && !z.box) return;
    A.sfx('click');
    ui.tapFx = z.box && z.id !== 'pet' ? { x: z.box.x, y: z.box.y, w: z.box.w, h: z.box.h, until: t + 110 } : null;
    ui.tapLock = t + 120;
    setTimeout(() => { z.fn(); render(); renderHUD(); }, 100);
  }
  /** Optional keyboard: A = next/left/high, B = ok/right/low, C = back. */
  function press(btn) {
    A.unlock(); ui.lastInput = 'key';
    if (ui.anim || !session) return;
    A.sfx('click');
    if (btn === 'C') return goBack();
    const rows = ui.rows;
    const pick = (r) => { if (!r) return; if (r.fn) r.fn(); else if (r.btn) r.btn.fn(); };
    if (ui.confirm || ['feedMenu', 'lightMenu', 'battleMenu', 'menu', 'settings', 'shop'].includes(ui.mode) || (ui.mode === 'jobs' && rows && !state.job)) {
      if (rows && rows.length) { if (btn === 'A') ui.sub = (ui.sub + 1) % rows.length; else pick(rows[ui.sub % rows.length]); }
    } else switch (ui.mode) {
      case 'main': if (btn === 'A') { ui.mode = 'menu'; ui.sub = 0; } else if (state.dead) confirmBox('NEW EGG?', ['Hatch a new egg?'], { label: 'YES', fn: newEgg }, 'NO', 'newegg'); else openAttention(); break;
      case 'status': nextStatusPage(); break;
      case 'help': ui.page++; if (ui.page >= HELP_PAGES) ui.mode = 'menu'; break;
      case 'discipline': if (btn === 'B') doScold(); else back(); break;
      case 'jobs': if (state.job) askRecall(); break;
      case 'play': playGuess(btn === 'A' ? -1 : 1); break;
      case 'battle': battleMove(btn === 'A' ? 'hi' : 'lo'); break;
    }
    renderHUD();
  }

  // ---------------------------------------------------------------- render
  function render() {
    const t = now();
    ui.zones = []; ui.rows = null;
    S.begin(t, envFor());
    if (ui.anim) {
      const a = ui.anim, el = t - a.t0;
      if (el >= a.dur) { endAnim(); return render(); }
      a.draw(el, el / a.dur);
    } else if (!session) {
      drawMain(t, true);
    } else {
      switch (ui.mode) {
        case 'feedMenu': case 'lightMenu': case 'battleMenu':
          updatePet(t); drawMain(t, true); dim();
          drawOptions(ui.mode === 'feedMenu' ? FEED_OPTS() : ui.mode === 'lightMenu' ? LIGHT_OPTS() : BATTLE_OPTS(),
            { feedMenu: 'FEED', lightMenu: 'LIGHTS', battleMenu: 'BATTLE' }[ui.mode]);
          break;
        case 'menu': drawMain(t, true); dim(); drawRows('MAIN MENU', menuRows(), { right: user ? (user.username || 'guest') : '' , rightCol: UI.dim }); break;
        case 'settings': drawMain(t, true); dim(); drawRows('SETTINGS', settingsRows()); break;
        case 'help': { drawMain(t, true); dim(); const [ti, lines] = helpPage(ui.page % HELP_PAGES);
          drawPaged(t, 'HELP: ' + ti, lines, ui.page % HELP_PAGES, HELP_PAGES, () => { ui.page++; if (ui.page >= HELP_PAGES) { ui.mode = 'menu'; ui.page = 0; } }, 'help'); break; }
        case 'shop': drawMain(t, true); dim(); drawRows('SHOP', shopRows(), { right: (eco ? eco.coins : 0) + 'c', rightCol: UI.accent }); break;
        case 'jobs': drawJobs(t); break;
        case 'discipline': drawDiscipline(t); break;
        case 'status': drawStatus(t); break;
        case 'play': drawPlay(t); break;
        case 'battle': drawBattle(t); break;
        case 'search': drawSearch(t); break;
        default: updatePet(t); drawMain(t);
      }
      if (ui.confirm && ui.mode !== 'battle') { ui.zones = []; drawConfirm(); }
    }
    if (ui.toast) drawToast(t);
    if (ui.tapFx && t < ui.tapFx.until) S.flash(ui.tapFx.x, ui.tapFx.y, ui.tapFx.w, ui.tapFx.h);
  }
  function renderHUD() {
    if (!hud.feed || !ui) return;
    TOP_BAR.concat(BOTTOM_BAR).forEach(n => {
      if (n === 'back') return;
      hud[n].disabled = !iconEnabled(n);
    });
    const on = { feedMenu: 'feed', lightMenu: 'light', play: 'play', status: 'status', discipline: 'discipline', battleMenu: 'battle', battle: 'battle', search: 'battle',
                 menu: 'home', settings: 'home', help: 'home', shop: 'home', jobs: 'home' }[ui.mode];
    TOP_BAR.concat(BOTTOM_BAR).forEach(n => hud[n].classList.toggle('on', on === n));
    const bk = backAvailable() && session;
    hud.back.disabled = !bk; hud.back.classList.toggle('ready', bk);
    renderBell();
    document.body.dataset.mode = ui.mode;
    if (state) document.body.dataset.env = envFor();
  }
  function makeHUD() {
    const mk = (name, parent) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'pbtn' + (name === 'back' ? ' back' : '') + (name === 'attention' ? ' bell' : '');
      el.setAttribute('aria-label', LABELS[name]);
      el.dataset.icon = name; el.title = LABELS[name];
      const cv = document.createElement('canvas'); cv.className = 'picon';
      T.Scene.iconCanvas(cv, 'i_' + name, '#d6deea', 3);
      el.appendChild(cv);
      if (name === 'attention') {
        const bd = document.createElement('span'); bd.className = 'badge'; bd.hidden = true;
        bd.append(document.createElement('canvas'), document.createElement('b'));
        el.appendChild(bd);
      }
      parent.appendChild(el);
      hud[name] = el;
      return el;
    };
    const top = $('barTop'), bot = $('barBottom');
    TOP_BAR.forEach(n => mk(n, top).addEventListener('click', () => tapIcon(n)));
    mk('back', bot).addEventListener('click', () => { A.unlock(); ui.lastInput = 'tap'; A.sfx('click'); goBack(); });
    BOTTOM_BAR.slice(1).forEach(n => mk(n, bot).addEventListener('click', () => tapIcon(n)));
    document.querySelectorAll('.wicon').forEach(cv => T.Scene.iconCanvas(cv, cv.dataset.icon, cv.dataset.icon === 'i_coin' ? '#e0ad48' : '#dcc043', 2));
  }
  /** Fill the viewport with the scene; keep the stage between the HUD bars (and the wallet strip). */
  function fit() {
    const vw = window.innerWidth, vh = window.innerHeight;
    $('wallet').style.top = Math.round($('barTop').getBoundingClientRect().bottom) + 'px';
    const top = Math.max($('barTop').getBoundingClientRect().bottom, $('wallet').getBoundingClientRect().bottom);
    const bot = vh - $('barBottom').getBoundingClientRect().top;
    S.resize(vw, vh, top, bot);
    if (state) render();
  }

  // ---------------------------------------------------------------- loop
  function tick() {
    if (!state) return;
    if (session && !offline) {
      extrapolate();
      if (dueSoon() && now() - lastFetch > 3000 && now() > dueAt) { dueAt = now() + 3000; refresh(); }
    }
    render(); renderHUD(); updateWallet();
  }
  function bindInput() {
    const map = { '1': 'A', 'a': 'A', '2': 'B', 'b': 'B', '3': 'C', 'c': 'C', 'escape': 'C', 'enter': 'B' };
    document.addEventListener('keydown', (e) => {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (document.querySelector('.modal:not([hidden])')) { if (e.key === 'Escape') closePanels(); return; }
      const k = e.key.toLowerCase();
      if (k === 'enter' && e.target && e.target.tagName === 'BUTTON') return;
      if (map[k]) { e.preventDefault(); press(map[k]); }
      else if (k === 'm') toggleMute();
    });
    S.c.addEventListener('pointerdown', tapScene);
    S.c.addEventListener('contextmenu', (e) => e.preventDefault());
    $('copyCode').addEventListener('click', () => {
      const txt = $('myCode').textContent, btn = $('copyCode');
      const ok = () => { btn.textContent = 'Copied'; setTimeout(() => (btn.textContent = 'Copy'), 1200); };
      if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(txt).then(ok, () => selectCode());
      else { selectCode(); try { document.execCommand('copy'); ok(); } catch (e) {} }
    });
    $('linkFight').addEventListener('click', linkFight);
    $('linkClose').addEventListener('click', () => { $('linkPanel').hidden = true; });
    $('friendCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') linkFight(); });
    $('friendCode').addEventListener('input', () => { $('linkError').textContent = ''; });
    $('chSend').addEventListener('click', sendChallenge);
    $('chTarget').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChallenge(); });
    $('chClose').addEventListener('click', () => { $('challengePanel').hidden = true; });
    $('attnClose').addEventListener('click', () => { $('attnPanel').hidden = true; });
    $('attnChallenge').addEventListener('click', () => openChallengePanel());
    $('offRetry').addEventListener('click', retryOnline);
    document.querySelectorAll('.modal').forEach(m => m.addEventListener('pointerdown', (e) => {
      if (e.target === m && !m.classList.contains('full') && m.id !== 'importPanel') m.hidden = true;
    }));
    document.addEventListener('visibilitychange', () => { if (!document.hidden && session) { refresh(); } schedulePoll(); });
    window.addEventListener('online', () => { if (offline) retryOnline(); });
    window.addEventListener('resize', fit);
    window.addEventListener('orientationchange', () => setTimeout(fit, 200));
    Net.on('challenge', (m) => {
      if (!chal.incoming.some(c => c.id === m.ch.id)) chal.incoming.push(m.ch);
      A.sfx('call'); renderHUD();
      toast('CHALLENGE!', m.ch.from + ' wants to fight. Tap the bell to answer.', 4000);
      notify('challenge' + m.ch.id, m.ch.from + ' challenged you to a fight!');
    });
    Net.on('challengeUpdate', (m) => {
      if (m.status === 'declined') { toast(m.to + ' declined your challenge.'); notify('chup' + m.id, m.to + ' declined your challenge.'); }
      else if (m.status === 'accepted' && !m.live) toast(m.to + ' accepted!', 'They are fighting your monster now.');
      refresh();
    });
    Net.on('incomingBattle', incomingBattle);
    Net.on('auth', () => { if (session) refresh(); });
  }
  function selectCode() {
    const r = document.createRange(); r.selectNodeContents($('myCode'));
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
  }
  function toggleMute() {
    A.setMuted(!A.muted);
    if (!A.muted) { A.unlock(); A.sfx('ok'); }
  }

  function init() {
    A.init();
    S = new T.Scene($('scene'));
    makeHUD();
    ui = freshUI();
    state = placeholderPet();
    bindInput(); fit();
    T.Account.init({ onLoggedIn, onLoggedOut: showLogin, applyView: (v) => applyView(v), goOffline });
    tick();
    setInterval(tick, 100);
    if (C.DEBUG && T.Debug) T.Debug.init();
    boot();
  }

  // Public API (debug panel, tests, and future layers).
  T.Game = {
    init, press, tapIcon, goBack, refresh, applyView, act, render, handleEvents, evolveAnim, startBattle, openAttention, attentionItems,
    get state() { return state; }, get eco() { return eco; }, get user() { return user; }, get challenges() { return chal; },
    get ui() { return ui; }, get scene() { return S; }, get session() { return session; }, get busy() { return busy; },
    notifyLog, Notify, toast,
    stageToClient(x, y) { return S.toClient(x, y); },
    /** Client coords of the centre of the tappable zone with this id (null if not on screen). */
    zonePoint(id) {
      render();
      const z = ui.zones.find(q => q.id === id); if (!z) return null;
      const b = z.box || z; return S.toClient(b.x + b.w / 2, b.y + b.h / 2);
    },
    zoneIds() { render(); return ui.zones.map(z => z.id).filter(Boolean); },
    resetUI() { ui = Object.assign(freshUI(), { lastInput: 'tap' }); }
  };

  document.addEventListener('DOMContentLoaded', init);
})(window.Tama);
