/* TAMA-PIX — species table + evolution rules (data-driven; tweak freely).
 *
 *  egg -> baby -> child -> teen -> adult -> (rare "secret" form)
 *
 * FORMS: every species. stats = battle stats {hp, pow, def, spd}; special = battle move
 *        that fires on every 3rd attack. traits feed the personality module.
 * RULES: evaluated top-to-bottom when the pet reaches the age threshold of its stage;
 *        the first rule whose `from` matches (form id or stage name) and whose `when`
 *        returns true wins. A rule without `when` is a fallback.
 *
 * Variables available to `when(v)`: see Tama.Evolution.vars().
 */
(function (T) {
  'use strict';
  const S = (hp, pow, def, spd) => ({ hp, pow, def, spd });
  const C = T.CONFIG.T;

  // special.type: double | heal | guard | dodge | absorb | drain | stun | inferno | fullheal
  T.FORMS = {
    egg:      { name: 'EGG',      stage: 'egg' },
    pixbit:   { name: 'PIXBIT',   stage: 'baby',  stats: S(2, 1, 1, 1), special: null,
                traits: { cheer: 0.6, temper: 0.2, lazy: 0.3 }, desc: 'A freshly hatched blob.' },

    mochi:    { name: 'MOCHI',    stage: 'child', stats: S(3, 1, 2, 2), special: { name: 'BOUNCE', type: 'dodge' },
                traits: { cheer: 0.7, temper: 0.1, lazy: 0.3 }, desc: 'Round and soft. Well looked after.' },
    kuchibo:  { name: 'KUCHIBO',  stage: 'child', stats: S(3, 2, 1, 1), special: { name: 'CHOMP', type: 'double' },
                traits: { cheer: 0.4, temper: 0.5, lazy: 0.4 }, desc: 'All mouth. A bit neglected.' },

    nekoru:   { name: 'NEKORU',   stage: 'teen',  stats: S(4, 2, 2, 3), special: { name: 'SCRATCH', type: 'double' },
                traits: { cheer: 0.6, temper: 0.2, lazy: 0.5 }, desc: 'Well-mannered cat teen.' },
    scrapper: { name: 'SCRAPPER', stage: 'teen',  stats: S(4, 3, 2, 2), special: { name: 'JAB', type: 'double' },
                traits: { cheer: 0.5, temper: 0.6, lazy: 0.1 }, desc: 'Spiky-haired brawler.' },
    blobbo:   { name: 'BLOBBO',   stage: 'teen',  stats: S(5, 2, 3, 1), special: { name: 'SQUISH', type: 'absorb' },
                traits: { cheer: 0.5, temper: 0.3, lazy: 0.8 }, desc: 'Lazy, snacky blob.' },

    kingleo:  { name: 'KINGLEO',  stage: 'adult', stats: S(5, 4, 3, 3), special: { name: 'ROAR', type: 'double' },
                traits: { cheer: 0.5, temper: 0.5, lazy: 0.2 }, desc: 'Proud champion lion.' },
    rokkun:   { name: 'ROKKUN',   stage: 'adult', stats: S(6, 3, 5, 1), special: { name: 'GUARD', type: 'guard' },
                traits: { cheer: 0.3, temper: 0.3, lazy: 0.4 }, desc: 'Sturdy training golem.' },
    starla:   { name: 'STARLA',   stage: 'adult', stats: S(5, 3, 3, 4), special: { name: 'SHINE', type: 'heal' },
                traits: { cheer: 0.9, temper: 0.05, lazy: 0.2 }, desc: 'Graceful star. Excellent care.' },
    mimiko:   { name: 'MIMIKO',   stage: 'adult', stats: S(4, 3, 2, 5), special: { name: 'DASH', type: 'dodge' },
                traits: { cheer: 0.8, temper: 0.2, lazy: 0.1 }, desc: 'Speedy bunny.' },
    chubbo:   { name: 'CHUBBO',   stage: 'adult', stats: S(7, 2, 4, 1), special: { name: 'BELLY', type: 'absorb' },
                traits: { cheer: 0.6, temper: 0.2, lazy: 0.9 }, desc: 'Too many snacks...' },
    ghoulie:  { name: 'GHOULIE',  stage: 'adult', stats: S(4, 4, 2, 3), special: { name: 'HAUNT', type: 'drain' },
                traits: { cheer: 0.2, temper: 0.7, lazy: 0.5 }, desc: 'Born of neglect. Spooky.' },
    oyaji:    { name: 'OYAJI',    stage: 'adult', stats: S(5, 3, 3, 2), special: { name: 'GRUMBLE', type: 'stun' },
                traits: { cheer: 0.2, temper: 0.8, lazy: 0.6 }, desc: 'Grumpy old man.' },

    drakon:   { name: 'DRAKON',   stage: 'secret', stats: S(7, 5, 4, 4), special: { name: 'INFERNO', type: 'inferno' },
                traits: { cheer: 0.5, temper: 0.6, lazy: 0.1 }, desc: 'SECRET: undefeated battler.' },
    seraphi:  { name: 'SERAPHI',  stage: 'secret', stats: S(6, 4, 4, 5), special: { name: 'HALO', type: 'fullheal' },
                traits: { cheer: 1.0, temper: 0.0, lazy: 0.2 }, desc: 'SECRET: perfect care.' }
  };

  T.EVOLUTION = {
    // age (game ms since hatching) at which a pet LEAVES each stage
    leaveAt: { baby: C.CHILD_AT, child: C.TEEN_AT, teen: C.ADULT_AT, adult: C.SECRET_AT },
    rules: [
      // ---- baby -> child
      { from: ['baby'], to: 'mochi',   when: v => v.careMistakes <= 2, desc: 'care mistakes <= 2' },
      { from: ['baby'], to: 'kuchibo', desc: 'otherwise' },

      // ---- child -> teen
      { from: ['child'], to: 'scrapper', when: v => v.training >= 8 || v.battles >= 3, desc: 'training >= 8 or battles >= 3' },
      { from: ['child'], to: 'nekoru',   when: v => v.careMistakes <= 3 && v.discipline >= 50, desc: 'mistakes <= 3 & discipline >= 50%' },
      { from: ['child'], to: 'blobbo',   desc: 'otherwise' },

      // ---- teen -> adult
      { from: ['teen'],               to: 'ghoulie', when: v => v.careMistakes >= 8, desc: 'care mistakes >= 8 (neglect)' },
      { from: ['scrapper', 'nekoru'], to: 'kingleo', when: v => v.battles >= 5 && v.winRate >= 0.6, desc: 'battles >= 5 & win rate >= 60%' },
      { from: ['nekoru'],             to: 'starla',  when: v => v.careMistakes <= 2 && v.discipline >= 75, desc: 'mistakes <= 2 & discipline >= 75%' },
      { from: ['teen'],               to: 'chubbo',  when: v => v.weight >= 45 || (v.snacks > v.meals && v.snacks >= 6), desc: 'weight >= 45 or mostly snacks' },
      { from: ['nekoru'],             to: 'mimiko',  desc: 'nekoru otherwise' },
      { from: ['blobbo'],             to: 'rokkun',  when: v => v.training >= 12, desc: 'blobbo with training >= 12' },
      { from: ['blobbo'],             to: 'oyaji',   desc: 'blobbo otherwise' },
      { from: ['scrapper'],           to: 'rokkun',  desc: 'scrapper otherwise' },

      // ---- adult -> secret (optional; if nothing matches the pet stays an adult)
      { from: ['adult'], to: 'drakon',  when: v => v.battles >= 10 && v.losses === 0, desc: '10+ battles, never lost' },
      { from: ['adult'], to: 'seraphi', when: v => v.careMistakes === 0 && v.discipline >= 100, desc: 'zero care mistakes & 100% discipline' }
    ]
  };

  const Evolution = {
    /** Variables the rules can look at. */
    vars(s) {
      const losses = s.battles - s.wins;
      return {
        age: s.ageMs, years: Math.floor(s.ageMs / C.DAY), stage: s.stage, form: s.formId,
        battles: s.battles, wins: s.wins, losses, winRate: s.battles ? s.wins / s.battles : 0,
        meals: s.meals, snacks: s.snacks, weight: s.weight,
        careMistakes: s.careMistakes, training: s.training, discipline: s.discipline
      };
    },
    matches(rule, s) {
      return rule.from.some(f => f === s.formId || f === s.stage || (f === 'adult' && s.stage === 'adult'));
    },
    /** Which form would this pet evolve into right now (ignoring age)? null if none. */
    pick(s) {
      const v = this.vars(s);
      for (const r of T.EVOLUTION.rules) {
        if (!this.matches(r, s)) continue;
        if (!r.when || r.when(v)) return r.to;
      }
      return null;
    },
    /** Is the pet old enough to leave its current stage (and hasn't been checked already)? */
    due(s) {
      const at = T.EVOLUTION.leaveAt[s.stage];
      if (at == null) return false;
      if (s.stage === 'adult' && s.secretChecked) return false;
      return s.ageMs >= at;
    },
    nextAgeAt(s) { return T.EVOLUTION.leaveAt[s.stage]; },
    formsByStage(stage) { return Object.keys(T.FORMS).filter(k => T.FORMS[k].stage === stage); }
  };
  T.Evolution = Evolution;
})(window.Tama);
