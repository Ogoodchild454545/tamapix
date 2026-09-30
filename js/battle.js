/* TAMA-PIX — battles & friend codes.
 *
 * Battle data ("card") = { name, formId, training, wins, battles, weight }.
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
    card(s) {
      return { name: s.name, formId: s.formId, training: s.training, wins: s.wins, battles: s.battles, weight: s.weight };
    },
    /** Display level (1-99) from stage, training and wins. */
    level(card) {
      const f = T.FORMS[card.formId] || {};
      const base = { baby: 3, child: 9, teen: 17, adult: 28, secret: 42 }[f.stage] || 5;
      return Math.min(99, base + Math.floor((card.training || 0) / 2) + Math.min(20, card.wins || 0));
    },
    /** Public view of a fighter (what an opponent / the server sends). */
    view(f) { return { card: f.card, hp: f.hp, max: f.max, st: { hp: f.st.hp, pow: f.st.pow, def: f.st.def, spd: f.st.spd, special: f.st.special } }; },
    statsFor(card) {
      const f = T.FORMS[card.formId] || T.FORMS.pixbit;
      const b = f.stats || { hp: 2, pow: 1, def: 1, spd: 1 };
      const heavy = card.weight >= 45 ? 1 : 0;
      return {
        hp: b.hp + heavy,
        pow: b.pow + Math.min(2, Math.floor((card.training || 0) / 8)),
        def: b.def + heavy,
        spd: Math.max(1, b.spd + Math.min(1, Math.floor((card.wins || 0) / 5)) - heavy),
        special: f.special
      };
    },
    fighter(card) {
      const st = this.statsFor(card);
      return { card, name: card.name, form: T.FORMS[card.formId], st, hp: st.hp, max: st.hp,
               turns: 0, guardNext: false, dodgeNext: false, absorbNext: false, stunned: false, lastDir: null };
    },
    cpuCard(stage) {
      const st = stage === 'secret' ? 'adult' : stage === 'baby' ? 'child' : stage;
      const pool = T.Evolution.formsByStage(st);
      const lvl = { child: 4, teen: 10, adult: 18 }[st] || 6;
      const battles = Math.floor(U.rand(0, lvl));
      return { name: T.Pet.randomName(), formId: U.pick(pool), training: Math.floor(U.rand(0, lvl)),
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
      const body = ['TP1', safe, card.formId, card.training | 0, card.wins | 0, card.battles | 0, card.weight | 0].join('|');
      let h = 7; for (const ch of body) h = (h * 31 + ch.charCodeAt(0)) % 1296;
      return 'TP-' + btoa(body + '|' + h.toString(36)).replace(/=+$/, '');
    },
    decode(code) {
      try {
        code = String(code).trim().replace(/^TP-/i, '');
        const raw = atob(code + '==='.slice((code.length + 3) % 4));
        const parts = raw.split('|');
        if (parts.length !== 8 || parts[0] !== 'TP1') return null;
        const body = parts.slice(0, 7).join('|');
        let h = 7; for (const ch of body) h = (h * 31 + ch.charCodeAt(0)) % 1296;
        if (h.toString(36) !== parts[7]) return null;
        if (!T.FORMS[parts[2]] || parts[2] === 'egg') return null;
        return { name: parts[1], formId: parts[2], training: +parts[3], wins: +parts[4], battles: +parts[5], weight: +parts[6] };
      } catch (e) { return null; }
    }
  };
  T.Battle = Battle;
})(window.Tama);
