/* TAMA-PIX — pet model: state, real-time simulation, care actions, XP, energy, jobs + old-save migration.
 * Pure logic, no drawing, no storage. The SERVER runs it (server/rules.js loads this file) from timestamps; the
 * browser only uses it for display helpers and the debug tree preview. Events are pushed to an array.
 *
 * Time: s.simT = total simulated ms; s.ageMs = ms since hatching. The pet's clock (for sleeping) is
 * s.createdAt + eggMs + ageMs in the player's time zone s.tz. Time away is simulated on the next request: the age
 * counts fully, needs decay at CONFIG.OFFLINE_FACTOR.
 */
(function (T) {
  'use strict';
  const C = T.CONFIG, TT = C.T, U = T.util;
  const SYL = ['PI', 'PO', 'MU', 'TA', 'KO', 'RI', 'NU', 'MI', 'BO', 'LU', 'KA', 'ZU', 'NE', 'CHI'];

  function randomName() { return U.pick(SYL) + U.pick(SYL); }

  function create() {
    return {
      v: C.SAVE_VERSION, name: randomName(), formId: 'egg', stage: 'egg', history: ['egg'],
      createdAt: Date.now(), eggMs: 0, ageMs: 0, simT: 0, tz: null,
      energy: C.ENERGY.MAX, napping: false, job: null, careLow: false,
      hunger: 2, happy: 2, weight: 5, discipline: 0,
      poops: [],                     // [{age, counted}]
      sick: false, sickMs: 0, doses: 0, sickMistake: false,
      asleep: false, lightsOff: false,
      dead: false, cause: '',
      hungerT: 0, happyT: 0, poopT: U.rand(TT.POOP_MIN, TT.POOP_MAX) * 0.5,
      hungerZeroMs: 0, happyZeroMs: 0, hungerMistake: false, happyMistake: false,
      fakeCall: false, fakeCallMs: 0, fakeT: U.rand(TT.FAKE_MIN, TT.FAKE_MAX),
      // lifetime counters
      careMistakes: 0, poopMistakes: 0, meals: 0, snacks: 0, recentSnacks: 0,
      battles: 0, wins: 0, training: 0, plays: 0, xp: 0,
      genes: T.Battle.rollGenes(),   // hidden per-pet stat bonus 0-15 each (server-side only, never sent to the browser)
      peptides: 0,                    // Evolve Peptides used in the current stage
      st: T.Evolution.blankStageStats(),   // counters of the current stage (reset at each evolution)
    };
  }

  /** Increment a lifetime counter and its per-stage twin. */
  function count(s, k, n) { n = n == null ? 1 : n; s[k] = (s[k] || 0) + n; s.st[k] = (s.st[k] || 0) + n; }
  function mistake(s, ev, why) {
    count(s, 'careMistakes');
    if (why === 'poop') count(s, 'poopMistakes');
    ev.push({ type: 'mistake', why });
  }

  function die(s, ev, cause) {
    if (s.dead) return;
    s.dead = true; s.cause = cause; s.asleep = false; s.lightsOff = false;
    ev.push({ type: 'death', cause });
  }

  function evolve(s, to, ev) {
    const from = s.formId;
    s.formId = to; s.stage = T.FORMS[to].stage; s.history.push(to);
    s.weight = Math.max(s.weight, C.MIN_WEIGHT[s.stage] || 5);
    s.st = T.Evolution.blankStageStats(); s.peptides = 0;
    ev.push({ type: 'evolve', from, to });
  }

  /** Local hour (0-24, fractional) on the pet's clock (player's time zone s.tz). */
  function clockHour(s) {
    const l = U.local(s.createdAt + s.eggMs + s.ageMs, s.tz || undefined);
    return l.h + l.mi / 60;
  }
  /** One simulation step: dt = game ms of age; k = need-decay factor (1 while playing, OFFLINE_FACTOR away). */
  function step(s, dt, ev, k) {
    if (s.dead) return;
    s.simT = (s.simT || 0) + dt;
    if (s.job && s.simT >= s.job.endT) { const job = s.job; s.job = null; ev.push({ type: 'jobDone', job }); }
    if (s.stage === 'egg') {
      s.eggMs += dt;
      if (s.eggMs >= TT.HATCH) {
        s.eggMs = TT.HATCH; evolve(s, 'blob', ev); ev[ev.length - 1].type = 'hatch'; s.hunger = 2; s.happy = 2;
      }
      return;
    }
    s.ageMs += dt;
    const EN = C.ENERGY;

    // --- sleep: only when the lights are off (sleeps until they go on, recharges fast) or when energy runs out
    // (collapses into a nap with the lights on and wakes once partly recharged). Never while away at a job.
    if (s.job) { if (s.asleep) { s.asleep = false; s.napping = false; } }
    else if (!s.asleep && (s.lightsOff || s.energy <= 0)) {
      s.asleep = true; s.napping = !s.lightsOff; ev.push({ type: 'sleep', nap: s.napping });
    }
    if (s.asleep) {
      if (s.lightsOff) s.napping = false;
      s.energy = Math.min(EN.MAX, (s.energy || 0) + (s.napping ? EN.NAP_PER_H : EN.SLEEP_PER_H) * dt / TT.HOUR);
      if (s.napping && s.energy >= EN.NAP_WAKE_AT) { s.asleep = false; s.napping = false; ev.push({ type: 'wake', nap: true }); }
    }
    const asleep = s.asleep;
    const nd = dt * k * (asleep ? C.SLEEP_DECAY : 1);   // "need time": softened while away, and while asleep

    // --- evolution (real age, asleep or awake)
    if (T.Evolution.due(s)) {
      const to = T.Evolution.pick(s);
      if (to) evolve(s, to, ev);
    }

    // --- hearts decay (faster while sick or working a job)
    const working = !!s.job, wk = working ? C.WORK_DECAY : 1;
    const hr = TT.HUNGER[s.stage] || 60 * TT.MIN, pr = TT.HAPPY[s.stage] || 60 * TT.MIN;
    s.hungerT += nd * (s.sick ? 1.5 : 1) * wk;
    if (s.hungerT >= hr) {
      s.hungerT -= hr;
      if (s.hunger > 0) { s.hunger--; s.weight = Math.max(C.MIN_WEIGHT[s.stage] || 5, s.weight - 1); if (!s.hunger) ev.push({ type: 'call', why: 'hunger' }); }
    }
    s.happyT += nd * (s.sick ? 1.5 : 1) * wk;
    if (s.happyT >= pr) { s.happyT -= pr; if (s.happy > 0) { s.happy--; if (!s.happy) ev.push({ type: 'call', why: 'happy' }); } }

    if (s.hunger === 0) {
      s.hungerZeroMs += nd;
      if (s.hungerZeroMs >= TT.CALL_TIMEOUT && !s.hungerMistake) { s.hungerMistake = true; mistake(s, ev, 'hunger'); }
      if (s.hungerZeroMs >= TT.STARVE_DEATH) return die(s, ev, 'hunger');
    } else { s.hungerZeroMs = 0; s.hungerMistake = false; }
    if (s.happy === 0) {
      s.happyZeroMs += nd;
      if (s.happyZeroMs >= TT.CALL_TIMEOUT && !s.happyMistake) { s.happyMistake = true; mistake(s, ev, 'happy'); }
    } else { s.happyZeroMs = 0; s.happyMistake = false; }

    // daily care bonus needs: hearts at 50%+ and no poop older than an hour (checked while awake at home)
    if (!working && !asleep && (s.hunger < 2 || s.happy < 2 || s.poops.some(p => p.age > TT.HOUR))) s.careLow = true;
    if (asleep && s.sick) {                  // sickness keeps going (slowly) in its sleep
      s.sickMs += nd;
      if (s.sickMs >= TT.SICK_TIMEOUT && !s.sickMistake) { s.sickMistake = true; mistake(s, ev, 'sick'); }
      if (s.sickMs >= TT.SICK_DEATH) return die(s, ev, 'sick');
    }
    if (working || asleep) return;           // away at work / asleep: no poop, sickness rolls or fake calls

    // --- poop
    s.poopT -= nd;
    if (s.poopT <= 0) {
      s.poopT = U.rand(TT.POOP_MIN, TT.POOP_MAX) * (s.stage === 'baby' ? 0.7 : 1);
      if (s.poops.length < 4) { s.poops.push({ age: 0, counted: false }); ev.push({ type: 'poop' }); }
    }
    for (const p of s.poops) {
      p.age += nd;
      if (p.age >= TT.POOP_TIMEOUT && !p.counted) { p.counted = true; mistake(s, ev, 'poop'); }
    }

    // --- sickness (chance per awake hour; a full floor of poop makes it sick at once)
    if (!s.sick) {
      const R = TT.SICK_RATE;
      const perHour = R.perPoop * s.poops.length + (s.hunger === 0 ? R.starving : 0) + (s.happy === 0 ? R.miserable : 0);
      if (s.poops.length >= 4 || Math.random() < perHour * nd / TT.HOUR) makeSick(s, ev);
    } else {
      s.sickMs += nd;
      if (s.sickMs >= TT.SICK_TIMEOUT && !s.sickMistake) { s.sickMistake = true; mistake(s, ev, 'sick'); }
      if (s.sickMs >= TT.SICK_DEATH) return die(s, ev, 'sick');
    }

    // --- discipline "fake" calls (pet acts up although it needs nothing)
    if (s.fakeCall) {
      s.fakeCallMs += nd;
      if (s.fakeCallMs >= TT.FAKE_TIMEOUT) { s.fakeCall = false; s.fakeT = U.rand(TT.FAKE_MIN, TT.FAKE_MAX); }
    } else if (!s.sick && s.hunger > 0 && s.happy > 0 && s.discipline < 100) {
      s.fakeT -= nd;
      if (s.fakeT <= 0) { s.fakeCall = true; s.fakeCallMs = 0; ev.push({ type: 'call', why: 'fake' }); }
    }
  }

  function makeSick(s, ev) {
    if (s.sick) return;
    s.sick = true; s.sickMs = 0; s.sickMistake = false; s.doses = Math.random() < 0.5 ? 1 : 2;
    ev && ev.push({ type: 'sick' });
  }

  /** Add XP (times the daily taper `mult`), capped at the stage's level cap. */
  function addXp(s, n, mult) {
    const B = T.Battle, before = B.levelFromXp(s.xp), capXp = B.xpFor(C.LEVEL_CAP[s.stage] || 40);
    const want = Math.max(0, Math.round(n * (mult == null ? 1 : mult)));
    const got = Math.max(0, Math.min(want, capXp - (s.xp | 0)));
    s.xp = (s.xp | 0) + got;
    const after = B.levelFromXp(s.xp);
    return { xp: got, level: after, levelUp: after > before, levels: after - before, capped: got < want };
  }

  // ---------------------------------------------------------------- save migration (v1 -> v2)
  const V1_STAGE = { pixbit: 'baby', blob: 'baby', mochi: 'child', kuchibo: 'child', nekoru: 'teen', scrapper: 'teen', blobbo: 'teen',
                     drakon: 'secret', seraphi: 'secret' };
  /** Old saves used a fast "game year" clock and five stages. Map the pet onto the new real-time tree:
   *  it keeps its form (old child/teen forms become day-2 forms, adults/secrets stay finals) and its age is
   *  set to the start of that stage; XP is estimated from its training/battle record. */
  function migrate(o) {
    const s = Object.assign(create(), o);
    const oldForm = o.formId || 'egg';
    let form = T.LEGACY_FORMS[oldForm] || oldForm;
    if (!Object.prototype.hasOwnProperty.call(T.FORMS, form)) form = 'blob';
    s.formId = form; s.stage = T.FORMS[form].stage;
    s.history = (o.history || [form]).map(f => T.LEGACY_FORMS[f] || f).filter(f => T.FORMS[f]);
    if (!s.history.length || s.history[s.history.length - 1] !== form) s.history.push(form);
    if (s.stage === 'egg') { s.eggMs = Math.min(o.eggMs || 0, TT.HATCH - 1000); s.ageMs = 0; }
    else {
      s.eggMs = TT.HATCH;
      s.ageMs = s.stage === 'baby' ? Math.min(o.ageMs || 0, TT.HOUR) : T.Evolution.entryAge(form);
    }
    const losses = Math.max(0, (o.battles || 0) - (o.wins || 0));
    s.xp = Math.min(T.Battle.xpFor(C.LEVEL_CAP[s.stage] || 10), 12 * (o.plays || 0) + 30 * (o.wins || 0) + 12 * losses);
    s.poopMistakes = 0; s.st = T.Evolution.blankStageStats();
    s.weight = Math.max(s.weight || 5, C.MIN_WEIGHT[s.stage] || 5);
    s.hungerT = 0; s.happyT = 0; s.hungerZeroMs = 0; s.happyZeroMs = 0; s.sickMs = 0; s.lightMs = 0;
    s.poopT = U.rand(TT.POOP_MIN, TT.POOP_MAX) * 0.5; s.fakeT = U.rand(TT.FAKE_MIN, TT.FAKE_MAX);
    s.poops = (o.poops || []).slice(0, 4).map(p => ({ age: 0, counted: !!p.counted }));
    s.asleep = false; s.lightsOff = false; s.napping = false; s.energy = C.ENERGY.MAX; s.job = null;
    delete s.secretChecked; delete s.lightMs; delete s.lightMistake;
    s.createdAt = Date.now() - s.eggMs - s.ageMs;
    s.simT = s.eggMs + s.ageMs;       // time spent away under the old rules is not replayed
    s.v = C.SAVE_VERSION; s.migratedFrom = o.v || 1; s.migratedStage = V1_STAGE[oldForm] || null;
    return s;
  }

  const Pet = {
    create, randomName, makeSick, migrate, clockHour, addXp,
    /** Advance the simulation by `ms` game-milliseconds. opts.away = catching up on time away (softened needs). */
    simulate(s, ms, ev, opts) {
      ev = ev || [];
      const away = !!(opts && opts.away), k = away ? C.OFFLINE_FACTOR : 1;
      let run = Math.min(ms, C.MAX_CATCHUP_MS);
      const stepMs = away ? C.AWAY_STEP_MS : Math.max(C.SIM_STEP_MS, run / 3000);   // big debug jumps use bigger steps
      while (run > 0 && !s.dead) { const d = Math.min(stepMs, run); step(s, d, ev, k); run -= d; }
      if (ms > C.MAX_CATCHUP_MS && !s.dead && s.stage !== 'egg') s.ageMs += ms - C.MAX_CATCHUP_MS;
      return ev;
    },
    evolve(s, to, ev) { evolve(s, to, ev || []); },
    /** Move the pet's clock so that it currently reads `hour` (debug/tests). */
    setClock(s, hour) {
      let d = hour - clockHour(s); d = ((d % 24) + 24) % 24;
      s.createdAt += Math.round(d * TT.HOUR);
    },
    /** Game ms until the next evolution (null if none). Can be <= 0 when it's due (waiting for the pet to wake). */
    evolvesIn(s) {
      if (s.dead || s.stage === 'egg') return s.stage === 'egg' ? TT.HATCH - s.eggMs : null;
      const at = T.Evolution.nextAgeAt(s);
      return at == null ? null : at - s.ageMs;
    },
    level(s) { return T.Battle.levelFromXp(s.xp); },
    /** What needs the player's attention right now: [{id, text}] (the bell / attention panel). */
    attention(s) {
      const out = [];
      if (s.dead || s.stage === 'egg') return out;
      if (s.job) return out;
      if (s.sick) out.push({ id: 'sick', text: 'Sick - needs medicine' });
      if (s.hunger <= 1) out.push({ id: 'hungry', text: s.hunger ? 'Hungry' : 'Starving!' });
      if (s.poops.length) out.push({ id: 'poop', text: s.poops.length + ' poop' + (s.poops.length > 1 ? 's' : '') + ' to clean' });
      if (s.happy <= 1) out.push({ id: 'sad', text: s.happy ? 'Bored - train or give a treat' : 'Miserable!' });
      if (s.fakeCall) out.push({ id: 'fake', text: 'Acting up for no reason - scold it' });
      if (!s.asleep && s.energy < 20) out.push({ id: 'tired', text: 'Low energy (' + Math.floor(s.energy) + ') - lights off to sleep' });
      return out;
    },
    needsAttention(s) { return this.attention(s).length > 0; },
    minWeight(s) { return C.MIN_WEIGHT[s.stage] || 5; },

    // ---------- care actions (return a result keyword for the UI) ----------
    feedMeal(s) {
      if (s.hunger >= 4) return 'refuse';
      s.hunger++; s.weight += 1; count(s, 'meals'); s.recentSnacks = 0; return 'ok';
    },
    feedSnack(s) {
      s.happy = Math.min(4, s.happy + 1); s.weight += 2; count(s, 'snacks'); s.recentSnacks++;
      if (s.recentSnacks >= 5 && Math.random() < 0.4) { makeSick(s); return 'sick'; }
      return 'ok';
    },
    /** Lights off = the pet goes to sleep (and recharges); lights on = it wakes up. */
    setLights(s, on) {
      s.lightsOff = !on;
      if (on && s.asleep) { s.asleep = false; s.napping = false; return 'wake'; }
      if (!on && !s.asleep && !s.job) { s.asleep = true; s.napping = false; return 'sleep'; }
      return 'ok';
    },
    clean(s) { const n = s.poops.length; s.poops = []; return n ? 'ok' : 'none'; },
    medicine(s) {
      if (!s.sick) return 'refuse';
      s.doses--;
      if (s.doses <= 0) { s.sick = false; s.sickMs = 0; s.sickMistake = false; return 'cured'; }
      return 'dose';
    },
    scold(s) {
      if (s.fakeCall) {
        s.fakeCall = false; s.discipline = Math.min(100, s.discipline + 25);
        s.fakeT = U.rand(TT.FAKE_MIN, TT.FAKE_MAX); return 'ok';
      }
      s.happy = Math.max(0, s.happy - 1); return 'unfair';
    },
    /** Training session finished with `hits` of 5. mult = daily XP taper. Returns {result, xp, level, levelUp...}. */
    playDone(s, hits, mult) {
      s.plays++; count(s, 'training');
      s.weight = Math.max(this.minWeight(s), s.weight - 1);
      const x = addXp(s, T.Battle.trainXp(hits, this.level(s)), mult);
      if (hits >= 3) s.happy = Math.min(4, s.happy + 1);
      return Object.assign({ result: hits >= 3 ? 'win' : 'lose' }, x);
    },
    /** Battle finished. result: 'win' | 'loss' | 'fled'. mult = daily XP taper. Returns {xp, level, levelUp...}. */
    battleDone(s, result, foeLevel, mult) {
      const won = result === 'win';
      count(s, 'battles'); if (won) count(s, 'wins'); else count(s, 'losses');
      if (won) s.happy = Math.min(4, s.happy + 1);
      s.weight = Math.max(this.minWeight(s), s.weight - 1);
      return addXp(s, T.Battle.battleXp(result, this.level(s), foeLevel), mult);
    },

    /** The old browser-only save, if this device has one (offered once for import into an account). */
    readLocalSave() {
      try { const raw = localStorage.getItem(C.SAVE_KEY); const o = raw && JSON.parse(raw); return o && typeof o === 'object' ? o : null; }
      catch (e) { return null; }
    }
  };
  T.Pet = Pet;
})(window.Tama);
