/* TAMA-PIX — UI controller: tap/keyboard input, menus, animations, mini-game, battles, main loop.
 *
 * Rendering: full-screen GBA-style scene (scene.js). Gameplay is drawn on a 96x48 "stage" (the dirt path in the
 * meadow); negative y reaches up into the sky, used for panels and labels. Battles use a Gen-3 style layout that
 * spans the whole visible area (S.bounds()).
 * Input: HUD buttons along the top/bottom + tappable "zones" registered while drawing (see zone()); each zone can
 * carry an id so tests/tools can find it. Keyboard is optional: 1/A next, 2/B ok, 3/C back, M mute.
 */
(function (T) {
  'use strict';
  const C = T.CONFIG, U = T.util, SPR = T.SPR, Pet = T.Pet, A = T.Audio, UI = T.UI;
  const W = C.STAGE_W, H = C.STAGE_H, FOOT = H - 2;
  const ICONS = ['feed', 'light', 'play', 'medicine', 'bath', 'status', 'discipline', 'battle'];
  const TOP_BAR = ['feed', 'light', 'play', 'medicine', 'bath'];
  const LABELS = { feed: 'Feed', light: 'Light', play: 'Train', medicine: 'Medicine', bath: 'Clean up', status: 'Status',
                   discipline: 'Discipline', battle: 'Battle', attention: 'Needs attention', back: 'Back', sound: 'Sound' };
  const TITLES = { feedMenu: 'FEED', lightMenu: 'LIGHTS', battleMenu: 'BATTLE' };
  const STATUS_PAGES = 5;
  const EMOTE_COL = { heart: '#c9505a', note: '#9fb3d1', angry: '#d0503c', zzz: '#9fb0d0', sweat: '#7fb4d8',
                      question: '#d8dde6', food: '#d8c9a0', skull: '#d8dde6', excl: UI.accent };

  let S, hud = {}, state, ui, lastReal = Date.now(), lastSave = 0;

  function freshUI() {
    return {
      mode: 'main', sel: -1, sub: 0, page: 0,
      anim: null, queue: [], zones: [], tapFx: null, tapLock: 0, lastInput: 'tap',
      pet: { x: 30, dir: 1, move: 'walk', lastStep: 0 }, petted: 0,
      emote: null, emoteUntil: 0, nextThink: 0, thought: '',
      play: null, battle: null, search: null, lastCallBeep: 0, fallbackReason: null
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
  function rightLimit() { return W - 2 - Math.min(4, state.poops.length) * 11; }

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
  function back() { ui.mode = 'main'; ui.sub = 0; }

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
  function dim() { S.overlay('rgba(6, 8, 14, 0.45)'); }

  /** Stacked choices on dark panels. opts: [{label, icon, fn}] (2 or 3 items). */
  function drawOptions(opts, title) {
    const n = opts.length, boxH = 15, gap = 4, w = 72, x = Math.floor((W - w) / 2);
    const total = n * boxH + (n - 1) * gap, y0 = Math.round(H / 2 - total / 2) - 4;
    if (title) S.label(title, y0 - 14, UI.accent);
    opts.forEach((o, i) => {
      const y = y0 + i * (boxH + gap), hi = ui.lastInput === 'key' && ui.sub === i;
      S.panel(x, y, w, boxH, hi ? UI.accent : null);
      S.text(o.label, x + 6, y + 5, hi ? UI.accent : UI.text);
      if (o.icon) { const a = sz(o.icon); S.art(o.icon, x + w - a.w - 4, y + Math.floor((boxH - a.h) / 2)); }
      const zt = i === 0 ? y0 - 30 : y - Math.floor(gap / 2), zb = i === n - 1 ? H + 30 : y + boxH + Math.ceil(gap / 2);
      zone(-20, zt, W + 40, zb - zt, o.fn, { x, y, w, h: boxH }, 'opt' + i);
    });
  }

  function envFor() {
    if (ui.mode === 'battle') return 'battle';
    if (state.lightsOff) return 'night';
    if (state.asleep || state.dead) return 'dusk';
    return 'day';
  }

  // ---------------------------------------------------------------- main idle screen
  function updatePet(t) {
    const k = petKey(), b = sz(k), p = ui.pet;
    if (state.stage === 'egg' || state.dead) return;
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
      if (p.move === 'walk' && t > ui.petted) {
        if (U.chance(0.06)) p.dir *= -1;
        p.x += p.dir * 2;
      }
    }
    const maxX = rightLimit() - b.w - 1;
    if (p.x > maxX) { p.x = maxX; p.dir = -1; }
    if (p.x < 2) { p.x = 2; p.dir = 1; }
  }

  function drawMain(t, noZones) {
    if (state.dead) return drawDead(t);
    if (state.stage === 'egg') {
      const b = sz('egg'), poked = t < ui.petted;
      const wob = poked || state.eggMs > C.T.HATCH * 0.6 ? (blink(t, 120) ? 1 : -1) : 0;
      const x = Math.floor((W - b.w) / 2);
      drawPet('egg', x + wob, groundY('egg'), false);
      if (!noZones) zone(x - 8, groundY('egg') - 10, b.w + 16, b.h + 14, () => { ui.petted = now() + 800; }, null, 'pet');
      return;
    }
    const key = petKey(), b = sz(key), p = ui.pet;
    const hop = !state.asleep && (p.move === 'hop' || t < ui.petted);
    const bob = hop ? (blink(t, 220) ? -2 : 0) : 0;
    drawPoops(t);
    // facing: sprites face left; flip when walking right
    drawPet(key, p.x, groundY(key) + bob, !state.asleep && p.dir > 0, state.asleep ? { frame: 2 } : null);
    if (state.lightsOff) S.overlay('rgba(3, 6, 24, 0.5)');
    if (state.asleep) {
      const k = Math.floor(t / 700) % 4;
      for (let i = 0; i < 3; i++) if (i <= k) S.text('z', p.x + b.w - 2 + i * 4, groundY(key) + 2 - i * 5, state.lightsOff ? '#7f8fb0' : '#aab6cc');
    } else {
      if (state.sick && blink(t, 600)) S.emote('e_skull', p.x - 7, groundY(key) + 2, EMOTE_COL.skull);
      if (ui.emote && t < ui.emoteUntil) drawEmote(ui.emote, p.x, groundY(key), b.w);
    }
    if (noZones) return;
    zone(p.x - 4, groundY(key) - 6, b.w + 8, b.h + 8, () => {
      ui.petted = now() + 1400;
      ui.emote = state.asleep ? 'angry' : state.sick ? 'sweat' : (state.happy >= 2 ? U.pick(['heart', 'note']) : 'question');
      ui.emoteUntil = now() + 1800; ui.nextThink = now() + 2500;
    }, null, 'pet');
  }

  function drawDead(t) {
    const key = petKey(), b = sz(key), tb = sz('tomb');
    const tx = W - tb.w - 10;
    S.shadow(tx, FOOT + 1, tb.w); S.art('tomb', tx, FOOT - tb.h + 1);
    const bob = Math.round(Math.sin(t / 500) * 1.5);
    S.art(key, 10, FOOT - b.h - 8 + bob, { alpha: 0.45, frame: S.frame });
    if (t % 2400 < 1800) S.label('Rest in peace. Tap for a new egg.', -24, UI.dim);
    zone(-20, -40, W + 40, H + 40, () => { ui.mode = 'deadConfirm'; }, { x: 0, y: -27, w: W, h: 13 }, 'dead');
  }
  function drawDeadConfirm() {
    drawDead(0); ui.zones = []; dim();
    S.panel(14, -10, 68, 44);
    S.textC('Hatch a new egg?', -3);
    S.button(28, 12, 40, 15, 'YES', ui.lastInput === 'key');
    zone(-20, 6, W + 40, H + 30, newEgg, { x: 28, y: 12, w: 40, h: 15 }, 'yes');
  }

  // ---------------------------------------------------------------- menus / status
  const FEED_OPTS = () => [
    { label: 'MEAL', icon: 'meat', fn: () => feed(false) },
    { label: 'SNACK', icon: 'berry', fn: () => feed(true) }];
  const LIGHT_OPTS = () => [
    { label: 'LIGHTS ON', icon: null, fn: () => setLights(true) },
    { label: 'LIGHTS OFF', icon: null, fn: () => setLights(false) }];
  const BATTLE_OPTS = () => [
    { label: 'RANDOM ONLINE', icon: null, fn: startSearch },
    { label: 'FRIEND CODE', icon: null, fn: openLinkPanel },
    { label: 'VS COMPUTER', icon: null, fn: () => { back(); startLocalBattle(T.Battle.cpuCard(state.stage, Pet.level(state)), 'cpu'); } }];

  function feed(snack) { back(); eatAnim(snack ? 'berry' : 'meat', snack ? Pet.feedSnack(state) : Pet.feedMeal(state)); }
  function setLights(on) { Pet.setLights(state, on); A.sfx('ok'); back(); }

  function pips(x, y, n, max, col) {
    for (let i = 0; i < max; i++) { S.rect(x + i * 14, y, 12, 6, UI.edge); S.rect(x + i * 14 + 1, y + 1, 10, 4, i < n ? col : '#343b48'); }
  }
  /** "1d 4h" / "3h 12m" / "25m" / "<1m" for a duration in REAL ms. */
  function fmtDur(ms) {
    const m = Math.max(0, Math.floor(ms / 60000)), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
    if (d) return d + 'd ' + h + 'h';
    if (h) return h + 'h ' + mm + 'm';
    return mm ? mm + 'm' : '<1m';
  }
  function evolveLine(s) {
    const left = Pet.evolvesIn(s);
    if (left == null) return T.FORMS[s.formId].secret ? 'Secret final form' : 'Final form';
    if (left <= 0) return s.asleep ? 'Evolves at dawn' : 'Evolving...';
    return 'Evolves in ' + fmtDur(left / C.SPEED);
  }
  function drawStatus(t) {
    const s = state, f = T.FORMS[s.formId];
    drawMain(t, true); dim();
    const x = 4, y = -56, w = 88, h = 104;
    S.panel(x, y, w, h);
    const titles = ['PROFILE', 'HUNGER', 'MOOD', 'DISCIPLINE', 'RECORD'];
    S.text(titles[ui.page], x + 7, y + 6, UI.accent);
    S.text((ui.page + 1) + '/' + STATUS_PAGES, x + w - 7 - S.textW('5/5'), y + 6, UI.dim);
    S.rect(x + 5, y + 15, w - 10, 1, UI.inner);
    const cx = x + 7, cy = y + 22;
    switch (ui.page) {
      case 0: {
        const k = petKey(), a = sz(k), L = Pet.level(s), X = T.Battle;
        S.art(k, x + w - a.w - 5, y + 74 - a.h, { frame: S.frame });
        S.text(s.name, cx, cy, UI.text);
        S.text(f.name, cx, cy + 10, UI.accent);
        S.text('Lv ' + L, cx, cy + 22, UI.text);
        const lo = X.xpFor(L), hi = X.xpFor(L + 1), pr = L >= X.XP.MAX_LEVEL ? 1 : (s.xp - lo) / Math.max(1, hi - lo);
        S.rect(cx, cy + 31, 34, 4, UI.edge); S.rect(cx + 1, cy + 32, 32, 2, '#343b48'); S.rect(cx + 1, cy + 32, Math.round(32 * U.clamp(pr, 0, 1)), 2, UI.blue);
        S.text('XP ' + s.xp, cx, cy + 37, UI.dim);
        S.text('Age ' + fmtDur(s.ageMs), cx, cy + 47, UI.dim);
        S.rect(x + 5, y + 78, w - 10, 1, UI.inner);
        S.text(evolveLine(s), cx, y + 83, Pet.evolvesIn(s) == null ? UI.dim : UI.text);
        break;
      }
      case 1: S.text('Fullness', cx, cy, UI.dim); pips(cx, cy + 12, s.hunger, 4, UI.accent); S.text(s.hunger ? (s.hunger >= 3 ? 'Well fed.' : 'Could eat.') : 'Starving!', cx, cy + 26, UI.text); S.text('Wt ' + s.weight, cx, cy + 40, UI.dim); break;
      case 2: S.text('Spirit', cx, cy, UI.dim); pips(cx, cy + 12, s.happy, 4, UI.blue); S.text(s.happy ? (s.happy >= 3 ? 'Fired up.' : 'Restless.') : 'Miserable.', cx, cy + 26, UI.text); break;
      case 3: {
        S.text('Obedience', cx, cy, UI.dim);
        S.rect(cx, cy + 12, 72, 7, UI.edge); S.rect(cx + 1, cy + 13, 70, 5, '#343b48');
        S.rect(cx + 1, cy + 13, Math.round(70 * s.discipline / 100), 5, UI.green);
        S.text(s.discipline + '%', cx, cy + 26, UI.text);
        S.text('Care mistakes ' + s.careMistakes, cx, cy + 40, UI.dim);
        break;
      }
      case 4: {
        const st = s.st || {};
        S.text('Wins ' + s.wins + '  Losses ' + (s.battles - s.wins), cx, cy, UI.text);
        S.text('Training ' + s.training, cx, cy + 10, UI.text);
        S.text('This stage: W' + (st.wins || 0) + ' L' + (st.losses || 0), cx, cy + 22, UI.dim);
        S.text('Trained ' + (st.training || 0) + '  Mistakes ' + (st.careMistakes || 0), cx, cy + 32, UI.dim);
        if (f.move) S.text('Move: ' + f.move, cx, cy + 44, UI.dim);
        if (f.special) S.text('Special: ' + f.special.name, cx, cy + 54, UI.dim);
        break;
      }
    }
    for (let i = 0; i < STATUS_PAGES; i++) S.rect(x + w / 2 - 12 + i * 6, y + h - 8, 3, 3, i === ui.page ? UI.accent : '#4a5366');
    if (blink(t, 500)) S.text('>', x + w - 10, y + h - 11, UI.accent);
    zone(-20, -80, W + 40, H + 100, nextStatusPage, { x: x + w - 14, y: y + h - 14, w: 10, h: 10 }, 'status');
  }
  function nextStatusPage() { ui.page++; if (ui.page >= STATUS_PAGES) back(); }

  // ---------------------------------------------------------------- care animations
  function eatAnim(food, result) {
    const key = petKey(), b = sz(key), fb = sz(food);
    if (result === 'refuse') return refuseAnim(food);
    A.sfx('eat');
    startAnim(2400, (t, pr) => {
      const bite = Math.min(3, Math.floor(pr * 4));
      const px = Math.floor(W / 2) - 4, fx = px - fb.w - 1, fy = FOOT - fb.h + 1;
      if (bite < 3) S.art(food, fx, fy, { clipX: 0, frame: 0, alpha: 1 - bite * 0.25 });
      drawPet(key, px, groundY(key) + (blink(t, 300) ? 0 : 1), false);
      if (Math.floor(t / 600) !== Math.floor((t - 100) / 600)) A.sfx('eat');
    }, () => { if (result === 'sick') { ui.emote = 'skull'; ui.emoteUntil = now() + 2500; } });
  }
  function refuseAnim(prop) {
    A.sfx('no');
    const key = petKey(), b = sz(key);
    startAnim(1600, (t) => {
      const x = Math.floor((W - b.w) / 2);
      drawPet(key, x + (blink(t, 120) ? 1 : -1), groundY(key), false);
      if (prop) { const a = sz(prop); S.art(prop, 4, FOOT - a.h + 1); }
      drawEmote('angry', x, groundY(key), b.w);
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
  function cleanAnim() {
    const key = petKey(), had = state.poops.length, oldPoops = state.poops.slice();
    Pet.clean(state);
    A.sfx('ok');
    startAnim(1500, (t, pr) => {
      const wx = Math.floor(pr * (W + 16)) - 8;
      oldPoops.forEach((p, i) => { const [x, y] = poopSlot(i); if (i < 4 && x < wx) S.art('dung', x, y); });
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
    startAnim(1700, (t, pr) => {
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

  // ---------------------------------------------------------------- training mini-game (left / right)
  function startPlay() {
    ui.mode = 'play';
    ui.play = { round: 1, score: 0, phase: 'wait', t0: now(), guess: null, dir: null };
  }
  function playGuess(g) {
    const P = ui.play;
    if (!P || P.phase !== 'wait') return;
    P.guess = g; P.dir = U.chance(0.5) ? -1 : 1;
    P.hit = P.guess === P.dir; if (P.hit) P.score++;
    P.phase = 'reveal'; P.t0 = now();
    A.sfx(P.hit ? 'ok' : 'no');
  }
  function drawPlay(t) {
    const P = ui.play, key = petKey(), b = sz(key), cx = Math.floor((W - b.w) / 2);
    S.label('TRAINING  ' + P.round + '/5   HITS ' + P.score, -26, UI.text);
    if (P.phase === 'wait') {
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
        if (P.round >= 5) { P.phase = 'done'; P.t0 = t; const r = Pet.playDone(state, P.score); A.sfx(r.result === 'win' ? 'win' : 'lose'); P.result = r.result; P.gain = r; }
        else { P.round++; P.phase = 'wait'; }
      }
    } else {
      drawPet(key, cx, groundY(key) - (P.result === 'win' && blink(t, 200) ? 2 : 0), false);
      S.label(P.result === 'win' ? 'Good session!' : 'Sloppy today...', -18, P.result === 'win' ? UI.green : UI.red);
      S.label('+' + P.gain.xp + ' XP' + (P.gain.levelUp ? '   Lv ' + P.gain.level + '!' : ''), -2, P.gain.levelUp ? UI.accent : UI.text);
      if (t - P.t0 > 2200) { ui.play = null; back(); }
    }
  }

  // ---------------------------------------------------------------- battles (Gen-3 style layout)
  /* ui.battle = { kind:'cpu'|'friend'|'online', me, opp (display: {card,hp,max}), phase, queue, driver, role, cur }
   * phase: found -> intro -> idle/choose/wait/anim ... -> end. The driver pushes events into B.queue:
   *   {type:'turn', role:'atk'|'def'}  {type:'result', attacker:'me'|'opp', res, hp:{me,opp}}  {type:'end', won, reason}
   * Local battles (CPU / friend code) use localDriver; online battles are driven by server messages. */
  const ANIM_MS = 1900;
  function newBattle(kind, meView, oppView, driver) {
    const B = { kind, me: meView, opp: oppView, phase: kind === 'online' ? 'found' : 'intro', t0: now(), queue: [], driver, role: null, cur: null,
                shownHp: { me: meView.hp, opp: oppView.hp } };
    ui.battle = B; ui.mode = 'battle'; ui.sel = 7;
    A.sfx('ok');
    return B;
  }
  function localDriver(B, Lme, Lopp) {
    let attacker = 'me';
    const push = (e) => B.queue.push(e);
    return {
      start() { push({ type: 'turn', role: 'atk' }); },
      move(dir) {
        let res;
        if (attacker === 'me') res = T.Battle.attack(Lme, Lopp, dir, T.Battle.cpuGuess(Lopp, Lme));
        else res = T.Battle.attack(Lopp, Lme, U.pick(['hi', 'lo']), dir);
        push({ type: 'result', attacker, res, hp: { me: Lme.hp, opp: Lopp.hp } });
        attacker = attacker === 'me' ? 'opp' : 'me';
        if (Lme.hp <= 0 || Lopp.hp <= 0) push({ type: 'end', won: Lopp.hp <= 0, reason: 'ko' });
        else push({ type: 'turn', role: attacker === 'me' ? 'atk' : 'def' });
      },
      leave() {}
    };
  }
  function startLocalBattle(oppCard, kind) {
    const Lme = T.Battle.fighter(T.Battle.card(state)), Lopp = T.Battle.fighter(oppCard);
    const B = newBattle(kind, T.Battle.view(Lme), T.Battle.view(Lopp), null);
    B.driver = localDriver(B, Lme, Lopp);
    B.driver.start();
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
    finishBattle(B, false, 'fled');
  }
  function finishBattle(B, won, reason) {
    B.phase = 'end'; B.won = won; B.reason = reason; B.t0 = now();
    if (reason !== 'lost') {
      B.gain = Pet.battleDone(state, won ? 'win' : reason === 'fled' ? 'fled' : 'loss', T.Battle.level(B.opp.card));
      A.sfx(won ? 'win' : 'lose');
    } else A.sfx('no');
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
      else if (e.type === 'end') finishBattle(B, e.won, e.reason);
    }
    if (B.phase === 'end' && t - B.t0 > 3400) { ui.battle = null; back(); }
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
      msg = msgLines(B.kind === 'online' ? 'Waiting for ' + B.opp.card.name + '...' : '...');
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
      if (B.gain && B.gain.xp && el > 700) msg.push('Gained ' + B.gain.xp + ' XP.' + (B.gain.levelUp ? ' Lv ' + B.gain.level + '!' : ''));
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

  // ---------------------------------------------------------------- online: search -> match or fall back
  function startSearch() {
    back();
    ui.mode = 'search';
    const Q = ui.search = { t0: now(), B: null };
    const payload = { card: T.Battle.card(state), ageMs: Math.round(state.ageMs) };
    const alive = () => Q.B && ui.battle === Q.B;
    Q.session = T.Net.findMatch(payload, {
      onMatched(m) {
        if (ui.search !== Q) { Q.session.leave(); return; }
        ui.search = null;
        const view = (v) => ({ card: v.card, hp: v.hp, max: v.max });
        Q.B = newBattle('online', view(m.you), view(m.opp), {
          move: (dir) => Q.session.move(dir),
          leave: () => Q.session.leave()
        });
        Q.B.id = m.id;
      },
      onTurn(m) { if (alive()) Q.B.queue.push({ type: 'turn', role: m.role }); },
      onResult(m) { if (alive()) Q.B.queue.push({ type: 'result', attacker: m.attacker === 'you' ? 'me' : 'opp', res: m.res, hp: { me: m.hp.you, opp: m.hp.opp } }); },
      onEnd(m) {
        if (!alive()) return;
        Q.B.queue.push(m.result === 'lost' ? { type: 'end', won: false, reason: 'lost' } : { type: 'end', won: m.result === 'win', reason: m.reason });
      },
      onFail(why) {
        if (ui.search !== Q) return;
        ui.search = null; ui.fallbackReason = why;
        back();
        const msg = why === 'nomatch' ? 'No rival found.' : why.startsWith('rejected') ? 'The server refused.' : 'Server offline.';
        A.sfx('no');
        noticeAnim(msg, 'A wild monster appeared!', 2200, () => startLocalBattle(T.Battle.cpuCard(state.stage, Pet.level(state)), 'cpu'));
      }
    });
  }
  function cancelSearch() {
    const Q = ui.search;
    if (Q && Q.session) Q.session.cancel();
    ui.search = null; back();
  }
  function drawSearch(t) {
    const Q = ui.search, key = petKey(), b = sz(key), el = t - Q.t0, L = battleLayout();
    const x = Math.floor((W - b.w) / 2) - 16;
    drawPet(key, x, groundY(key), true);
    const cx = x + b.w + 3, cy = groundY(key) + 8, w = Math.floor(el / 250) % 4;
    if (w >= 1) S.glyph('wave1', cx, cy - 2, UI.blue);
    if (w >= 2) S.glyph('wave2', cx + 4, cy - 4, UI.blue);
    if (w >= 3) S.glyph('wave3', cx + 9, cy - 6, UI.blue);
    const k = Math.floor(el / 400) % 4;
    S.panel(0, L.tb, W, 38);
    S.text('Finding a rival' + '.'.repeat(k), 6, L.tb + 6);
    const left = U.clamp(1 - el / C.SEARCH_MS, 0, 1);
    S.rect(6, L.tb + 18, W - 12, 5, UI.edge); S.rect(7, L.tb + 19, Math.round((W - 14) * left), 3, UI.blue);
    S.text('Back to cancel', 6, L.tb + 27, UI.dim);
  }

  // ---------------------------------------------------------------- friend code panel (DOM)
  function openLinkPanel() {
    const p = document.getElementById('linkPanel');
    document.getElementById('myCode').textContent = T.Battle.encode(T.Battle.card(state));
    document.getElementById('linkError').textContent = '';
    p.hidden = false;
  }
  function closeLinkPanel() { document.getElementById('linkPanel').hidden = true; }
  function linkFight() {
    const code = document.getElementById('friendCode').value.trim();
    const card = T.Battle.decode(code);
    if (!card) { document.getElementById('linkError').textContent = "That code doesn't look right."; A.sfx('no'); return; }
    closeLinkPanel(); back(); startLocalBattle(card, 'friend');
  }

  // ---------------------------------------------------------------- actions & input
  function activate(i) {
    const name = ICONS[i];
    if (!name) return;
    if (state.asleep && name !== 'light' && name !== 'status') return refuseAnim(null);
    switch (name) {
      case 'feed': ui.mode = 'feedMenu'; ui.sub = 0; break;
      case 'light': ui.mode = 'lightMenu'; ui.sub = state.lightsOff ? 1 : 0; break;
      case 'play': if (state.sick) refuseAnim(null); else startPlay(); break;
      case 'medicine': medicineAnim(Pet.medicine(state)); break;
      case 'bath': cleanAnim(); break;
      case 'status': ui.mode = 'status'; ui.page = 0; break;
      case 'discipline': scoldAnim(Pet.scold(state)); break;
      case 'battle':
        if (state.sick) refuseAnim(null);
        else { ui.mode = 'battleMenu'; ui.sub = 0; }
        break;
    }
  }
  const BUSY = ['play', 'battle', 'search'];
  function canTapIcons() { return !ui.anim && !state.dead && state.stage !== 'egg' && !BUSY.includes(ui.mode) && ui.mode !== 'deadConfirm'; }

  function tapIcon(name) {
    A.unlock(); ui.lastInput = 'tap';
    if (!canTapIcons()) { if (!ui.anim) A.sfx('no'); return; }
    A.sfx('click');
    const i = ICONS.indexOf(name);
    back(); ui.sel = i; activate(i);
    renderHUD();
  }
  function backAvailable() { return !ui.anim && (ui.mode !== 'main' || ui.sel !== -1); }
  function goBack() {
    if (ui.anim) return;
    switch (ui.mode) {
      case 'main': ui.sel = -1; break;
      case 'play': ui.play = null; back(); break;
      case 'battle': fleeBattle(); break;
      case 'search': cancelSearch(); break;
      case 'deadConfirm': ui.mode = 'main'; break;
      default: back();
    }
    renderHUD();
  }

  function tapScene(e) {
    e.preventDefault(); A.unlock(); ui.lastInput = 'tap';
    const t = now();
    if (ui.anim || t < ui.tapLock) return;
    render();                                   // make sure the zones match what's on screen right now
    if (ui.anim) return;
    const p = S.toStage(e.clientX, e.clientY);
    let z = null;
    for (let i = ui.zones.length - 1; i >= 0; i--) {
      const q = ui.zones[i];
      if (p.x >= q.x && p.x < q.x + q.w && p.y >= q.y && p.y < q.y + q.h) { z = q; break; }
    }
    if (!z) return;
    A.sfx('click');
    // brief highlight only for real buttons/choices (never on the pet or full-screen tap areas)
    ui.tapFx = z.box && z.id !== 'pet' ? { x: z.box.x, y: z.box.y, w: z.box.w, h: z.box.h, until: t + 110 } : null;
    ui.tapLock = t + 120;
    setTimeout(() => { z.fn(); render(); renderHUD(); }, 100);
  }

  /** Optional keyboard: A = next/left/high, B = ok/right/low, C = back. */
  function press(btn) {
    A.unlock(); ui.lastInput = 'key';
    if (ui.anim) return;
    A.sfx('click');
    if (btn === 'C') return goBack();
    if (state.dead) { if (btn === 'B') { if (ui.mode === 'deadConfirm') newEgg(); else ui.mode = 'deadConfirm'; } return; }
    if (state.stage === 'egg') return;
    switch (ui.mode) {
      case 'main':
        if (btn === 'A') ui.sel = (ui.sel + 1) % ICONS.length; else activate(ui.sel);
        break;
      case 'feedMenu': if (btn === 'A') ui.sub ^= 1; else FEED_OPTS()[ui.sub].fn(); break;
      case 'lightMenu': if (btn === 'A') ui.sub ^= 1; else LIGHT_OPTS()[ui.sub].fn(); break;
      case 'battleMenu': if (btn === 'A') ui.sub = (ui.sub + 1) % 3; else BATTLE_OPTS()[ui.sub].fn(); break;
      case 'status': nextStatusPage(); break;
      case 'play': playGuess(btn === 'A' ? -1 : 1); break;
      case 'battle': battleMove(btn === 'A' ? 'hi' : 'lo'); break;
    }
    renderHUD();
  }

  function newEgg() {
    state = Pet.create();
    ui = freshUI();
    Pet.save(state);
  }

  // ---------------------------------------------------------------- events from the simulation
  function handleEvents(ev, offline) {
    for (const e of ev) {
      switch (e.type) {
        case 'hatch': if (!offline) hatchAnim(); break;
        case 'evolve': if (ui.mode !== 'battle' && ui.mode !== 'search') evolveAnim(e.from, e.to); break;
        case 'call': case 'sick':
          if (!offline && now() - ui.lastCallBeep > 3000) { ui.lastCallBeep = now(); A.sfx('call'); }
          break;
        case 'death':
          if (ui.search) cancelSearch();
          if (ui.battle && ui.battle.driver) ui.battle.driver.leave();
          ui.anim = null; ui.queue = []; ui.mode = 'main'; ui.play = null; ui.battle = null; ui.sel = -1;
          closeLinkPanel();
          if (!offline) A.sfx('death');
          break;
        case 'sleep':
          if (ui.mode === 'play') { ui.play = null; back(); }
          break;
      }
    }
    if (offline) { const evo = ev.filter(e => e.type === 'evolve'); ui.queue = []; ui.anim = null; if (evo.length) evolveAnim(evo[0].from, evo[evo.length - 1].to); }
  }

  // ---------------------------------------------------------------- render
  function render() {
    const t = now();
    ui.zones = [];
    S.begin(t, envFor());
    if (ui.anim) {
      const a = ui.anim, el = t - a.t0;
      if (el >= a.dur) { endAnim(); return render(); }
      a.draw(el, el / a.dur);
    } else if (state.dead) {
      if (ui.mode === 'deadConfirm') drawDeadConfirm(); else drawDead(t);
    } else {
      switch (ui.mode) {
        case 'feedMenu': case 'lightMenu': case 'battleMenu':
          updatePet(t); drawMain(t, true); ui.zones = []; dim();
          drawOptions(ui.mode === 'feedMenu' ? FEED_OPTS() : ui.mode === 'lightMenu' ? LIGHT_OPTS() : BATTLE_OPTS(), TITLES[ui.mode]);
          break;
        case 'status': drawStatus(t); break;
        case 'play': drawPlay(t); break;
        case 'battle': drawBattle(t); break;
        case 'search': drawSearch(t); break;
        default: updatePet(t); drawMain(t);
      }
    }
    if (ui.tapFx && t < ui.tapFx.until) S.flash(ui.tapFx.x, ui.tapFx.y, ui.tapFx.w, ui.tapFx.h);
  }

  function renderHUD() {
    const enabled = canTapIcons();
    ICONS.forEach((n, i) => { hud[n].classList.toggle('on', ui.sel === i && ui.mode !== 'main'); hud[n].disabled = !enabled; });
    hud.attention.classList.toggle('alert', Pet.needsAttention(state));
    const bk = backAvailable();
    hud.back.disabled = !bk; hud.back.classList.toggle('ready', bk);
    document.body.dataset.mode = ui.mode;
    document.body.dataset.env = envFor();
  }

  function makeHUD() {
    const mk = (name, parent, kind) => {
      const el = document.createElement(kind === 'indicator' ? 'div' : 'button');
      el.className = 'pbtn' + (kind === 'indicator' ? ' indicator' : '') + (name === 'back' ? ' back' : '');
      if (kind !== 'indicator') el.type = 'button'; else el.setAttribute('role', 'status');
      el.setAttribute('aria-label', LABELS[name]);
      el.dataset.icon = name; el.title = LABELS[name];
      const cv = document.createElement('canvas'); cv.className = 'picon';
      T.Scene.iconCanvas(cv, 'i_' + name, '#d6deea', 3);
      el.appendChild(cv); parent.appendChild(el);
      hud[name] = el;
      return el;
    };
    const top = document.getElementById('barTop'), bot = document.getElementById('barBottom');
    TOP_BAR.forEach(n => mk(n, top).addEventListener('click', () => tapIcon(n)));
    mk('attention', top, 'indicator');
    mk('back', bot).addEventListener('click', () => { A.unlock(); ui.lastInput = 'tap'; A.sfx('click'); goBack(); });
    ['status', 'discipline', 'battle'].forEach(n => mk(n, bot).addEventListener('click', () => tapIcon(n)));
    mk('sound', bot).addEventListener('click', toggleMute);
  }

  /** Fill the viewport with the scene; keep the stage between the HUD bars. */
  function fit() {
    const vw = window.innerWidth, vh = window.innerHeight;
    const top = document.getElementById('barTop').getBoundingClientRect().bottom;
    const bot = vh - document.getElementById('barBottom').getBoundingClientRect().top;
    S.resize(vw, vh, top, bot);
    if (state) render();
  }

  // ---------------------------------------------------------------- loop
  function tick() {
    const real = Date.now(); const dt = real - lastReal; lastReal = real;
    if (dt > 5000) handleEvents(Pet.simulate(state, dt * C.SPEED, null, { away: true }), true);
    else if (dt > 0) handleEvents(Pet.simulate(state, dt * C.SPEED), false);
    render(); renderHUD();
    if (real - lastSave > 5000) { lastSave = real; Pet.save(state); }
  }

  function bindInput() {
    const map = { '1': 'A', 'a': 'A', '2': 'B', 'b': 'B', '3': 'C', 'c': 'C', 'escape': 'C', 'enter': 'B' };
    document.addEventListener('keydown', (e) => {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (!document.getElementById('linkPanel').hidden) return;
      const k = e.key.toLowerCase();
      if (k === 'enter' && e.target && e.target.tagName === 'BUTTON') return;
      if (map[k]) { e.preventDefault(); press(map[k]); }
      else if (k === 'm') toggleMute();
    });
    S.c.addEventListener('pointerdown', tapScene);
    S.c.addEventListener('contextmenu', (e) => e.preventDefault());
    document.getElementById('copyCode').addEventListener('click', () => {
      const txt = document.getElementById('myCode').textContent, btn = document.getElementById('copyCode');
      const ok = () => { btn.textContent = 'Copied'; setTimeout(() => (btn.textContent = 'Copy'), 1200); };
      if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(txt).then(ok, () => selectCode());
      else { selectCode(); try { document.execCommand('copy'); ok(); } catch (e) {} }
    });
    document.getElementById('linkFight').addEventListener('click', linkFight);
    document.getElementById('linkClose').addEventListener('click', closeLinkPanel);
    document.getElementById('friendCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') linkFight(); });
    document.getElementById('friendCode').addEventListener('input', () => { document.getElementById('linkError').textContent = ''; });
    const save = () => Pet.save(state);
    window.addEventListener('pagehide', save);
    window.addEventListener('beforeunload', save);
    document.addEventListener('visibilitychange', () => { if (document.hidden) save(); });
    window.addEventListener('resize', fit);
    window.addEventListener('orientationchange', () => setTimeout(fit, 200));
  }
  function selectCode() {
    const r = document.createRange(); r.selectNodeContents(document.getElementById('myCode'));
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
  }
  function toggleMute() {
    A.setMuted(!A.muted); updateMute();
    if (!A.muted) { A.unlock(); A.sfx('ok'); }
  }
  function updateMute() {
    const m = hud.sound;
    T.Scene.iconCanvas(m.querySelector('canvas'), A.muted ? 'i_mute' : 'i_sound', '#d6deea', 3);
    m.classList.toggle('muted', A.muted);
    m.setAttribute('aria-label', A.muted ? 'Sound is off. Turn sound on' : 'Sound is on. Turn sound off');
    m.setAttribute('aria-pressed', String(!A.muted));
  }

  function init() {
    A.init();
    S = new T.Scene(document.getElementById('scene'));
    makeHUD();
    ui = freshUI();
    state = Pet.load();
    if (state) {
      const away = Date.now() - (state.lastSaved || Date.now());
      if (away > 2000) handleEvents(Pet.simulate(state, away * C.SPEED, null, { away: true }), true);
    } else state = Pet.create();
    lastReal = Date.now();
    bindInput(); updateMute(); fit();
    Pet.save(state);
    tick();
    setInterval(tick, 100);
    if (C.DEBUG && T.Debug) T.Debug.init();
  }

  // Public API (debug panel, tests, and future layers).
  T.Game = {
    init, press, tapIcon, goBack,
    get state() { return state; },
    set state(s) { state = s; },
    get ui() { return ui; },
    get scene() { return S; },
    /** Stage coords -> client coords (for tests / tooling). */
    stageToClient(x, y) { return S.toClient(x, y); },
    /** Client coords of the centre of the tappable zone with this id (null if not on screen). */
    zonePoint(id) {
      render();
      const z = ui.zones.find(q => q.id === id); if (!z) return null;
      const b = z.box || z; return S.toClient(b.x + b.w / 2, b.y + b.h / 2);
    },
    resetUI() { ui = freshUI(); },
    newEgg, evolveAnim, startLocalBattle, startSearch, render, handleEvents
  };

  document.addEventListener('DOMContentLoaded', init);
})(window.Tama);
