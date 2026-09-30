/* TAMA-PIX — UI controller: tap/keyboard input, menus, animations, mini-game, battles, main loop.
 *
 * Rendering: a full-screen pixel-art scene (scene.js). Gameplay is drawn on a 48x24 "stage" standing on the
 * meadow; negative y reaches up into the sky (used for labels and overlay panels).
 * Input: HUD buttons along the top/bottom (tap = run that action, ↩ = back) and tappable "zones" that each
 * screen registers while drawing (see zone()). Keyboard is optional: 1/A next, 2/B ok, 3/C back, M mute.
 */
(function (T) {
  'use strict';
  const C = T.CONFIG, U = T.util, SPR = T.SPR, Pet = T.Pet, A = T.Audio;
  const W = C.STAGE_W, H = C.STAGE_H;
  const INK = T.INK, RED = '#e8263b', WATER = '#5ec8ff';
  const ICONS = ['feed', 'light', 'play', 'medicine', 'bath', 'status', 'discipline', 'battle'];
  const TOP_BAR = ['feed', 'light', 'play', 'medicine', 'bath'];
  const LABELS = { feed: 'Feed', light: 'Light', play: 'Play', medicine: 'Medicine', bath: 'Clean up', status: 'Status',
                   discipline: 'Discipline', battle: 'Battle', attention: 'Needs attention', back: 'Back', sound: 'Sound' };
  const TITLES = { feedMenu: 'FEED', lightMenu: 'LIGHT', battleMenu: 'BATTLE' };
  const STATUS_PAGES = 5;
  const POOP_SLOTS = [[40, 17], [40, 10], [40, 3], [32, 17]];

  let S, hud = {}, state, ui, lastReal = Date.now(), lastSave = 0;

  function freshUI() {
    return {
      mode: 'main', sel: -1, sub: 0, page: 0,
      anim: null, queue: [], zones: [], tapFx: null, tapLock: 0, lastInput: 'tap',
      pet: { x: 16, dir: 1, move: 'walk', lastStep: 0 }, petted: 0,
      emote: null, emoteUntil: 0, nextThink: 0, thought: '',
      play: null, battle: null, search: null, lastCallBeep: 0, fallbackReason: null
    };
  }

  // ---------------------------------------------------------------- helpers
  const now = () => performance.now();
  const petKey = (id) => (SPR[id || state.formId] ? (id || state.formId) : 'pixbit');
  const petSpr = (id) => SPR[petKey(id)];
  const blink = (t, ms) => Math.floor(t / (ms || 400)) % 2 === 0;
  const groundY = (b) => H - b.h;
  function rightLimit() { const n = state.poops.length; return n >= 4 ? 31 : n ? 39 : W; }

  /** Register a tappable area (stage coords) for the frame being drawn; box = area to flash when tapped. */
  function zone(x, y, w, h, fn, box) { ui.zones.push({ x, y, w, h, fn, box: box || null }); }

  function startAnim(dur, draw, onEnd, onStart, env) {
    const a = { dur, draw, onEnd, onStart, env, t0: 0 };
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
    const b = SPR[key];
    S.shadow(x, H, b.w);
    S.art(key, x, y, Object.assign({ flip }, opts || {}));
  }
  function drawEmote(name, px, py, pw) {
    const b = SPR.bubble;
    let x = px + pw - 1, flip = false;
    if (x + b.w > Math.min(W, rightLimit() + 2)) { x = px - b.w + 1; flip = true; }
    x = U.clamp(x, -2, W - b.w + 2);
    const y = py - 8;
    S.art('bubble', x, y, { flip });
    S.glyph('e_' + name, x + 3, y + 2);
  }
  function drawHearts(n, y) {
    const x0 = Math.floor((W - 27) / 2);
    for (let i = 0; i < 4; i++) S.art(i < n ? 'heartFull' : 'heartEmpty', x0 + i * 7, y);
  }
  function drawPoops(t) {
    state.poops.forEach((p, i) => S.art('poop', POOP_SLOTS[i][0], POOP_SLOTS[i][1]));
    const n = Math.min(3, state.poops.length);
    if (n) S.glyph(blink(t, 500) ? 'stink1' : 'stink2', 42, POOP_SLOTS[n - 1][1] - 5);
  }
  function drawSparkles(t, cx, cy) {
    const r = 9 + (Math.floor(t / 150) % 3);
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([dx, dy], i) => {
      if ((Math.floor(t / 150) + i) % 2) S.glyph('sparkle', cx + dx * r - 2, cy + dy * (r - 3) - 2);
    });
  }
  function button(x, y, w, h, label, hi, icon) {
    S.panel(x, y, w, h, hi ? S.HILITE : null);
    S.text(label, x + 3, y + Math.floor((h - 5) / 2));
    if (icon) S.art(icon, x + w - SPR[icon].w - 3, y + Math.floor((h - SPR[icon].h) / 2));
  }

  /** Stacked choices on a panel. opts: [{label, icon, fn}] (2 or 3 items). */
  function drawOptions(opts, title) {
    const n = opts.length, boxH = n === 2 ? 10 : 9, gap = n === 2 ? 3 : 2;
    const total = n * boxH + (n - 1) * gap, y0 = Math.round(H / 2 - total / 2), x = 4, w = 40;
    if (title) S.label(title, y0 - 10);
    opts.forEach((o, i) => {
      const y = y0 + i * (boxH + gap);
      button(x, y, w, boxH, o.label, ui.lastInput === 'key' && ui.sub === i, o.icon);
      const zt = i === 0 ? y0 - 14 : y - Math.floor(gap / 2), zb = i === n - 1 ? H + 12 : y + boxH + Math.ceil(gap / 2);
      zone(-8, zt, W + 16, zb - zt, o.fn, { x, y, w, h: boxH });
    });
  }

  function envFor() {
    if (ui.mode === 'battle') return 'arena';
    if (state.dead) return 'dusk';
    if (state.lightsOff) return 'night';
    if (state.asleep) return 'dusk';
    return 'day';
  }

  // ---------------------------------------------------------------- main idle screen
  function updatePet(t) {
    const b = petSpr(), p = ui.pet;
    if (state.stage === 'egg' || state.dead) return;
    if (t >= ui.nextThink) {
      const d = T.Personality.think(state);
      p.move = d.move; ui.thought = d.thought;
      if (d.move === 'turn') p.dir *= -1;
      if (d.emote) { ui.emote = d.emote; ui.emoteUntil = t + 2600; }
      ui.nextThink = t + U.rand(3000, 6000);
    }
    if (state.asleep) { p.x = Math.round((rightLimit() - b.w) / 2); return; }
    if (t - p.lastStep > 500) {
      p.lastStep = t;
      if (p.move === 'walk' && t > ui.petted) {
        if (U.chance(0.08)) p.dir *= -1;
        p.x += p.dir * 2;
      }
    }
    const maxX = rightLimit() - b.w - 1;
    if (p.x > maxX) { p.x = maxX; p.dir = -1; }
    if (p.x < 1) { p.x = 1; p.dir = 1; }
  }

  function drawMain(t, noZones) {
    if (state.dead) return drawDead(t);
    if (state.stage === 'egg') {
      const b = SPR.egg, poked = t < ui.petted;
      const wob = poked || state.eggMs > C.T.HATCH * 0.6 ? (blink(t, 120) ? 1 : -1) : (blink(t, 900) ? 0 : 1);
      const x = Math.floor((W - b.w) / 2);
      drawPet('egg', x + wob, groundY(b), false);
      if (!noZones) zone(x - 4, -6, b.w + 8, H + 6, () => { ui.petted = now() + 800; });
      return;
    }
    const key = petKey(), b = SPR[key], p = ui.pet;
    const hop = !state.asleep && (p.move === 'hop' || t < ui.petted);
    const bob = state.asleep ? 0 : (hop ? (blink(t, 250) ? -2 : 0) : (blink(t, 500) ? 0 : -1));
    drawPoops(t);
    drawPet(key, p.x, groundY(b) + bob, !state.asleep && p.dir < 0);
    if (state.lightsOff) S.overlay('rgba(4, 6, 24, 0.38)');
    if (state.asleep) {
      const k = Math.floor(t / 600) % 4;
      for (let i = 0; i < 3; i++) if (i <= k) S.text('Z', p.x + b.w + i * 4, groundY(b) - 3 - i * 5, state.lightsOff ? '#cfe0ff' : '#ffffff');
    } else {
      if (state.sick && blink(t, 500)) S.glyph('e_skull', p.x - 6, groundY(b) - 4);
      if (ui.emote && t < ui.emoteUntil) drawEmote(ui.emote, p.x, groundY(b), b.w);
    }
    if (noZones) return;
    zone(p.x - 3, groundY(b) - 4, b.w + 6, b.h + 4, () => {
      ui.petted = now() + 1400;
      ui.emote = state.asleep ? 'angry' : state.sick ? 'sweat' : (state.happy >= 2 ? U.pick(['heart', 'note']) : 'question');
      ui.emoteUntil = now() + 1800; ui.nextThink = now() + 2500;
    });
  }

  function drawDead(t) {
    const key = petKey(), b = SPR[key], tomb = SPR.tomb;
    S.shadow(W - tomb.w - 3, H, tomb.w);
    S.art('tomb', W - tomb.w - 3, H - tomb.h);
    const bob = Math.round(Math.sin(t / 400) * 1.5);
    const y = H - b.h - 6 + bob;
    S.art(key, 4, y, { alpha: 0.8 });
    S.art('halo', 4 + Math.floor(b.w / 2) - 3, y - 4);
    if (blink(t, 600)) S.label('NEW EGG?', -8);
    zone(-4, -12, W + 8, H + 12, () => { ui.mode = 'deadConfirm'; }, { x: 12, y: -10, w: 24, h: 9 });
  }
  function drawDeadConfirm() {
    drawDead(0);
    ui.zones = [];
    S.overlay('rgba(20, 10, 30, 0.35)');
    S.panel(6, -6, 36, 28);
    S.textC('NEW EGG?', -2);
    button(13, 8, 22, 10, 'YES', ui.lastInput === 'key');
    zone(-4, 4, W + 8, H, newEgg, { x: 13, y: 8, w: 22, h: 10 });
  }

  // ---------------------------------------------------------------- menus / status
  const FEED_OPTS = () => [
    { label: 'MEAL', icon: 'meal', fn: () => feed(false) },
    { label: 'SNACK', icon: 'snack', fn: () => feed(true) }];
  const LIGHT_OPTS = () => [
    { label: 'ON', icon: null, fn: () => setLights(true) },
    { label: 'OFF', icon: null, fn: () => setLights(false) }];
  const BATTLE_OPTS = () => [
    { label: 'RANDOM', icon: null, fn: startSearch },
    { label: 'FRIEND', icon: null, fn: openLinkPanel },
    { label: 'COMPUTER', icon: null, fn: () => { back(); startLocalBattle(T.Battle.cpuCard(state.stage), 'cpu'); } }];

  function feed(snack) { back(); eatAnim(snack ? 'snack' : 'meal', snack ? Pet.feedSnack(state) : Pet.feedMeal(state)); }
  function setLights(on) { Pet.setLights(state, on); A.sfx('ok'); back(); }

  function drawStatus(t) {
    const s = state, f = T.FORMS[s.formId];
    drawMain(t, true);
    S.overlay('rgba(20, 10, 30, 0.25)');
    S.panel(2, -10, 44, 35);
    switch (ui.page) {
      case 0:
        S.textC(s.name, -6); S.textC(f.name, 3, '#9c1465');
        S.textC(Math.floor(s.ageMs / C.T.DAY) + 'Y ' + s.weight + 'G', 11); break;
      case 1: S.textC('HUNGRY', -6); drawHearts(s.hunger, 4); break;
      case 2: S.textC('HAPPY', -6); drawHearts(s.happy, 4); break;
      case 3: {
        S.textC('DISCIPLINE', -6);
        S.frame(5, 4, 38, 7);
        const segs = Math.round(s.discipline / 25);
        for (let i = 0; i < segs; i++) S.rect(7 + i * 9, 6, 7, 3, '#5ec85e');
        S.textC(s.discipline + '%', 13);
        break;
      }
      case 4:
        S.textC('BATTLE', -6); S.textC('W' + s.wins + ' L' + (s.battles - s.wins), 3);
        S.textC('TRAIN ' + s.training, 11); break;
    }
    for (let i = 0; i < STATUS_PAGES; i++) { if (i === ui.page) S.rect(15 + i * 4, 19, 2, 2); else S.rect(15 + i * 4, 20, 1, 1, '#b09a80'); }
    if (blink(t, 500)) S.text('>', 40, 18, '#9c1465');
    zone(-4, -12, W + 8, H + 12, nextStatusPage, { x: 39, y: 17, w: 5, h: 7 });
  }
  function nextStatusPage() { ui.page++; if (ui.page >= STATUS_PAGES) back(); }

  // ---------------------------------------------------------------- care animations
  function eatAnim(food, result) {
    const key = petKey(), b = SPR[key], fb = SPR[food];
    if (result === 'refuse') return refuseAnim(food);
    A.sfx('eat');
    startAnim(2400, (t, pr) => {
      const bite = Math.min(3, Math.floor(pr * 4));
      const px = 8, fx = px + b.w + 2, fy = H - fb.h - 1;
      if (bite < 3) S.art(food, fx, fy, { clipX: bite * 2 + (bite ? 1 : 0) });
      drawPet(key, px, groundY(b) - (blink(t, 300) ? 0 : 1), false);
      if (Math.floor(t / 600) !== Math.floor((t - 100) / 600)) A.sfx('eat');
    }, () => { if (result === 'sick') { ui.emote = 'skull'; ui.emoteUntil = now() + 2500; } });
  }
  function refuseAnim(prop) {
    A.sfx('no');
    const key = petKey(), b = SPR[key];
    startAnim(1600, (t) => {
      const x = Math.floor((W - b.w) / 2) - 6;
      drawPet(key, x, groundY(b), blink(t, 200));
      if (prop) S.art(prop, W - SPR[prop].w - 3, H - SPR[prop].h - 1);
      drawEmote('angry', x, groundY(b), b.w);
    });
  }
  function happyAnim(emote, ms) {
    A.sfx('happy');
    const key = petKey(), b = SPR[key];
    startAnim(ms || 1500, (t) => {
      const x = Math.floor((W - b.w) / 2);
      drawPet(key, x, groundY(b) - (blink(t, 250) ? 2 : 0), false);
      if (emote) drawEmote(emote, x, groundY(b), b.w);
    });
  }
  function cleanAnim() {
    const key = petKey(), b = SPR[key], had = state.poops.length, oldPoops = state.poops.slice();
    Pet.clean(state);
    A.sfx('ok');
    startAnim(1500, (t, pr) => {
      const wx = Math.floor(pr * (W + 8)) - 4;
      oldPoops.forEach((p, i) => { if (POOP_SLOTS[i][0] > wx) S.art('poop', POOP_SLOTS[i][0], POOP_SLOTS[i][1]); });
      drawPet(key, ui.pet.x, groundY(b), false);
      for (let y = -2; y < H; y++) {
        const o = (y >> 1) % 2;
        S.rect(wx + o, y, 2, 1, WATER); S.rect(wx - 2 + o, y, 2, 1, 'rgba(94,200,255,0.45)');
        if (y % 5 === 0) S.rect(wx + 2 + o, y, 1, 1, '#ffffff');
      }
    }, () => { if (had) happyAnim('note', 1200); });
  }
  function medicineAnim(result) {
    if (result === 'refuse') return refuseAnim('syringe');
    A.sfx('ok');
    const key = petKey(), b = SPR[key], sy = SPR.syringe;
    startAnim(1700, (t, pr) => {
      const px = 4; drawPet(key, px, groundY(b), false);
      const sx = Math.round(W - sy.w - pr * (W - sy.w - px - b.w - 1));
      if (pr < 0.85) S.art('syringe', sx, H - 9, { flip: true });
    }, () => {
      if (result === 'cured') happyAnim('heart', 1400);
      else { ui.emote = 'sweat'; ui.emoteUntil = now() + 2000; }
    });
  }
  function scoldAnim(result) {
    const key = petKey(), b = SPR[key];
    A.sfx(result === 'ok' ? 'ok' : 'no');
    startAnim(1700, (t, pr) => {
      const x = Math.floor((W - b.w) / 2) + 4;
      drawPet(key, x, groundY(b), false);
      if (blink(t, 200)) { S.panel(1, 0, 7, 20); S.rect(3, 2, 3, 11, RED); S.rect(3, 15, 3, 3, RED); }
      if (pr > 0.5) drawEmote(result === 'ok' ? 'sweat' : 'angry', x, groundY(b), b.w);
    });
  }
  function noticeAnim(line1, line2, ms, onEnd) {
    startAnim(ms || 2000, (t) => {
      drawMain(t, true);
      if (t > 250 || blink(t, 80)) S.label(line1, -6);
      if (line2 && t > 500) S.label(line2, 6, '#9c1465');
    }, onEnd);
  }
  function hatchAnim() {
    A.sfx('hatch');
    startAnim(2600, (t, pr) => {
      const e = SPR.egg, ex = Math.floor((W - e.w) / 2), ey = groundY(e), wob = blink(t, 90) ? 1 : -1;
      if (pr < 0.65) {
        drawPet('egg', ex + wob, ey, false);
        if (pr > 0.35) for (let i = 1; i < e.w - 1; i++) S.rect(ex + i + wob, ey + 6 + (i % 2), 1, 1);
      } else if (pr < 0.75) {
        S.overlay('rgba(255,255,255,0.9)');
      } else {
        const key = petKey(), b = SPR[key], x = Math.floor((W - b.w) / 2);
        drawPet(key, x, groundY(b) - (blink(t, 200) ? 2 : 0), false);
        drawSparkles(t, x + b.w / 2, groundY(b) + 2);
      }
    });
  }
  function evolveAnim(from, to) {
    startAnim(3600, (t, pr) => {
      const ob = petSpr(from), nb = petSpr(to), fk = petKey(from), tk = petKey(to);
      const cx = (b) => Math.floor((W - b.w) / 2);
      if (pr < 0.62) {
        const period = 320 - 270 * (pr / 0.62);
        if (Math.floor(t / period) % 2) { S.overlay('rgba(255,255,255,0.85)'); S.art(tk, cx(nb), groundY(nb), { silhouette: INK }); }
        else drawPet(fk, cx(ob), groundY(ob), false);
      } else if (pr < 0.7) {
        S.overlay(blink(t, 60) ? 'rgba(255,255,255,0.95)' : 'rgba(255,240,150,0.6)');
      } else {
        drawPet(tk, cx(nb), groundY(nb) - (blink(t, 250) ? 1 : 0), false);
        drawSparkles(t, W / 2, groundY(nb) + nb.h / 2);
        S.label(T.FORMS[to].name, -8, '#9c1465');
      }
    }, null, () => A.sfx('evolve'));
  }

  // ---------------------------------------------------------------- play mini-game (left / right)
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
    const P = ui.play, key = petKey(), b = SPR[key], cx = Math.floor((W - b.w) / 2);
    S.label(P.round + '/5  HIT ' + P.score, -8);
    if (P.phase === 'wait') {
      drawPet(key, cx, groundY(b), false);
      button(0, 9, 9, 11, '<', ui.lastInput === 'key' && blink(t, 500));
      button(W - 9, 9, 9, 11, '>', ui.lastInput === 'key' && !blink(t, 500));
      S.glyph('e_question', cx + b.w + 1 > 38 ? cx - 6 : cx + b.w + 1, groundY(b) - 2);
      zone(-8, -12, W / 2 + 8, H + 12, () => playGuess(-1), { x: 0, y: 9, w: 9, h: 11 });
      zone(W / 2, -12, W / 2 + 8, H + 12, () => playGuess(1), { x: W - 9, y: 9, w: 9, h: 11 });
    } else if (P.phase === 'reveal') {
      const el = t - P.t0, x = cx + P.dir * 7;
      drawPet(key, x, groundY(b) - (P.hit && blink(t, 200) ? 2 : 0), P.dir < 0);
      if (el > 300) drawEmote(P.hit ? 'heart' : 'sweat', x, groundY(b), b.w);
      if (el > 1300) {
        if (P.round >= 5) { P.phase = 'done'; P.t0 = t; const r = Pet.playDone(state, P.score); A.sfx(r === 'win' ? 'win' : 'lose'); P.result = r; }
        else { P.round++; P.phase = 'wait'; }
      }
    } else {
      drawPet(key, cx, groundY(b) - (P.result === 'win' && blink(t, 200) ? 2 : 0), false);
      S.label(P.result === 'win' ? 'WIN!' : 'LOSE', 0, P.result === 'win' ? '#1d8a3a' : RED);
      if (t - P.t0 > 1800) { ui.play = null; back(); }
    }
  }

  // ---------------------------------------------------------------- battles
  /* ui.battle = { kind:'cpu'|'friend'|'online', me, opp (display: {card,hp,max}), phase, queue, driver, role, cur }
   * phase: found -> intro -> idle/choose/wait/anim ... -> end. The driver pushes events into B.queue:
   *   {type:'turn', role:'atk'|'def'}  {type:'result', attacker:'me'|'opp', res, hp:{me,opp}}  {type:'end', won, reason}
   * Local battles (CPU / friend code) use localDriver; online battles are driven by server messages. */
  function newBattle(kind, meView, oppView, driver) {
    const B = { kind, me: meView, opp: oppView, phase: kind === 'online' ? 'found' : 'intro', t0: now(), queue: [], driver, role: null, cur: null };
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
    if (reason !== 'lost') { Pet.battleDone(state, won); A.sfx(won ? 'win' : 'lose'); } else A.sfx('no');
  }
  function battleStep(t) {
    const B = ui.battle;
    if (B.phase === 'found' && t - B.t0 > 1100) { B.phase = 'intro'; B.t0 = t; }
    if (B.phase === 'intro' && t - B.t0 > 1600) { B.phase = 'idle'; B.t0 = t; }
    if (B.phase === 'anim' && t - B.t0 > 1400) { B.me.hp = B.cur.hp.me; B.opp.hp = B.cur.hp.opp; B.phase = 'idle'; B.t0 = t; }
    if ((B.phase === 'idle' || B.phase === 'wait') && B.queue.length) {
      const e = B.queue.shift();
      if (e.type === 'turn') { B.phase = 'choose'; B.role = e.role; B.t0 = t; }
      else if (e.type === 'result') { B.phase = 'anim'; B.cur = e; B.t0 = t; A.sfx('shoot'); }
      else if (e.type === 'end') finishBattle(B, e.won, e.reason);
    }
    if (B.phase === 'end' && t - B.t0 > 2600) { ui.battle = null; back(); }
  }
  function drawHP(f, right, name) {
    const w = f.max * 2 + 3, x = right ? W - w : 0;
    S.panel(x, -2, w, 7);
    for (let i = 0; i < f.max; i++) {
      const px = right ? x + w - 3 - i * 2 : x + 2 + i * 2;
      S.rect(px, 0, 1, 3, i < f.hp ? '#ff4d6d' : '#c9b8a8');
    }
    const nm = String(name).slice(0, 6);
    S.text(nm, right ? W - S.textW(nm) - 1 : 1, -9);
  }
  function drawBattle(t) {
    battleStep(t);
    const B = ui.battle;
    if (!B) return drawMain(t);
    const mk = petKey(B.me.card.formId), ok = petKey(B.opp.card.formId), mb = SPR[mk], ob = SPR[ok];
    const el = t - B.t0, ox = W - ob.w;
    let meVis = true, oppVis = true, myY = groundY(mb), opY = groundY(ob), showHP = true, overlayUI = null;

    if (B.phase === 'found') {
      showHP = false; meVis = false; oppVis = false;
      overlayUI = () => { if (blink(t, 180)) S.label('FOUND!', -2, '#1d8a3a'); S.label(B.opp.card.name, 9); };
    } else if (B.phase === 'intro') {
      showHP = false;
      overlayUI = () => { S.label(B.kind === 'online' ? 'LIVE VS' : 'VS', 6, RED); S.label(B.opp.card.name.slice(0, 8), -8); };
    } else if (B.phase === 'choose') {
      overlayUI = () => {
        S.label(B.role === 'atk' ? 'ATTACK!' : 'GUARD!', -18, B.role === 'atk' ? RED : '#1d6ad8');
        const hl = ui.lastInput === 'key' && blink(t, 500);
        S.panel(16, 3, 16, 9, hl ? S.HILITE : null); S.text('HI', 19, 5); S.glyph('up3', 27, 6);
        S.panel(16, 14, 16, 9, hl ? S.HILITE : null); S.text('LO', 19, 16); S.glyph('down3', 27, 17);
      };
      zone(-8, -24, W + 16, 24 + 13, () => battleMove('hi'), { x: 16, y: 3, w: 16, h: 9 });
      zone(-8, 13, W + 16, 24, () => battleMove('lo'), { x: 16, y: 14, w: 16, h: 9 });
    } else if (B.phase === 'wait' || B.phase === 'idle') {
      if (B.kind === 'online' && blink(t, 400)) overlayUI = () => S.label('WAIT', 8);
    } else if (B.phase === 'anim') {
      const r = B.cur.res, mine = B.cur.attacker === 'me';
      const y = r.dir === 'hi' ? 9 : 17;
      const x0 = mine ? mb.w + 1 : ox - 4, x1 = mine ? ox - 4 : mb.w + 1;
      const pr = Math.min(1, el / 650);
      overlayUI = () => {
        if (r.special && blink(t, 150)) S.label(r.special + '!', -18, RED);
        if (r.stunned) S.label('STUNNED', -18);
        else if (pr < 1) S.art('fireball', Math.round(x0 + (x1 - x0) * pr), y);
        else {
          const defX = mine ? ox - 3 : mb.w + 1;
          if (r.blocked || r.absorbed) { for (let j = -3; j <= 3; j++) S.rect(defX + (mine ? 1 : 0), y + 1 + j, 1, 1, '#9fe0ff'); S.label('BLOCK', -8, '#1d6ad8'); }
          else if (r.dodged) S.label('MISS', -8);
          else if (r.hit) S.label('-' + r.dmg, -8, RED);
        }
      };
      if (pr >= 1) {
        if (!B.cur.applied) { B.cur.applied = true; B.me.hp = B.cur.hp.me; B.opp.hp = B.cur.hp.opp; A.sfx(r.hit ? 'hit' : 'block'); }
        if (r.hit && blink(t, 90)) { if (mine) oppVis = false; else meVis = false; }
        else if (r.dodged) { if (mine) opY -= 4; else myY -= 4; }
      }
    } else if (B.phase === 'end') {
      showHP = false;
      if (B.won) myY -= blink(t, 200) ? 2 : 0; else if (B.reason !== 'lost') opY -= blink(t, 200) ? 2 : 0;
      overlayUI = () => S.label(B.reason === 'lost' ? 'LINK LOST' : B.won ? 'WIN!' : 'LOSE', -8, B.won ? '#1d8a3a' : RED);
    }
    if (showHP) { drawHP(B.me, false, B.me.card.name); drawHP(B.opp, true, B.opp.card.name); }
    S.shadow(0, H, mb.w); S.shadow(ox, H, ob.w);
    if (meVis) S.art(mk, 0, myY, { flip: false });
    if (oppVis) S.art(ok, ox, opY, { flip: true });
    if (overlayUI) overlayUI();
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
        const msg = why === 'nomatch' ? 'NO RIVAL' : why.startsWith('rejected') ? 'REJECTED' : 'OFFLINE';
        A.sfx('no');
        noticeAnim(msg, 'VS CPU', 2200, () => startLocalBattle(T.Battle.cpuCard(state.stage), 'cpu'));
      }
    });
  }
  function cancelSearch() {
    const Q = ui.search;
    if (Q && Q.session) Q.session.cancel();
    ui.search = null; back();
  }
  function drawSearch(t) {
    const Sx = ui.search, key = petKey(), b = SPR[key], el = t - Sx.t0;
    const k = Math.floor(el / 400) % 4;
    S.label('SEARCH' + '.'.repeat(k) + ' '.repeat(3 - k), -8);
    const py = groundY(b), cy = py + Math.floor(b.h / 2);
    drawPet(key, 1, py, false);
    const x0 = b.w + 3, w = Math.floor(el / 250) % 4;
    if (w >= 1) S.glyph('wave1', x0, cy - 2, '#1d6ad8');
    if (w >= 2) S.glyph('wave2', x0 + 4, cy - 4, '#1d6ad8');
    if (w >= 3) S.glyph('wave3', x0 + 9, cy - 6, '#1d6ad8');
    if (blink(t, 500)) S.glyph('e_question', 40, 8);
    const left = U.clamp(1 - el / C.SEARCH_MS, 0, 1);
    S.panel(31, 18, 16, 6); S.rect(33, 20, Math.round(12 * left), 2, '#5ec85e');
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
        if (state.stage === 'baby' || state.sick) refuseAnim(null);
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
    const b = z.box || z;
    ui.tapFx = { x: b.x, y: b.y, w: b.w, h: b.h, until: t + 110 };
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
          updatePet(t); drawMain(t, true); ui.zones = [];
          S.overlay('rgba(20, 10, 30, 0.28)');
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
    const att = Pet.needsAttention(state);
    hud.attention.classList.toggle('alert', att);
    const bk = backAvailable();
    hud.back.disabled = !bk; hud.back.classList.toggle('ready', bk);
    document.body.dataset.mode = ui.mode;
    document.body.dataset.env = envFor();
  }

  function makeHUD() {
    const mk = (name, parent, kind) => {
      const el = document.createElement(kind === 'indicator' ? 'div' : 'button');
      el.className = 'pbtn' + (kind === 'indicator' ? ' indicator' : '') + (name === 'back' ? ' back' : '');
      if (kind !== 'indicator') { el.type = 'button'; el.setAttribute('aria-label', LABELS[name]); }
      else { el.setAttribute('role', 'status'); el.setAttribute('aria-label', LABELS[name]); }
      el.dataset.icon = name; el.title = LABELS[name];
      const cv = document.createElement('canvas'); cv.className = 'picon';
      T.Scene.iconCanvas(cv, 'i_' + (name === 'sound' ? 'sound' : name), INK, 3);
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
    if (dt > 5000) handleEvents(Pet.simulate(state, Pet.offlineGameMs(dt)), true);
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
      const ok = () => { btn.textContent = 'Copied!'; setTimeout(() => (btn.textContent = 'Copy'), 1200); };
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
    T.Scene.iconCanvas(m.querySelector('canvas'), A.muted ? 'i_mute' : 'i_sound', INK, 3);
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
      if (away > 2000) handleEvents(Pet.simulate(state, Pet.offlineGameMs(away)), true);
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
    resetUI() { ui = freshUI(); },
    newEgg, evolveAnim, startLocalBattle, startSearch, render
  };

  document.addEventListener('DOMContentLoaded', init);
})(window.Tama);
