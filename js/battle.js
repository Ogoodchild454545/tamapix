/* TAMA-PIX — battles & friend codes.
 *
 * Battle data ("card") = { name, formId, xp, training, wins, battles, weight }.
 *
 * Levels (1-50) come ONLY from XP, and XP only from training sessions and battles (see XP below). XP per action
 * grows a little with your level (x(1 + (L-1)/10)) so the per-stage level caps (BLOB 10, day-2 25, final 40) are
 * reachable on free energy.
 *
 * Stats (Pokemon-style): HP, ATK, DEF, SPD = form base stats (evolution.js) + a hidden per-pet gene 0-15 for each,
 * growing with level: stat = floor((2*base + gene) * L / 50) + 5; HP = floor((2*base + gene) * L / 50) + L + 10.
 * Genes are rolled once per pet on the server and never sent to the browser.
 * Cards are always built by the SERVER from the pet it stores (friend codes are server-issued ids, see server/).
 *
 * Round: you pick HIGH (A) or LOW (B). The defender guesses a guard direction; a CPU
 * leans towards whatever you did last, so mix it up. Stats: hp = health, atk vs def = damage,
 * spd = better guarding / side-steps, and the faster monster attacks first. Every 3rd attack fires the species'
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

    // ---------- stats ----------
    STAT_KEYS: ['hp', 'atk', 'def', 'spd'],
    DOUBLE_MUL: 1.3,                                // 'double' specials: an unblockable x1.3 hit
    GENE_MAX: 15,
    /** A fresh random set of hidden genes (0-15 per stat). */
    rollGenes() { const g = {}; this.STAT_KEYS.forEach(k => (g[k] = Math.floor(Math.random() * (this.GENE_MAX + 1)))); return g; },
    /** Vague rating of a gene set (shown instead of the genes). */
    potential(g) {
      const n = g ? this.STAT_KEYS.reduce((m, k) => m + (g[k] | 0), 0) : 30;
      return n >= 48 ? 'Outstanding potential' : n >= 36 ? 'Great potential' : n >= 22 ? 'Good potential' : 'Modest potential';
    },
    /** Level-scaled stats of a form: {hp, atk, def, spd}. heavy = overweight (+10% HP/DEF, -10% SPD). */
    stats(formId, level, genes, heavy) {
      const f = T.FORMS[formId] || T.FORMS.blob, b = f.stats || T.FORMS.blob.stats, g = genes || {};
      const L = Math.max(1, Math.min(this.XP.MAX_LEVEL, level | 0)), o = {};
      for (const k of this.STAT_KEYS) {
        const core = Math.floor((2 * b[k] + U.clamp(g[k] | 0, 0, this.GENE_MAX)) * L / 50);
        o[k] = k === 'hp' ? core + L + 10 : core + 5;
      }
      if (heavy) { o.hp = Math.round(o.hp * 1.1); o.def = Math.round(o.def * 1.1); o.spd = Math.max(1, Math.round(o.spd * 0.9)); }
      return o;
    },
    isHeavy(card) { const f = T.FORMS[card.formId] || T.FORMS.blob; return card.weight >= (T.CONFIG.MIN_WEIGHT[f.stage] || 5) + 20; },

    /** Battle card, built by the server from the stored pet (genes included: server-side only, see view()). */
    card(s) {
      return { name: s.name, formId: s.formId, xp: s.xp | 0, training: s.training, wins: s.wins, battles: s.battles, weight: s.weight, genes: s.genes || null };
    },
    /** Public view of a fighter (what an opponent / the server sends). Never includes the hidden genes. */
    view(f) {
      const c = f.card;
      return { card: { name: c.name, formId: c.formId, xp: c.xp, training: c.training, wins: c.wins, battles: c.battles, weight: c.weight },
               hp: f.hp, max: f.max, st: { hp: f.st.hp, atk: f.st.atk, def: f.st.def, spd: f.st.spd, special: f.st.special } };
    },
    /** Battle stats of a card: the level-scaled stats + the form's special move. */
    statsFor(card) {
      const f = T.FORMS[card.formId] || T.FORMS.blob;
      return Object.assign(this.stats(card.formId, this.level(card), card.genes, this.isHeavy(card)), { special: f.special });
    },
    /** Speed edge of the defender over the attacker (-1..1). */
    spdEdge(d, a) { return (d.st.spd - a.st.spd) / Math.max(1, d.st.spd + a.st.spd); },
    /** Normal hit damage: 0.4 x a level reference (the HP of a base-60 monster at the fighters' average level) x
     *  (ATK/DEF)^0.25 (clamped 0.6-1.6), x0.85-1 random. HP, ATK, DEF and level all count, but a stronger monster
     *  wins more often rather than every time (about 3-5 landed hits KO an equal foe). */
    damage(a, d) {
      const L = (this.level(a.card) + this.level(d.card)) / 2, ref = Math.floor(128 * L / 50) + L + 10;
      const r = U.clamp(Math.pow(a.st.atk / Math.max(1, d.st.def), 0.25), 0.6, 1.6);
      return Math.max(1, Math.round(0.4 * ref * r * U.rand(0.85, 1)));
    },
    fighter(card) {
      const st = this.statsFor(card);
      return { card, name: card.name, form: T.FORMS[card.formId], st, hp: st.hp, max: st.hp,
               turns: 0, guardNext: false, dodgeNext: false, absorbNext: false, stunned: false, lastDir: null };
    },
    /** A computer rival of the same stage, around your level (-2 .. +2, within the stage's level cap). */
    cpuCard(stage, myLevel) {
      const st = stage === 'egg' ? 'baby' : stage;
      const pool = T.Evolution.formsByStage(st);
      const lvl = U.clamp((myLevel || 1) + Math.floor(U.rand(-2, 3)), 1, T.CONFIG.LEVEL_CAP[st] || this.XP.MAX_LEVEL);
      const battles = Math.floor(U.rand(0, lvl));
      return { name: T.Pet.randomName(), formId: U.pick(pool), xp: this.xpFor(lvl) + Math.floor(U.rand(0, 10)), training: Math.floor(U.rand(0, lvl * 2)),
               battles, wins: Math.floor(battles * U.rand(0.2, 0.8)), weight: T.CONFIG.MIN_WEIGHT[st] + Math.floor(U.rand(0, 12)), genes: this.rollGenes() };
    },

    /** Resolve one attack. dir = 'hi' | 'lo'. guessDir = defender's guard guess (optional). */
    attack(a, d, dir, guessDir) {
      a.turns++;
      const res = { dir, special: null, hit: false, dmg: 0, heal: 0, crit: false, blocked: false, dodged: false, absorbed: false, stunned: false };
      if (a.stunned) { a.stunned = false; res.stunned = true; return res; }
      const sp = a.st.special && a.turns % 3 === 0 ? a.st.special : null;
      let dmgMul = 1, unblockable = false, flat = 0, drain = false;
      if (sp) {
        res.special = sp.name;
        switch (sp.type) {
          case 'double': dmgMul = this.DOUBLE_MUL; unblockable = true; break;
          case 'inferno': flat = Math.round(this.damage(a, d) * 2); unblockable = true; break;
          case 'drain': flat = this.damage(a, d); unblockable = true; drain = true; break;
          case 'heal': res.heal = Math.max(1, Math.round(a.max * 0.3)); break;
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
          const p = U.clamp(0.4 + this.spdEdge(d, a) * 0.6, 0.15, 0.7);
          res.blocked = Math.random() < p;
        } else {
          res.blocked = guessDir === dir;
          // a faster defender can still side-step a hit it misread
          if (!res.blocked && Math.random() < U.clamp(this.spdEdge(d, a) * 0.5, 0, 0.25)) { res.dodged = true; return res; }
        }
        if (res.blocked) return res;
      }
      let dmg = flat;
      if (!flat) {
        const edge = (a.st.atk - d.st.def) / Math.max(1, a.st.atk + d.st.def);
        res.crit = Math.random() < U.clamp(0.12 + edge * 0.4, 0.05, 0.35);
        dmg = Math.round(this.damage(a, d) * dmgMul * (res.crit ? 1.5 : 1));
      }
      if (d.absorbNext && !flat) { d.absorbNext = false; d.hp = Math.min(d.max, d.hp + Math.max(1, Math.round(d.max * 0.15))); res.absorbed = true; return res; }
      d.hp = Math.max(0, d.hp - dmg); res.hit = true; res.dmg = dmg;
      if (drain) { res.heal = Math.max(1, Math.round(dmg / 2)); a.hp = Math.min(a.max, a.hp + res.heal); }
      return res;
    },
    /** CPU guard guess against the player's attack: leans towards repeating player's last direction. */
    cpuGuess(opp, me) {
      const lean = U.clamp(0.55 + this.spdEdge(opp, me) * 0.4, 0.4, 0.75);
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
