/* TAMA-PIX — pet model: state, time simulation, care actions, persistence.
 * Pure-ish logic, no drawing. Events are pushed to an array so the UI can react.
 */
(function (T) {
  'use strict';
  const C = T.CONFIG, TT = C.T, U = T.util;
  const SYL = ['PI', 'PO', 'MU', 'TA', 'KO', 'RI', 'NU', 'MI', 'BO', 'LU', 'KA', 'ZU', 'NE', 'CHI'];

  function randomName() { return U.pick(SYL) + U.pick(SYL); }

  function create() {
    return {
      v: 1, name: randomName(), formId: 'egg', stage: 'egg', history: ['egg'],
      eggMs: 0, ageMs: 0,
      hunger: 2, happy: 2, weight: 5, discipline: 0,
      poops: [],                     // [{age, counted}]
      sick: false, sickMs: 0, doses: 0, sickMistake: false,
      asleep: false, lightsOff: false, lightMs: 0, lightMistake: false,
      dead: false, cause: '',
      hungerT: 0, happyT: 0, poopT: U.rand(TT.POOP_MIN, TT.POOP_MAX) * 0.6,
      hungerZeroMs: 0, happyZeroMs: 0, hungerMistake: false, happyMistake: false,
      fakeCall: false, fakeCallMs: 0, fakeT: U.rand(TT.FAKE_MIN, TT.FAKE_MAX),
      careMistakes: 0, meals: 0, snacks: 0, recentSnacks: 0,
      battles: 0, wins: 0, training: 0, plays: 0,
      secretChecked: false,
      lastSaved: Date.now()
    };
  }

  function mistake(s, ev, why) { s.careMistakes++; ev.push({ type: 'mistake', why }); }

  function die(s, ev, cause) {
    if (s.dead) return;
    s.dead = true; s.cause = cause; s.asleep = false; s.lightsOff = false;
    ev.push({ type: 'death', cause });
  }

  function evolve(s, to, ev) {
    const from = s.formId;
    s.formId = to; s.stage = T.FORMS[to].stage; s.history.push(to);
    s.weight = Math.max(s.weight, C.MIN_WEIGHT[s.stage] || 5);
    ev.push({ type: 'evolve', from, to });
  }

  function step(s, dt, ev) {
    if (s.dead) return;
    if (s.stage === 'egg') {
      s.eggMs += dt;
      if (s.eggMs >= TT.HATCH) { evolve(s, 'pixbit', ev); ev[ev.length - 1].type = 'hatch'; s.hunger = 1; s.happy = 1; }
      return;
    }
    s.ageMs += dt;

    // --- day / night
    const night = (s.ageMs % TT.DAY) >= TT.DAY * TT.NIGHT_FRAC;
    if (night && !s.asleep) { s.asleep = true; s.lightMs = 0; s.lightMistake = false; ev.push({ type: 'sleep' }); }
    if (!night && s.asleep) { s.asleep = false; s.lightsOff = false; ev.push({ type: 'wake' }); }
    if (s.asleep) {
      if (!s.lightsOff) {
        s.lightMs += dt;
        if (s.lightMs >= TT.LIGHT_TIMEOUT && !s.lightMistake) { s.lightMistake = true; mistake(s, ev, 'light'); }
      }
      return; // nothing else happens while sleeping
    }

    // --- evolution (only while awake)
    if (T.Evolution.due(s)) {
      const to = T.Evolution.pick(s);
      if (s.stage === 'adult') s.secretChecked = true;
      if (to) evolve(s, to, ev);
    }

    // --- hearts decay
    const hr = TT.HUNGER[s.stage] || 60e3, pr = TT.HAPPY[s.stage] || 60e3;
    s.hungerT += dt * (s.sick ? 1.5 : 1);
    if (s.hungerT >= hr) { s.hungerT -= hr; if (s.hunger > 0) { s.hunger--; if (!s.hunger) ev.push({ type: 'call', why: 'hunger' }); } }
    s.happyT += dt * (s.sick ? 1.5 : 1);
    if (s.happyT >= pr) { s.happyT -= pr; if (s.happy > 0) { s.happy--; if (!s.happy) ev.push({ type: 'call', why: 'happy' }); } }

    if (s.hunger === 0) {
      s.hungerZeroMs += dt;
      if (s.hungerZeroMs >= TT.CALL_TIMEOUT && !s.hungerMistake) { s.hungerMistake = true; mistake(s, ev, 'hunger'); }
      if (s.hungerZeroMs >= TT.STARVE_DEATH) return die(s, ev, 'hunger');
    } else { s.hungerZeroMs = 0; s.hungerMistake = false; }
    if (s.happy === 0) {
      s.happyZeroMs += dt;
      if (s.happyZeroMs >= TT.CALL_TIMEOUT && !s.happyMistake) { s.happyMistake = true; mistake(s, ev, 'happy'); }
    } else { s.happyZeroMs = 0; s.happyMistake = false; }

    // --- poop
    s.poopT -= dt;
    if (s.poopT <= 0) {
      s.poopT = U.rand(TT.POOP_MIN, TT.POOP_MAX) * (s.stage === 'baby' ? 0.7 : 1);
      if (s.poops.length < 4) { s.poops.push({ age: 0, counted: false }); ev.push({ type: 'poop' }); }
    }
    for (const p of s.poops) {
      p.age += dt;
      if (p.age >= TT.POOP_TIMEOUT && !p.counted) { p.counted = true; mistake(s, ev, 'poop'); }
    }

    // --- sickness
    if (!s.sick) {
      const p = (0.002 * s.poops.length + (s.hunger === 0 ? 0.002 : 0) + (s.happy === 0 ? 0.0015 : 0)) * dt / 1000;
      if (s.poops.length >= 4 || Math.random() < p) makeSick(s, ev);
    } else {
      s.sickMs += dt;
      if (s.sickMs >= TT.SICK_TIMEOUT && !s.sickMistake) { s.sickMistake = true; mistake(s, ev, 'sick'); }
      if (s.sickMs >= TT.SICK_DEATH) return die(s, ev, 'sick');
    }

    // --- discipline "fake" calls (pet acts up although it needs nothing)
    if (s.fakeCall) {
      s.fakeCallMs += dt;
      if (s.fakeCallMs >= TT.FAKE_TIMEOUT) { s.fakeCall = false; s.fakeT = U.rand(TT.FAKE_MIN, TT.FAKE_MAX); }
    } else if (s.stage !== 'baby' && !s.sick && s.hunger > 0 && s.happy > 0 && s.discipline < 100) {
      s.fakeT -= dt;
      if (s.fakeT <= 0) { s.fakeCall = true; s.fakeCallMs = 0; ev.push({ type: 'call', why: 'fake' }); }
    }
  }

  function makeSick(s, ev) {
    if (s.sick) return;
    s.sick = true; s.sickMs = 0; s.sickMistake = false; s.doses = Math.random() < 0.5 ? 1 : 2;
    ev && ev.push({ type: 'sick' });
  }

  const Pet = {
    create, randomName, makeSick,
    /** Advance the simulation by `ms` game-milliseconds. Returns the list of events. */
    simulate(s, ms, ev) {
      ev = ev || [];
      while (ms > 0 && !s.dead) { const d = Math.min(C.SIM_STEP_MS, ms); step(s, d, ev); ms -= d; }
      return ev;
    },
    evolve(s, to, ev) { evolve(s, to, ev || []); },
    needsAttention(s) {
      if (s.dead || s.stage === 'egg') return false;
      if (s.asleep) return !s.lightsOff;
      return s.hunger === 0 || s.happy === 0 || s.sick || s.fakeCall || s.poops.length >= 3;
    },
    minWeight(s) { return C.MIN_WEIGHT[s.stage] || 5; },

    // ---------- care actions (return a result keyword for the UI) ----------
    feedMeal(s) {
      if (s.hunger >= 4) return 'refuse';
      s.hunger++; s.weight += 1; s.meals++; s.recentSnacks = 0; return 'ok';
    },
    feedSnack(s) {
      s.happy = Math.min(4, s.happy + 1); s.weight += 2; s.snacks++; s.recentSnacks++;
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
    playDone(s, score) {
      s.plays++; s.training++;
      s.weight = Math.max(this.minWeight(s), s.weight - 1);
      if (score >= 3) { s.happy = Math.min(4, s.happy + 1); return 'win'; }
      return 'lose';
    },
    battleDone(s, won) {
      s.battles++; s.training++; if (won) { s.wins++; s.happy = Math.min(4, s.happy + 1); }
      s.weight = Math.max(this.minWeight(s), s.weight - 1);
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
        const s = Object.assign(create(), JSON.parse(raw));
        if (!T.FORMS[s.formId]) return null;
        return s;
      } catch (e) { return null; }
    },
    /** Game-ms that should be simulated for a real absence of `realMs`. */
    offlineGameMs(realMs) {
      realMs = Math.max(0, Math.min(realMs, C.MAX_OFFLINE_REAL_MS));
      return realMs * C.SPEED * C.OFFLINE_FACTOR;
    },
    wipe() { try { localStorage.removeItem(C.SAVE_KEY); } catch (e) {} }
  };
  T.Pet = Pet;
})(window.Tama);
