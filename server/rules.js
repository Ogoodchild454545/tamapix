/* TAMA-PIX authoritative game rules (server side).
 * Loads the SAME js/config.js, evolution.js, battle.js, pet.js and economy.js the browser uses (vm sandbox), then
 * applies player actions to the stored game with server timestamps: the simulation, energy, coins, daily caps,
 * jobs, XP taper, level caps and battle rewards are all computed here. The browser only sends intents.
 *
 * game = { v, pet, eco, train, lastSim, lastReq, debug:{offset,speed}, events:[] }
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const sandbox = { window: {}, URLSearchParams, btoa, atob, console, Math, Date, Intl };
vm.createContext(sandbox);
for (const f of ['config.js', 'evolution.js', 'battle.js', 'pet.js', 'economy.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'), sandbox, { filename: f });
}
const T = sandbox.window.Tama;
const { CONFIG: C, FORMS, Battle, Evolution, Pet, Economy: E } = T;
const U = T.util, TT = C.T;
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const clone = (o) => JSON.parse(JSON.stringify(o));
const MAX_EVENTS = 30;

// ------------------------------------------------------------------ helpers
function fail(error, msg, extra) { return Object.assign({ ok: false, error, msg }, extra || {}); }
function push(game, e) { game.events.push(Object.assign({ at: Date.now() }, e)); if (game.events.length > MAX_EVENTS) game.events.splice(0, game.events.length - MAX_EVENTS); }
function blankDaily() { return { drinks: 0, actions: 0, earnback: 0, battleCoins: 0, friendXp: 0, careActs: 0 }; }
function simNow(game, real) { return real + ((game.debug && game.debug.offset) || 0); }
function dayKey(game, t) { return U.local(t, game.pet.tz || 'UTC').key; }

function addCoins(game, delta, reason, tx) {
  if (!delta) return;
  game.eco.coins = Math.max(0, game.eco.coins + delta);
  tx.push({ delta, reason, balance: game.eco.coins });
}
function spendEnergy(game, n) {
  const p = game.pet;
  p.energy = Math.max(0, (p.energy || 0) - n);
  if (p.energy <= 0) push(game, { type: 'tired' });
}
/** +2 energy for an on-time care action (max +10 a day). */
function earnBack(game) {
  const d = game.eco.daily, EN = C.ENERGY;
  if (d.earnback >= EN.EARNBACK_MAX) return 0;
  const n = Math.min(EN.EARNBACK, EN.EARNBACK_MAX - d.earnback);
  d.earnback += n; game.pet.energy = Math.min(EN.MAX, game.pet.energy + n);
  return n;
}
function levelUpCoins(game, gain, tx) { if (gain && gain.levels > 0) addCoins(game, E.COINS.levelUp * gain.levels, 'level_up', tx); }

function refillInfo(p) {
  const EN = C.ENERGY;
  return { sleepPerH: EN.SLEEP_PER_H, napPerH: EN.NAP_PER_H, fullInMs: Math.round((EN.MAX - p.energy) / EN.SLEEP_PER_H * TT.HOUR) };
}
/** Can the pet do something right now? what: 'care' | 'active' (train/battle/job) | 'food'. */
function available(game, what) {
  const p = game.pet;
  if (p.dead) return fail('dead', 'Your monster has died.');
  if (p.stage === 'egg') return fail('egg', "It's still an egg.");
  if (p.job) return fail('working', 'Away at work (' + p.job.name + ').');
  if (p.asleep) return fail('asleep', p.napping ? "It collapsed from exhaustion and is napping." : "It's asleep. Turn the lights on to wake it.");
  if (what === 'active' && p.sick) return fail('sick', "It's sick. Give it medicine first.");
  return null;
}
function needEnergy(game, n) {
  const p = game.pet;
  if (p.energy + 1e-9 >= n) return null;
  return fail('energy', 'Not enough energy (' + Math.floor(p.energy) + '/' + n + ').', { refill: refillInfo(p) });
}

// ------------------------------------------------------------------ game lifecycle
function newPet(game, t) {
  const p = Pet.create();
  p.createdAt = t; p.tz = (game && game.pet && game.pet.tz) || null;
  return p;
}
function newGame(tz, real) {
  const game = { v: 1, pet: null, eco: null, train: null, lastSim: real, lastReq: real, debug: { offset: 0, speed: 1 }, events: [] };
  game.pet = newPet(null, real);
  game.pet.tz = U.validTz(tz) ? tz : 'UTC';
  game.eco = { coins: E.START_COINS, inventory: { pickaxe: 1, ore: 0 }, dayKey: dayKey(game, real), daily: blankDaily(),
               gift: { idx: 0, last: null }, lastJob: null };
  return game;
}
/** Older stored games get new fields (schema changes inside the JSON). */
function upgrade(game) {
  game.events = game.events || []; game.debug = game.debug || { offset: 0, speed: 1 };
  game.eco.daily = Object.assign(blankDaily(), game.eco.daily || {});
  game.eco.inventory = Object.assign({ pickaxe: 1, ore: 0 }, game.eco.inventory || {});
  game.pet = Object.assign(Pet.create(), game.pet);
  game.pet.st = Object.assign(Evolution.blankStageStats(), game.pet.st || {});
  return game;
}

/** Process simulation events: job pay, evolution coins, and queue what the client should show. */
function applySimEvents(game, ev, tx) {
  for (const e of ev) {
    switch (e.type) {
      case 'jobDone': {
        const j = e.job, inv = game.eco.inventory;
        addCoins(game, j.pay, 'job:' + j.id, tx);
        inv.ore = (inv.ore || 0) + (j.ore || 0);
        game.eco.lastJob = { id: j.id, name: j.name, coins: j.pay, ore: j.ore || 0, at: Date.now(), seen: false };
        push(game, { type: 'jobDone', job: j.id, name: j.name, coins: j.pay, ore: j.ore || 0 });
        break;
      }
      case 'evolve': addCoins(game, E.COINS.evolve, 'evolve', tx); push(game, { type: 'evolve', from: e.from, to: e.to }); break;
      case 'hatch': push(game, { type: 'hatch' }); break;
      case 'death': push(game, { type: 'death', cause: e.cause }); break;
      case 'sick': case 'sleep': case 'wake': case 'tired': push(game, e); break;
      case 'call': if (e.why !== 'happy') push(game, e); break;
    }
  }
}
/** Close a (local) day: pay yesterday's care bonus if earned, reset daily caps. */
function settleDay(game, newKey, tx) {
  const p = game.pet, d = game.eco.daily;
  if (!p.dead && p.stage !== 'egg' && !p.careLow && d.careActs >= E.CARE_BONUS_MIN_ACTS) {
    addCoins(game, E.COINS.careBonus, 'care_bonus', tx);
    push(game, { type: 'careBonus', coins: E.COINS.careBonus });
  }
  game.eco.daily = blankDaily(); game.eco.dayKey = newKey; p.careLow = false;
}

/** Bring the game up to `real` (server ms). present = a real player request (not a background sweep). */
function sync(game, real, present) {
  upgrade(game);
  const tx = [];
  const dbg = game.debug;
  if (dbg.speed && dbg.speed !== 1) dbg.offset += Math.max(0, real - (dbg.lastReal || real)) * (dbg.speed - 1);
  dbg.lastReal = real;
  const target = simNow(game, real);
  const away = real - (game.lastReq || real) > C.PRESENT_GAP_MS;
  let t = game.lastSim || target;
  while (t < target) {
    const toMid = Math.max(1000, U.toMidnight(t, game.pet.tz || 'UTC'));
    const chunk = Math.min(target - t, toMid);
    const ev = Pet.simulate(game.pet, chunk, null, { away: away || chunk > C.PRESENT_GAP_MS });
    applySimEvents(game, ev, tx);
    t += chunk;
    const k = dayKey(game, t);
    if (k !== game.eco.dayKey) settleDay(game, k, tx);
  }
  game.lastSim = Math.max(game.lastSim || 0, target);
  if (present) {
    game.lastReq = real;
    const today = dayKey(game, target), g = game.eco.gift;
    if (g.last !== today) {                                   // 7-day login gift calendar (pauses, never resets)
      const coins = E.GIFT[g.idx % E.GIFT.length];
      addCoins(game, coins, 'daily_gift', tx);
      push(game, { type: 'gift', day: (g.idx % E.GIFT.length) + 1, coins });
      g.idx = (g.idx + 1) % E.GIFT.length; g.last = today;
    }
  }
  return tx;
}

// ------------------------------------------------------------------ player actions
function act(game, a, real) {
  const tx = [];
  const r = actInner(game, a || {}, real, tx);
  r.tx = tx;
  return r;
}
function actInner(game, a, real, tx) {
  const p = game.pet, d = game.eco.daily;
  switch (a.type) {
    case 'feed': {
      const no = available(game, 'care'); if (no) return no;
      const onTime = !a.snack && p.hunger <= 1 && !p.hungerMistake;
      const result = a.snack ? Pet.feedSnack(p) : Pet.feedMeal(p);
      if (result !== 'refuse') d.careActs++;
      const energy = onTime && result === 'ok' ? earnBack(game) : 0;
      return { ok: true, result, energy };
    }
    case 'lights': {
      if (p.dead || p.stage === 'egg') return fail(p.dead ? 'dead' : 'egg', p.dead ? 'Your monster has died.' : "It's still an egg.");
      if (p.job) return fail('working', 'Away at work (' + p.job.name + ').');
      const result = Pet.setLights(p, !!a.on);
      if (result === 'sleep') push(game, { type: 'sleep', nap: false });
      return { ok: true, result };
    }
    case 'clean': {
      const no = available(game, 'care'); if (no) return no;
      const onTime = p.poops.length > 0 && p.poops.every(x => !x.counted);
      const result = Pet.clean(p);
      if (result === 'ok') d.careActs++;
      return { ok: true, result, energy: onTime && result === 'ok' ? earnBack(game) : 0 };
    }
    case 'medicine': {
      const no = available(game, 'care'); if (no) return no;
      const onTime = p.sick && !p.sickMistake;
      const result = Pet.medicine(p);
      if (result !== 'refuse') d.careActs++;
      return { ok: true, result, energy: onTime && result === 'cured' ? earnBack(game) : 0 };
    }
    case 'scold': {
      const no = available(game, 'care'); if (no) return no;
      const before = p.discipline;
      const result = Pet.scold(p);
      if (result === 'ok') d.careActs++;
      return { ok: true, result, discipline: p.discipline, before, energy: result === 'ok' ? earnBack(game) : 0 };
    }
    case 'train_start': {
      const no = available(game, 'active') || needEnergy(game, E.COST.train); if (no) return no;
      spendEnergy(game, E.COST.train);
      const mult = E.taperMult(d.actions); d.actions++;
      game.train = { dirs: Array.from({ length: 5 }, () => (Math.random() < 0.5 ? -1 : 1)), round: 0, hits: 0, mult, t0: real };
      return { ok: true, mult, energy: -E.COST.train };
    }
    case 'train_guess': {
      const Tr = game.train;
      if (!Tr) return fail('no_training', 'No training session running.');
      if (a.round !== Tr.round + 1 || (a.g !== -1 && a.g !== 1)) return fail('bad_guess', 'Out of sync.');
      const dir = Tr.dirs[Tr.round], hit = a.g === dir;
      Tr.round++; if (hit) Tr.hits++;
      const out = { ok: true, round: Tr.round, dir, hit, hits: Tr.hits, done: Tr.round >= 5 };
      if (out.done) {
        game.train = null;
        if (p.dead || p.stage === 'egg') return out;
        const g = Pet.playDone(p, Tr.hits, Tr.mult);
        levelUpCoins(game, g, tx);
        out.gain = Object.assign({ mult: Tr.mult }, g);
        if (g.levelUp) push(game, { type: 'levelUp', level: g.level });
      }
      return out;
    }
    case 'job_start': {
      const job = E.job(a.id);
      if (!job) return fail('bad_job', 'No such job.');
      const no = available(game, 'active'); if (no) return no;
      if (!job.stages.includes(p.stage)) return fail('locked', job.stages[0] === 'adult' ? 'Only final forms can do this job.' : 'Unlocks at the day-2 evolution.');
      const ne = needEnergy(game, job.energy); if (ne) return ne;
      spendEnergy(game, job.energy);
      p.job = { id: job.id, name: job.name, startT: p.simT, endT: p.simT + job.ms, pay: E.jobPay(job, game.eco.inventory), ore: job.ore };
      return { ok: true, job: p.job };
    }
    case 'job_recall': {
      if (!p.job) return fail('no_job', 'Not working.');
      const name = p.job.name; p.job = null;
      return { ok: true, result: 'recalled', name };
    }
    case 'job_seen': if (game.eco.lastJob) game.eco.lastJob.seen = true; return { ok: true };
    case 'buy': {
      const k = E.sku(a.sku);
      if (!k || !k.price || k.price.coins == null) return fail('bad_sku', 'Not for sale.');
      const cost = k.price.coins;
      if (k.kind === 'drink') {
        if (p.dead || p.stage === 'egg') return fail(p.dead ? 'dead' : 'egg', 'Nobody to drink it.');
        if (p.asleep) return fail('asleep', "It's asleep - drinks can't be used while sleeping.");
        if (d.drinks >= k.perDay) return fail('cap', "Your monster's had enough fizz today!");
        if (p.energy >= C.ENERGY.MAX) return fail('full', 'Energy is already full.');
      } else if (k.kind === 'food') {
        const no = available(game, 'care'); if (no) return no;
        if (k.hunger && p.hunger >= 4) return fail('full', "It's not hungry.");
      } else if (k.kind === 'tool') {
        const inv = game.eco.inventory;
        if ((inv[k.tool] || 1) >= k.tier) return fail('owned', 'You already have this.');
        if (k.tier > (inv[k.tool] || 1) + 1) return fail('needs', 'Buy the previous tier first.');
      }
      if (game.eco.coins < cost) return fail('coins', 'Not enough coins (' + game.eco.coins + '/' + cost + ').');
      addCoins(game, -cost, 'buy:' + k.id, tx);
      if (k.kind === 'drink') { d.drinks++; p.energy = Math.min(C.ENERGY.MAX, p.energy + k.energy); }
      else if (k.kind === 'food') {
        if (k.hunger) { p.hunger = Math.min(4, p.hunger + k.hunger); p.meals++; p.st.meals = (p.st.meals || 0) + 1; }
        if (k.happy) { p.happy = Math.min(4, p.happy + k.happy); p.snacks++; p.st.snacks = (p.st.snacks || 0) + 1; }
        p.weight += k.weight || 0;
      } else if (k.kind === 'tool') game.eco.inventory[k.tool] = k.tier;
      return { ok: true, sku: k.id, coins: game.eco.coins, energy: p.energy, drinksLeft: k.perDay ? k.perDay - d.drinks : null };
    }
    case 'new_egg': {
      if (!p.dead) return fail('alive', 'Your monster is still alive.');
      game.pet = newPet(game, simNow(game, real)); game.train = null;
      return { ok: true };
    }
    default: return fail('bad_action', 'Unknown action.');
  }
}

// ------------------------------------------------------------------ battles (called by the WebSocket layer)
/** Check + pay for a battle. kind: 'cpu' | 'online' | 'friend' (friend codes and challenges). Returns {ok, mult} or a failure. */
function battleStart(game, kind) {
  const no = available(game, 'active'); if (no) return no;
  const cost = E.COST[kind] || 0, ne = needEnergy(game, cost); if (ne) return ne;
  spendEnergy(game, cost);
  const d = game.eco.daily;
  let mult;
  if (kind === 'friend') { mult = d.friendXp < E.FRIEND_XP_PER_DAY ? 1 : 0; d.friendXp++; }
  else { mult = E.taperMult(d.actions); d.actions++; }
  return { ok: true, mult, energy: -cost };
}
/** Apply a finished battle. result: 'win' | 'loss' | 'fled'. Returns {gain, tx}. */
function battleEnd(game, kind, result, foeLevel, mult) {
  const tx = [], p = game.pet;
  if (p.dead || p.stage === 'egg') return { gain: null, tx };
  const g = Pet.battleDone(p, result, foeLevel, mult);
  levelUpCoins(game, g, tx);
  let coins = 0;
  if (kind === 'cpu' && result === 'win') coins = E.COINS.cpuWin;
  if (kind === 'online') coins = result === 'win' ? E.COINS.onlineWin : result === 'loss' ? E.COINS.onlineLoss : 0;
  const d = game.eco.daily;
  coins = Math.max(0, Math.min(coins, E.COINS.battleCapPerDay - d.battleCoins));
  if (coins) { d.battleCoins += coins; addCoins(game, coins, 'battle_' + kind, tx); }
  if (g.levelUp) push(game, { type: 'levelUp', level: g.level });
  return { gain: Object.assign({ coins, mult }, g), tx };
}
function card(game) { return Battle.card(game.pet); }

// ------------------------------------------------------------------ view (what the client gets)
/** What the client gets. events = the queued events drained for this response (see server mutate). */
function view(game, real, events) {
  const p = clone(game.pet);
  const lj = game.eco.lastJob;
  const out = {
    pet: p,
    eco: { coins: game.eco.coins, inventory: clone(game.eco.inventory), daily: clone(game.eco.daily), gift: clone(game.eco.gift),
           lastJob: lj ? clone(lj) : null, dayKey: game.eco.dayKey,
           taperMult: E.taperMult(game.eco.daily.actions), levelCap: E.levelCap(p.stage), toMidnight: U.toMidnight(simNow(game, real), p.tz || 'UTC') },
    train: game.train ? { round: game.train.round, hits: game.train.hits } : null,
    serverNow: real, simNow: simNow(game, real),
    events: events || []
  };
  return out;
}

// ------------------------------------------------------------------ one-time import of an old browser save
const NAME_RE = /^[A-Z0-9]{1,8}$/;
function importSave(game, raw, real) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('bad_save', 'That save could not be read.');
  const notes = [];
  const int = (v, lo, hi, what) => {
    let n = Number.isFinite(+v) ? Math.floor(+v) : lo;
    const c = Math.max(lo, Math.min(hi, n)); if (c !== n && what) notes.push(what + ' clamped'); return c;
  };
  let o = raw;
  if ((raw.v || 1) < 2) { try { o = clone(Pet.migrate(clone(raw))); } catch (e) { return fail('bad_save', 'That save could not be read.'); } }
  let form = T.LEGACY_FORMS[o.formId] || o.formId;
  if (typeof form !== 'string' || !own(FORMS, form)) { form = 'blob'; notes.push('unknown form -> BLOB'); }
  const s = Pet.create();
  s.name = NAME_RE.test(String(o.name || '')) ? o.name : s.name;
  const battles = int(o.battles, 0, 2000, 'battles'), training = int(o.training, 0, 2000, 'training');
  Object.assign(s, {
    training, battles, wins: Math.min(int(o.wins, 0, 2000), battles), plays: int(o.plays, 0, 4000),
    careMistakes: int(o.careMistakes, 0, 500), poopMistakes: int(o.poopMistakes, 0, 500), meals: int(o.meals, 0, 5000), snacks: int(o.snacks, 0, 5000),
    hunger: int(o.hunger, 0, 4), happy: int(o.happy, 0, 4), discipline: int(o.discipline, 0, 100)
  });
  if (FORMS[form].secret && battles < 15) { form = 'mimiko'; notes.push('secret form without the battles -> GALEHARE'); }
  s.formId = form; s.stage = FORMS[form].stage;
  s.weight = int(o.weight, C.MIN_WEIGHT[s.stage] || 5, 99, 'weight');
  const cap = Battle.xpFor(E.levelCap(s.stage)), plaus = training * 30 + battles * 80;
  s.xp = int(o.xp, 0, Math.min(cap, plaus), 'XP');
  s.history = (Array.isArray(o.history) ? o.history : []).map(f => T.LEGACY_FORMS[f] || f).filter(f => typeof f === 'string' && own(FORMS, f)).slice(-6);
  if (!s.history.length || s.history[0] !== 'egg') s.history.unshift('egg');
  if (s.history[s.history.length - 1] !== form) s.history.push(form);
  const st = o.st && typeof o.st === 'object' ? o.st : {};
  s.st = Evolution.blankStageStats();
  for (const k of Evolution.STAGE_KEYS) s.st[k] = Math.min(int(st[k], 0, 500), k === 'losses' ? battles - s.wins : (s[k] == null ? 500 : s[k]));
  if (s.stage === 'egg') { s.eggMs = int(o.eggMs, 0, TT.HATCH - 1000); s.ageMs = 0; }
  else {
    s.eggMs = TT.HATCH;
    const entry = Evolution.entryAge(form), maxAge = 30 * TT.DAY;
    const claimed = int(o.ageMs, 0, maxAge);
    s.ageMs = Math.max(entry, Math.min(claimed, s.stage === 'baby' ? TT.TEEN_AT - TT.HOUR : s.stage === 'teen' ? TT.ADULT_AT - TT.HOUR : maxAge));
    if (claimed < entry) notes.push('age set to the start of its stage');
  }
  const t = simNow(game, real);
  s.createdAt = t - s.eggMs - s.ageMs; s.simT = s.eggMs + s.ageMs; s.tz = game.pet.tz;
  s.poops = []; s.sick = false; s.energy = C.ENERGY.MAX;
  s.importedAt = t;
  game.pet = s; game.train = null; game.lastSim = t;
  return { ok: true, form: s.formId, name: s.name, level: Battle.levelFromXp(s.xp), notes };
}

// ------------------------------------------------------------------ debug (only reachable when the server runs with DEBUG=1)
function debugOp(game, a, real) {
  const p = game.pet, tx = [];
  const skip = (ms) => { game.debug.offset += ms; tx.push(...sync(game, real, true)); };
  switch (a.op) {
    case 'skip': skip(Math.max(0, Math.min(+a.ms || 0, 60 * TT.DAY))); break;
    case 'speed': game.debug.speed = Math.max(1, Math.min(+a.speed || 1, 100000)); game.debug.lastReal = real; break;
    case 'hatch': if (p.stage === 'egg') skip(Math.max(0, TT.HATCH - p.eggMs) + 500); break;
    case 'next': {
      if (p.stage === 'egg') { skip(Math.max(0, TT.HATCH - p.eggMs) + 500); break; }
      const at = Evolution.nextAgeAt(p);
      if (at != null && p.ageMs < at) skip(at - p.ageMs + 1500);
      break;
    }
    case 'patch': {
      const P = a.pet || {};
      for (const k in P) if (k !== 'st' && k !== 'formId' && k !== 'stage') p[k] = P[k];
      if (P.st) Object.assign(p.st, P.st);
      if (a.eco) { const e = a.eco; if (e.coins != null) addCoins(game, Math.round(e.coins) - game.eco.coins, 'debug', tx);
        if (e.daily) Object.assign(game.eco.daily, e.daily); if (e.inventory) Object.assign(game.eco.inventory, e.inventory); if (e.gift) Object.assign(game.eco.gift, e.gift); }
      break;
    }
    case 'force': {
      const to = a.form;
      if (!own(FORMS, to) || to === 'egg') return fail('bad_form', 'Unknown form.');
      if (p.stage === 'egg') { p.eggMs = TT.HATCH; Pet.simulate(p, 1000); }
      const from = p.formId;
      Pet.evolve(p, to);
      const entry = Evolution.entryAge(to);
      if (entry != null && p.ageMs < entry) { const d = entry + 1000 - p.ageMs; p.ageMs += d; p.createdAt -= d; }
      const nextAt = Evolution.nextAgeAt({ stage: p.stage });           // forced "down" a stage: move the age back into it
      if (entry != null && nextAt != null && p.ageMs >= nextAt) { const d = p.ageMs - (entry + 1000); p.ageMs -= d; p.createdAt += d; }
      if (a.anim) push(game, { type: 'evolve', from, to });
      break;
    }
    case 'sick': Pet.makeSick(p); break;
    case 'poop': if (p.poops.length < 4) p.poops.push({ age: 0, counted: false }); break;
    case 'fake': p.fakeCall = true; p.fakeCallMs = 0; break;
    case 'kill': p.dead = true; p.cause = 'debug'; break;
    case 'reset': game.pet = newPet(game, simNow(game, real)); game.train = null; break;
    case 'finish_job': if (p.job) skip(Math.max(0, p.job.endT - p.simT) + 500); break;
    case 'new_day': skip(U.toMidnight(simNow(game, real), p.tz || 'UTC') + 1000); break;
    default: return fail('bad_op', 'Unknown debug op.');
  }
  return { ok: true, tx };
}

module.exports = { T, C, E, FORMS, Battle, Evolution, Pet, newGame, upgrade, sync, act, battleStart, battleEnd, card, view, importSave, debugOp, available };
