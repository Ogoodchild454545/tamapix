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
    egg:      { name: 'EGG',      stage: 'egg', desc: 'A dark, humming egg.' },
    pixbit:   { name: 'FANGLET', move: 'BITE',   stage: 'baby',  stats: S(2, 1, 1, 1), special: null,
                traits: { cheer: 0.6, temper: 0.2, lazy: 0.3 }, desc: 'Horned hatchling. Already bites.' },

    mochi:    { name: 'VULPEX', move: 'SCRATCH',    stage: 'child', stats: S(3, 1, 2, 2), special: { name: "EMBER DASH", type: 'dodge' },
                traits: { cheer: 0.7, temper: 0.1, lazy: 0.3 }, desc: 'Ember fox pup. Well raised.' },
    kuchibo:  { name: 'GNASHER', move: 'BITE',  stage: 'child', stats: S(3, 2, 1, 1), special: { name: "CRUNCH", type: 'double' },
                traits: { cheer: 0.4, temper: 0.5, lazy: 0.4 }, desc: 'Swamp biter. A little neglected.' },

    nekoru:   { name: 'LYNXAR', move: 'SLASH',   stage: 'teen',  stats: S(4, 2, 2, 3), special: { name: "SHADOW CLAW", type: 'double' },
                traits: { cheer: 0.6, temper: 0.2, lazy: 0.5 }, desc: 'Disciplined prowler.' },
    scrapper: { name: 'TALONIX', move: 'CLAW STRIKE', stage: 'teen',  stats: S(4, 3, 2, 2), special: { name: "TALON RUSH", type: 'double' },
                traits: { cheer: 0.5, temper: 0.6, lazy: 0.1 }, desc: 'Raptor brawler, loves to fight.' },
    blobbo:   { name: 'MIREBACK', move: 'TACKLE',   stage: 'teen',  stats: S(5, 2, 3, 1), special: { name: "MUD SHELL", type: 'absorb' },
                traits: { cheer: 0.5, temper: 0.3, lazy: 0.8 }, desc: 'Slow, moss-shelled brute.' },

    kingleo:  { name: 'KAISERON', move: 'FANG STRIKE',  stage: 'adult', stats: S(5, 4, 3, 3), special: { name: "KING'S ROAR", type: 'double' },
                traits: { cheer: 0.5, temper: 0.5, lazy: 0.2 }, desc: 'Crowned lion-dragon. A champion.' },
    rokkun:   { name: 'BASTION', move: 'ROCK FIST',   stage: 'adult', stats: S(6, 3, 5, 1), special: { name: "IRON WALL", type: 'guard' },
                traits: { cheer: 0.3, temper: 0.3, lazy: 0.4 }, desc: 'Rune-cored stone golem.' },
    starla:   { name: 'LUMISTAG', move: 'ANTLER RAM',   stage: 'adult', stats: S(5, 3, 3, 4), special: { name: "STARLIGHT", type: 'heal' },
                traits: { cheer: 0.9, temper: 0.05, lazy: 0.2 }, desc: 'Star-antlered stag. Flawless care.' },
    mimiko:   { name: 'GALEHARE', move: 'BLADE TAIL',   stage: 'adult', stats: S(4, 3, 2, 5), special: { name: "GALE STEP", type: 'dodge' },
                traits: { cheer: 0.8, temper: 0.2, lazy: 0.1 }, desc: 'Blade-tailed wind jackal.' },
    chubbo:   { name: 'BEHEMOTH', move: 'HORN BASH',   stage: 'adult', stats: S(7, 2, 4, 1), special: { name: "BULWARK", type: 'absorb' },
                traits: { cheer: 0.6, temper: 0.2, lazy: 0.9 }, desc: 'Tusked colossus. Fed too well.' },
    ghoulie:  { name: 'WRAITH', move: 'SHADE CLAW',  stage: 'adult', stats: S(4, 4, 2, 3), special: { name: "SOUL DRAIN", type: 'drain' },
                traits: { cheer: 0.2, temper: 0.7, lazy: 0.5 }, desc: 'Born of neglect. Hungers.' },
    oyaji:    { name: 'GRIMTUSK', move: 'TUSK GORE',    stage: 'adult', stats: S(5, 3, 3, 2), special: { name: "WAR GRUNT", type: 'stun' },
                traits: { cheer: 0.2, temper: 0.8, lazy: 0.6 }, desc: 'Scarred elder boar. Ill-tempered.' },

    drakon:   { name: 'DRAKON', move: 'CLAW STRIKE',   stage: 'secret', stats: S(7, 5, 4, 4), special: { name: "INFERNO", type: 'inferno' },
                traits: { cheer: 0.5, temper: 0.6, lazy: 0.1 }, desc: 'SECRET: undefeated dragon.' },
    seraphi:  { name: 'SERAPHIM', move: 'HOLY LANCE',  stage: 'secret', stats: S(6, 4, 4, 5), special: { name: "SACRED HALO", type: 'fullheal' },
                traits: { cheer: 1.0, temper: 0.0, lazy: 0.2 }, desc: 'SECRET: perfect care sentinel.' }
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
