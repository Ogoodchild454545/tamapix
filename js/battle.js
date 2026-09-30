/* TAMA-PIX — battles & friend codes.
 *
 * Battle data ("card") = { name, formId, xp, training, wins, battles, weight }.
 *
 * Levels (1-50) come ONLY from XP, and XP only from training sessions and battles (see XP below). The level adds
 * a little to every battle stat, so a trained monster beats an untrained one of the same species.
 * The card is what gets encoded into a friend code, so an opponent built from a code
 * shows the right species sprite, name and stats.
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
    trainXp(hits) { return this.XP.TRAIN_BASE + this.XP.TRAIN_PER_HIT * Math.max(0, Math.min(5, hits | 0)); },
    /** XP for a finished battle. result: 'win' | 'loss' | 'fled'. */
    battleXp(result, myLevel, foeLevel) {
      const X = this.XP, d = (foeLevel || myLevel) - myLevel;
      if (result === 'win') return U.clamp(X.WIN + d * X.WIN_PER_LEVEL, X.WIN_MIN, X.WIN_MAX);
      if (result === 'loss') return U.clamp(X.LOSS + d * X.LOSS_PER_LEVEL, X.LOSS_MIN, X.LOSS_MAX);
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
    /** A computer rival of the same stage, around your level (-2 .. +3). */
    cpuCard(stage, myLevel) {
      const st = stage === 'egg' ? 'baby' : stage;
      const pool = T.Evolution.formsByStage(st);
      const lvl = U.clamp((myLevel || 1) + Math.floor(U.rand(-2, 4)), 1, this.XP.MAX_LEVEL);
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
    encode(card) {
      const safe = String(card.name).replace(/[^A-Z0-9]/gi, '').slice(0, 8).toUpperCase() || 'PAL';
      const body = ['TP2', safe, card.formId, card.training | 0, card.wins | 0, card.battles | 0, card.weight | 0, card.xp | 0].join('|');
      let h = 7; for (const ch of body) h = (h * 31 + ch.charCodeAt(0)) % 1296;
      return 'TP-' + btoa(body + '|' + h.toString(36)).replace(/=+$/, '');
    },
    decode(code) {
      try {
        code = String(code).trim().replace(/^TP-/i, '');
        const raw = atob(code + '==='.slice((code.length + 3) % 4));
        const parts = raw.split('|');
        const n = parts[0] === 'TP2' ? 9 : parts[0] === 'TP1' ? 8 : 0;      // TP1 = old codes without XP
        if (!n || parts.length !== n) return null;
        const body = parts.slice(0, n - 1).join('|');
        let h = 7; for (const ch of body) h = (h * 31 + ch.charCodeAt(0)) % 1296;
        if (h.toString(36) !== parts[n - 1]) return null;
        const formId = T.LEGACY_FORMS[parts[2]] || parts[2];
        if (!Object.prototype.hasOwnProperty.call(T.FORMS, formId) || formId === 'egg') return null;
        const xp = n === 9 ? +parts[7] : Math.min(20000, 12 * (+parts[3]) + 30 * (+parts[4]));
        return { name: parts[1], formId, xp, training: +parts[3], wins: +parts[4], battles: +parts[5], weight: +parts[6] };
      } catch (e) { return null; }
    }
  };
  T.Battle = Battle;
})(window.Tama);
