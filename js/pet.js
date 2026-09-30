/* TAMA-PIX — pet model: state, real-time simulation, care actions, XP, persistence + save migration.
 * Pure-ish logic, no drawing. Events are pushed to an array so the UI can react.
 *
 * Time: s.ageMs is game time since hatching (= real time; ?debug=1&speed=N speeds it up). The pet's clock
 * (for sleeping) is s.createdAt + eggMs + ageMs, i.e. your local time. Time away is simulated when the game is
 * opened again: the age counts fully, needs decay at CONFIG.OFFLINE_FACTOR.
 */
(function (T) {
  'use strict';
  const C = T.CONFIG, TT = C.T, U = T.util;
  const SYL = ['PI', 'PO', 'MU', 'TA', 'KO', 'RI', 'NU', 'MI', 'BO', 'LU', 'KA', 'ZU', 'NE', 'CHI'];

  function randomName() { return U.pick(SYL) + U.pick(SYL); }

  function create() {
    return {
      v: C.SAVE_VERSION, name: randomName(), formId: 'egg', stage: 'egg', history: ['egg'],
      createdAt: Date.now(), eggMs: 0, ageMs: 0,
      hunger: 2, happy: 2, weight: 5, discipline: 0,
      poops: [],                     // [{age, counted}]
      sick: false, sickMs: 0, doses: 0, sickMistake: false,
      asleep: false, lightsOff: false, lightMs: 0, lightMistake: false,
      dead: false, cause: '',
      hungerT: 0, happyT: 0, poopT: U.rand(TT.POOP_MIN, TT.POOP_MAX) * 0.5,
      hungerZeroMs: 0, happyZeroMs: 0, hungerMistake: false, happyMistake: false,
      fakeCall: false, fakeCallMs: 0, fakeT: U.rand(TT.FAKE_MIN, TT.FAKE_MAX),
      // lifetime counters
      careMistakes: 0, poopMistakes: 0, meals: 0, snacks: 0, recentSnacks: 0,
      battles: 0, wins: 0, training: 0, plays: 0, xp: 0,
      st: T.Evolution.blankStageStats(),   // counters of the current stage (reset at each evolution)
      lastSaved: Date.now()
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
    s.st = T.Evolution.blankStageStats();
    ev.push({ type: 'evolve', from, to });
  }

  /** Local hour (0-24, fractional) on the pet's clock. */
  function clockHour(s) {
    const d = new Date(s.createdAt + s.eggMs + s.ageMs);
    return d.getHours() + d.getMinutes() / 60;
  }
  function isNight(s) {
    if (s.ageMs < TT.NEWBORN_AWAKE) return false;
    const h = clockHour(s);
    return TT.SLEEP_AT > TT.WAKE_AT ? (h >= TT.SLEEP_AT || h < TT.WAKE_AT) : (h >= TT.SLEEP_AT && h < TT.WAKE_AT);
  }

  /** One simulation step: dt = game ms of age; k = need-decay factor (1 while playing, OFFLINE_FACTOR away). */
  function step(s, dt, ev, k) {
    if (s.dead) return;
    if (s.stage === 'egg') {
      s.eggMs += dt;
      if (s.eggMs >= TT.HATCH) {
        s.eggMs = TT.HATCH; evolve(s, 'blob', ev); ev[ev.length - 1].type = 'hatch'; s.hunger = 2; s.happy = 2;
      }
      return;
    }
    s.ageMs += dt;
    const nd = dt * k;              // "need time" (softened while away)

    // --- day / night (pet clock = local time)
    const night = isNight(s);
    if (night && !s.asleep) { s.asleep = true; s.lightMs = 0; s.lightMistake = false; ev.push({ type: 'sleep' }); }
    if (!night && s.asleep) { s.asleep = false; s.lightsOff = false; ev.push({ type: 'wake' }); }
    if (s.asleep) {
      if (!s.lightsOff) {
        s.lightMs += nd;
        if (s.lightMs >= TT.LIGHT_TIMEOUT && !s.lightMistake) { s.lightMistake = true; mistake(s, ev, 'light'); }
      }
      return; // nothing else happens while sleeping (no hunger, no evolution)
    }

    // --- evolution (real age; only while awake)
    if (T.Evolution.due(s)) {
      const to = T.Evolution.pick(s);
      if (to) evolve(s, to, ev);
    }

    // --- hearts decay
    const hr = TT.HUNGER[s.stage] || 60 * TT.MIN, pr = TT.HAPPY[s.stage] || 60 * TT.MIN;
    s.hungerT += nd * (s.sick ? 1.5 : 1);
    if (s.hungerT >= hr) {
      s.hungerT -= hr;
      if (s.hunger > 0) { s.hunger--; s.weight = Math.max(C.MIN_WEIGHT[s.stage] || 5, s.weight - 1); if (!s.hunger) ev.push({ type: 'call', why: 'hunger' }); }
    }
    s.happyT += nd * (s.sick ? 1.5 : 1);
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

  function addXp(s, n) {
    const before = T.Battle.levelFromXp(s.xp);
    s.xp = (s.xp | 0) + Math.max(0, Math.round(n));
    const after = T.Battle.levelFromXp(s.xp);
    return { xp: Math.round(n), level: after, levelUp: after > before };
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
    s.xp = Math.min(T.Battle.xpFor(30), 12 * (o.plays || 0) + 30 * (o.wins || 0) + 12 * losses);
    s.poopMistakes = 0; s.st = T.Evolution.blankStageStats();
    s.weight = Math.max(s.weight || 5, C.MIN_WEIGHT[s.stage] || 5);
    s.hungerT = 0; s.happyT = 0; s.hungerZeroMs = 0; s.happyZeroMs = 0; s.sickMs = 0; s.lightMs = 0;
    s.poopT = U.rand(TT.POOP_MIN, TT.POOP_MAX) * 0.5; s.fakeT = U.rand(TT.FAKE_MIN, TT.FAKE_MAX);
    s.poops = (o.poops || []).slice(0, 4).map(p => ({ age: 0, counted: !!p.counted }));
    s.asleep = false; s.lightsOff = false;
    delete s.secretChecked;
    s.createdAt = Date.now() - s.eggMs - s.ageMs;
    s.lastSaved = Date.now();         // don't replay time spent away under the old rules
    s.v = C.SAVE_VERSION; s.migratedFrom = o.v || 1; s.migratedStage = V1_STAGE[oldForm] || null;
    return s;
  }

  const Pet = {
    create, randomName, makeSick, migrate, isNight, clockHour,
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
      const d = new Date(); d.setHours(Math.floor(hour), Math.round((hour % 1) * 60), 0, 0);
      s.createdAt = d.getTime() - s.eggMs - s.ageMs;
    },
    /** Game ms until the next evolution (null if none). Can be <= 0 when it's due (waiting for the pet to wake). */
    evolvesIn(s) {
      if (s.dead || s.stage === 'egg') return s.stage === 'egg' ? TT.HATCH - s.eggMs : null;
      const at = T.Evolution.nextAgeAt(s);
      return at == null ? null : at - s.ageMs;
    },
    level(s) { return T.Battle.levelFromXp(s.xp); },
    needsAttention(s) {
      if (s.dead || s.stage === 'egg') return false;
      if (s.asleep) return !s.lightsOff;
      return s.hunger === 0 || s.happy === 0 || s.sick || s.fakeCall || s.poops.length >= 3;
    },
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
    setLights(s, on) { s.lightsOff = !on; },
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
    /** Training session finished with `hits` of 5. Returns {result, xp, level, levelUp}. */
    playDone(s, hits) {
      s.plays++; count(s, 'training');
      s.weight = Math.max(this.minWeight(s), s.weight - 1);
      const x = addXp(s, T.Battle.trainXp(hits));
      if (hits >= 3) s.happy = Math.min(4, s.happy + 1);
      return Object.assign({ result: hits >= 3 ? 'win' : 'lose' }, x);
    },
    /** Battle finished. result: 'win' | 'loss' | 'fled'. Returns {xp, level, levelUp}. */
    battleDone(s, result, foeLevel) {
      const won = result === 'win';
      count(s, 'battles'); if (won) count(s, 'wins'); else count(s, 'losses');
      if (won) s.happy = Math.min(4, s.happy + 1);
      s.weight = Math.max(this.minWeight(s), s.weight - 1);
      return addXp(s, T.Battle.battleXp(result, this.level(s), foeLevel));
    },

    // ---------- persistence ----------
    save(s) {
      s.lastSaved = Date.now();
      try { localStorage.setItem(C.SAVE_KEY, JSON.stringify(s)); } catch (e) {}
    },
    load() {
      try {
        const raw = localStorage.getItem(C.SAVE_KEY);
        if (!raw) return null;
        const o = JSON.parse(raw);
        if (!o || typeof o !== 'object') return null;
        const s = (o.v || 1) < C.SAVE_VERSION ? migrate(o) : Object.assign(create(), o);
        if (T.LEGACY_FORMS[s.formId]) { s.formId = T.LEGACY_FORMS[s.formId]; s.stage = T.FORMS[s.formId].stage; }
        if (!Object.prototype.hasOwnProperty.call(T.FORMS, s.formId)) return null;
        s.st = Object.assign(T.Evolution.blankStageStats(), s.st || {});
        return s;
      } catch (e) { return null; }
    },
    wipe() { try { localStorage.removeItem(C.SAVE_KEY); } catch (e) {} }
  };
  T.Pet = Pet;
})(window.Tama);
