/* TAMA-PIX — battles & friend codes.
 *
 * Battle data ("card") = { name, formId, xp, training, wins, battles, weight }.
 *
 * Levels (1-50) come ONLY from XP, and XP only from training sessions and battles (see XP below). XP per action
 * grows a little with your level (x(1 + (L-1)/10)) so the per-stage level caps (BLOB 10, day-2 25, final 40) are
 * reachable on free energy. The level adds a little to every battle stat.
 * Cards are always built by the SERVER from the pet it stores (friend codes are server-issued ids, see server/).
 *
 * Round: you pick HIGH (A) or LOW (B). The defender guesses a guard direction; a CPU
 * leans towards whatever you did last, so mix it up. Stats: hp = health, pow = damage,
 * def = resist extra damage, spd = better guarding. Every 3rd attack fires the species'
 * special move (see evolution.js).
 */
(function (T) {
  'use strict';
  const U = T.util;

  const Battle = {
    // ---------- XP & levels ----------
    XP: {
      MAX_LEVEL: 50,
      TRAIN_BASE: 10, TRAIN_PER_HIT: 4,             // a 5-round training session: 10 + 4 per hit (10-30 XP)
      WIN: 40, LOSS: 15,                            // battles; fleeing gives nothing
      WIN_PER_LEVEL: 6, LOSS_PER_LEVEL: 3,          // bonus per level the foe is above you (penalty if below)
      WIN_MIN: 15, WIN_MAX: 80, LOSS_MIN: 5, LOSS_MAX: 35
    },
    /** Total XP needed to reach level L: 30, 70, 120, ... 630 (Lv10), 2280 (Lv20), 13230 (Lv50). */
    xpFor(L) { L = Math.max(1, Math.min(this.XP.MAX_LEVEL, L | 0)); return 5 * (L - 1) * (L + 4); },
    levelFromXp(xp) {
      xp = Math.max(0, xp || 0);
      let L = 1; while (L < this.XP.MAX_LEVEL && xp >= this.xpFor(L + 1)) L++;
      return L;
    },
    level(card) { return this.levelFromXp(card && card.xp); },
    /** XP multiplier for your level: Lv1 x1.0, Lv11 x2.0, Lv31 x4.0. */
    levelScale(L) { return 1 + (Math.max(1, L || 1) - 1) / 10; },
    trainXp(hits, level) { return Math.round((this.XP.TRAIN_BASE + this.XP.TRAIN_PER_HIT * Math.max(0, Math.min(5, hits | 0))) * this.levelScale(level)); },
    /** XP for a finished battle. result: 'win' | 'loss' | 'fled'. */
    battleXp(result, myLevel, foeLevel) {
      const X = this.XP, d = (foeLevel || myLevel) - myLevel, k = this.levelScale(myLevel);
      if (result === 'win') return Math.round(U.clamp(X.WIN + d * X.WIN_PER_LEVEL, X.WIN_MIN, X.WIN_MAX) * k);
      if (result === 'loss') return Math.round(U.clamp(X.LOSS + d * X.LOSS_PER_LEVEL, X.LOSS_MIN, X.LOSS_MAX) * k);
      return 0;
    },

    card(s) {
      return { name: s.name, formId: s.formId, xp: s.xp | 0, training: s.training, wins: s.wins, battles: s.battles, weight: s.weight };
    },
    /** Public view of a fighter (what an opponent / the server sends). */
    view(f) { return { card: f.card, hp: f.hp, max: f.max, st: { hp: f.st.hp, pow: f.st.pow, def: f.st.def, spd: f.st.spd, special: f.st.special } }; },
    /** Battle stats: species base + level bonus (+1 HP per 15 levels, +1 POW per 12, +1 DEF per 18, +1 SPD per 25). */
    statsFor(card) {
      const f = T.FORMS[card.formId] || T.FORMS.blob;
      const b = f.stats || { hp: 2, pow: 1, def: 1, spd: 1 };
      const L = this.level(card);
      const heavy = card.weight >= (T.CONFIG.MIN_WEIGHT[f.stage] || 5) + 20 ? 1 : 0;
      return {
        hp: b.hp + heavy + Math.floor(L / 15),
        pow: b.pow + Math.floor(L / 12),
        def: b.def + heavy + Math.floor(L / 18),
        spd: Math.max(1, b.spd - heavy + Math.floor(L / 25)),
        special: f.special
      };
    },
    fighter(card) {
      const st = this.statsFor(card);
      return { card, name: card.name, form: T.FORMS[card.formId], st, hp: st.hp, max: st.hp,
               turns: 0, guardNext: false, dodgeNext: false, absorbNext: false, stunned: false, lastDir: null };
    },
    /** A computer rival of the same stage, around your level (-2 .. +3, within the stage's level cap). */
    cpuCard(stage, myLevel) {
      const st = stage === 'egg' ? 'baby' : stage;
      const pool = T.Evolution.formsByStage(st);
      const lvl = U.clamp((myLevel || 1) + Math.floor(U.rand(-2, 4)), 1, T.CONFIG.LEVEL_CAP[st] || this.XP.MAX_LEVEL);
      const battles = Math.floor(U.rand(0, lvl));
      return { name: T.Pet.randomName(), formId: U.pick(pool), xp: this.xpFor(lvl) + Math.floor(U.rand(0, 10)), training: Math.floor(U.rand(0, lvl * 2)),
               battles, wins: Math.floor(battles * U.rand(0.2, 0.8)), weight: T.CONFIG.MIN_WEIGHT[st] + Math.floor(U.rand(0, 12)) };
    },

    /** Resolve one attack. dir = 'hi' | 'lo'. guessDir = defender's guard guess (optional). */
    attack(a, d, dir, guessDir) {
      a.turns++;
      const res = { dir, special: null, hit: false, dmg: 0, heal: 0, blocked: false, dodged: false, absorbed: false, stunned: false };
      if (a.stunned) { a.stunned = false; res.stunned = true; return res; }
      const sp = a.st.special && a.turns % 3 === 0 ? a.st.special : null;
      let dmgMul = 1, unblockable = false, flat = 0;
      if (sp) {
        res.special = sp.name;
        switch (sp.type) {
          case 'double': dmgMul = 2; unblockable = true; break;
          case 'inferno': flat = 3; unblockable = true; break;
          case 'drain': flat = 1; unblockable = true; res.heal = 1; break;
          case 'heal': res.heal = 2; break;
          case 'fullheal': res.heal = a.max; break;
          case 'guard': a.guardNext = true; break;
          case 'dodge': a.dodgeNext = true; break;
          case 'absorb': a.absorbNext = true; break;
          case 'stun': d.stunned = true; break;
        }
        if (res.heal) a.hp = Math.min(a.max, a.hp + res.heal);
      }
      a.lastDir = dir;
      if (d.dodgeNext) { d.dodgeNext = false; res.dodged = true; return res; }
      if (d.guardNext && !unblockable) { d.guardNext = false; res.blocked = true; return res; }
      if (!unblockable) {
        if (guessDir == null) {
          const p = U.clamp(0.4 + (d.st.spd - a.st.spd) * 0.07, 0.15, 0.7);
          res.blocked = Math.random() < p;
        } else {
          res.blocked = guessDir === dir;
          // a faster defender can still side-step a hit it misread
          if (!res.blocked && Math.random() < U.clamp((d.st.spd - a.st.spd) * 0.05, 0, 0.25)) { res.dodged = true; return res; }
        }
        if (res.blocked) return res;
      }
      let dmg = flat || (1 + (Math.random() < U.clamp(0.15 + (a.st.pow - d.st.def) * 0.15, 0.05, 0.6) ? 1 : 0)) * dmgMul;
      if (d.absorbNext && !flat) { d.absorbNext = false; d.hp = Math.min(d.max, d.hp + 1); res.absorbed = true; return res; }
      d.hp = Math.max(0, d.hp - dmg); res.hit = true; res.dmg = dmg;
      return res;
    },
    /** CPU guard guess against the player's attack: leans towards repeating player's last direction. */
    cpuGuess(opp, me) {
      const lean = U.clamp(0.55 + (opp.st.spd - me.st.spd) * 0.05, 0.4, 0.75);
      if (!me.lastDir) return U.pick(['hi', 'lo']);
      return Math.random() < lean ? me.lastDir : (me.lastDir === 'hi' ? 'lo' : 'hi');
    },

    // ---------- friend codes ----------
    // Codes are issued by the server ("PX-7K3Q9A") and point at the friend's account: the server fights with the pet
    // it stores, so a code can't carry edited stats. Old self-contained codes ("TP-...") are recognised to explain that.
    CODE_RE: /^PX-[A-HJ-NP-Z2-9]{6}$/,
    normCode(code) { return String(code || '').trim().toUpperCase().replace(/^PX(?!-)/, 'PX-'); },
    isLegacyCode(code) { return /^TP-[A-Za-z0-9+/]{16,}$/.test(String(code || '').trim()); }
  };
  T.Battle = Battle;
})(window.Tama);
