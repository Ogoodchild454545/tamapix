/* TAMA-PIX — species table + branching evolution tree (data-driven; tweak freely).
 *
 *   EGG --1 min--> BLOB (baby, every pet) --day 2--> one of 6 "day-2" forms --day 5--> one of 12 finals (+1 secret)
 *
 * Age is real time since hatching (CONFIG.T.TEEN_AT / ADULT_AT). A pet only evolves while awake, so an evolution
 * that falls due at night happens when it wakes up.
 *
 * FORMS: every species. stage = baby | teen (day-2 form) | adult (final). stats = battle stats {hp, pow, def, spd};
 *        special = battle move that fires on every 3rd attack; move = basic attack name; traits feed personality.
 *        Form ids are internal (kept stable for saves / friend codes); `name` is what the player sees.
 * TREE:  for each form, the ordered list of branches it can evolve into. At evolution time the FIRST branch whose
 *        `when(v)` is true wins; a branch without `when` is the fallback. `v` holds the counters of the stage that is
 *        ending (they reset at every evolution) plus a few lifetime values - see Tama.Evolution.vars().
 * SECRET: checked before the normal day-5 branches of every day-2 form.
 */
(function (T) {
  'use strict';
  const S = (hp, pow, def, spd) => ({ hp, pow, def, spd });
  const C = T.CONFIG.T;

  // special.type: double | heal | guard | dodge | absorb | drain | stun | inferno | fullheal
  T.FORMS = {
    egg:      { name: 'EGG', stage: 'egg', desc: 'A dark, humming egg.' },
    blob:     { name: 'BLOB', move: 'ENGULF', stage: 'baby', stats: S(2, 1, 1, 1), special: null,
                traits: { cheer: 0.4, temper: 0.3, lazy: 0.5 }, desc: 'Every pet hatches as this shapeless mass.' },

    // ---- day-2 forms (stage "teen")
    vesper:   { name: 'VESPERAN', move: 'DUSK TALON', stage: 'teen', stats: S(4, 3, 2, 3), special: { name: 'NIGHT DIVE', type: 'dodge' },
                traits: { cheer: 0.4, temper: 0.6, lazy: 0.2 }, desc: 'Young dark angel. Born of victory.' },
    scrapper: { name: 'TALONIX', move: 'CLAW STRIKE', stage: 'teen', stats: S(4, 3, 2, 2), special: { name: 'TALON RUSH', type: 'double' },
                traits: { cheer: 0.5, temper: 0.7, lazy: 0.1 }, desc: 'Battered raptor. Never stays down.' },
    muck:     { name: 'MUCKSPAWN', move: 'MUCK SPIT', stage: 'teen', stats: S(5, 2, 2, 1), special: { name: 'SLIME COAT', type: 'absorb' },
                traits: { cheer: 0.3, temper: 0.4, lazy: 0.8 }, desc: 'Crawled out of its own filth.' },
    blobbo:   { name: 'MIREBACK', move: 'TACKLE', stage: 'teen', stats: S(5, 2, 3, 1), special: { name: 'MUD SHELL', type: 'absorb' },
                traits: { cheer: 0.5, temper: 0.3, lazy: 0.8 }, desc: 'Overfed, moss-shelled brute.' },
    nekoru:   { name: 'LYNXAR', move: 'SLASH', stage: 'teen', stats: S(4, 2, 2, 3), special: { name: 'SHADOW CLAW', type: 'double' },
                traits: { cheer: 0.6, temper: 0.2, lazy: 0.4 }, desc: 'Noble prowler. Raised with care.' },
    kuchibo:  { name: 'GNASHER', move: 'BITE', stage: 'teen', stats: S(4, 2, 2, 2), special: { name: 'CRUNCH', type: 'double' },
                traits: { cheer: 0.4, temper: 0.5, lazy: 0.4 }, desc: 'Swamp biter. Nothing special... yet.' },

    // ---- finals (stage "adult")
    seraphi:  { name: 'WARSERAPH', move: 'HOLY LANCE', stage: 'adult', stats: S(6, 4, 4, 4), special: { name: 'JUDGEMENT', type: 'double' },
                traits: { cheer: 0.6, temper: 0.4, lazy: 0.1 }, desc: 'Archangel of war. Disciplined victor.' },
    noxseraph:{ name: 'NOXSERAPH', move: 'BLACK LANCE', stage: 'adult', stats: S(5, 5, 2, 4), special: { name: 'FALLEN HALO', type: 'drain' },
                traits: { cheer: 0.1, temper: 0.8, lazy: 0.3 }, desc: 'Fallen seraph. Power without restraint.' },
    dreadclaw:{ name: 'DREADCLAW', move: 'REND', stage: 'adult', stats: S(6, 5, 3, 2), special: { name: 'SAVAGE RUSH', type: 'double' },
                traits: { cheer: 0.4, temper: 0.7, lazy: 0.1 }, desc: 'Scarred apex raptor. Learned to win.' },
    oyaji:    { name: 'GRIMTUSK', move: 'TUSK GORE', stage: 'adult', stats: S(6, 3, 3, 2), special: { name: 'WAR GRUNT', type: 'stun' },
                traits: { cheer: 0.2, temper: 0.8, lazy: 0.6 }, desc: 'Scarred elder boar. Bitter from defeat.' },
    sludgeking:{ name: 'SLUDGE KING', move: 'SLUDGE SLAM', stage: 'adult', stats: S(7, 3, 4, 1), special: { name: 'TOXIC FLOOD', type: 'drain' },
                traits: { cheer: 0.3, temper: 0.5, lazy: 0.9 }, desc: 'Crowned in muck. Rules the filth.' },
    toxitan:  { name: 'TOXITAN', move: 'ACID FIST', stage: 'adult', stats: S(7, 4, 4, 1), special: { name: 'CORRODE', type: 'stun' },
                traits: { cheer: 0.3, temper: 0.6, lazy: 0.4 }, desc: 'Toxic colossus of sludge and stone.' },
    rokkun:   { name: 'BASTION', move: 'ROCK FIST', stage: 'adult', stats: S(6, 3, 5, 1), special: { name: 'IRON WALL', type: 'guard' },
                traits: { cheer: 0.3, temper: 0.3, lazy: 0.4 }, desc: 'Rune-cored golem. Trained hard.' },
    chubbo:   { name: 'BEHEMOTH', move: 'HORN BASH', stage: 'adult', stats: S(7, 2, 4, 1), special: { name: 'BULWARK', type: 'absorb' },
                traits: { cheer: 0.6, temper: 0.2, lazy: 0.9 }, desc: 'Tusked colossus. Fed far too well.' },
    starla:   { name: 'LUMISTAG', move: 'ANTLER RAM', stage: 'adult', stats: S(5, 3, 3, 4), special: { name: 'STARLIGHT', type: 'heal' },
                traits: { cheer: 0.9, temper: 0.05, lazy: 0.2 }, desc: 'Star-antlered stag. Flawless care.' },
    kingleo:  { name: 'KAISERON', move: 'FANG STRIKE', stage: 'adult', stats: S(5, 4, 3, 3), special: { name: "KING'S ROAR", type: 'double' },
                traits: { cheer: 0.5, temper: 0.5, lazy: 0.2 }, desc: 'Crowned lion-dragon. Noble blood.' },
    mimiko:   { name: 'GALEHARE', move: 'BLADE TAIL', stage: 'adult', stats: S(4, 3, 2, 5), special: { name: 'GALE STEP', type: 'dodge' },
                traits: { cheer: 0.8, temper: 0.2, lazy: 0.1 }, desc: 'Blade-tailed wind jackal.' },
    ghoulie:  { name: 'WRAITH', move: 'SHADE CLAW', stage: 'adult', stats: S(4, 4, 2, 3), special: { name: 'SOUL DRAIN', type: 'drain' },
                traits: { cheer: 0.2, temper: 0.7, lazy: 0.5 }, desc: 'Born of neglect. Hungers.' },
    drakon:   { name: 'DRAKON', move: 'CLAW STRIKE', stage: 'adult', secret: true, stats: S(7, 5, 4, 4), special: { name: 'INFERNO', type: 'inferno' },
                traits: { cheer: 0.5, temper: 0.6, lazy: 0.1 }, desc: 'SECRET: undefeated dragon.' }
  };

  // Old form ids (earlier versions of the game) -> current ids. Used for save migration and old friend codes.
  T.LEGACY_FORMS = { pixbit: 'blob', mochi: 'nekoru' };

  T.EVOLUTION = {
    at: { baby: C.TEEN_AT, teen: C.ADULT_AT },    // age (ms since hatching) at which each stage ends
    tree: {
      // ---- day 2: BLOB -> ... (counters from days 0-2)
      blob: [
        { to: 'muck',     when: v => v.poopMistakes >= 4, desc: '4+ poops left uncleaned for 2 h' },
        { to: 'vesper',   when: v => v.wins >= 5 && v.winRate >= 0.7, desc: '5+ battle wins, win rate 70%+' },
        { to: 'scrapper', when: v => v.losses >= 5 && v.losses > v.wins, desc: '5+ battle losses, more losses than wins' },
        { to: 'blobbo',   when: v => v.overweight >= 15 || (v.snacks >= 10 && v.snacks * 2 >= v.meals), desc: 'overfed: 10+ snacks (1 per 2 meals) or very heavy' },
        { to: 'nekoru',   when: v => v.careMistakes <= 2 && v.discipline >= 50 && v.training >= 5, desc: 'great care: <=2 mistakes, discipline 50%+, 5+ trainings' },
        { to: 'kuchibo',  desc: 'otherwise' }
      ],
      // ---- day 5: day-2 form -> final (counters from days 2-5)
      vesper: [
        { to: 'seraphi',  when: v => v.wins >= 6 && v.winRate >= 0.6 && v.discipline >= 50 && v.careMistakes <= 3, desc: '6+ wins, win rate 60%+, discipline 50%+, <=3 mistakes' },
        { to: 'noxseraph', desc: 'otherwise (fallen: losing, undisciplined or neglected)' }
      ],
      scrapper: [
        { to: 'dreadclaw', when: v => (v.battles >= 6 && v.winRate >= 0.5) || v.training >= 12, desc: 'turned it around: 6+ battles at 50%+ wins, or 12+ trainings' },
        { to: 'oyaji',     desc: 'otherwise (keeps losing)' }
      ],
      muck: [
        { to: 'toxitan',    when: v => v.training + v.battles >= 10 && v.poopMistakes <= 3, desc: '10+ trainings/battles and <=3 poop mistakes' },
        { to: 'sludgeking', desc: 'otherwise (keeps wallowing in filth)' }
      ],
      blobbo: [
        { to: 'rokkun', when: v => v.training >= 10 && v.overweight < 20, desc: '10+ trainings and not overweight' },
        { to: 'chubbo', desc: 'otherwise (keeps overeating)' }
      ],
      nekoru: [
        { to: 'starla',  when: v => v.careMistakes <= 1 && v.discipline >= 75, desc: '<=1 care mistake, discipline 75%+' },
        { to: 'kingleo', desc: 'otherwise' }
      ],
      kuchibo: [
        { to: 'ghoulie', when: v => v.careMistakes >= 4 && v.training < 8, desc: '4+ care mistakes and little training' },
        { to: 'mimiko',  desc: 'otherwise' }
      ]
    },
    // secret final: checked first at day 5, whatever the day-2 form
    secret: [
      { to: 'drakon', when: v => v.lifeBattles >= 15 && v.lifeLosses === 0 && v.battles >= 8, desc: 'SECRET: 15+ battles in its life, never lost one (8+ in days 2-5)' }
    ]
  };

  /** Per-stage counters (reset at every evolution). */
  const STAGE_KEYS = ['battles', 'wins', 'losses', 'training', 'careMistakes', 'poopMistakes', 'meals', 'snacks'];

  const Evolution = {
    STAGE_KEYS,
    blankStageStats() { const o = {}; STAGE_KEYS.forEach(k => (o[k] = 0)); return o; },
    /** Variables the branches look at: counters of the current stage + current discipline/weight + lifetime record. */
    vars(s) {
      const st = Object.assign(this.blankStageStats(), s.st || {});
      return Object.assign({}, st, {
        winRate: st.battles ? st.wins / st.battles : 0,
        discipline: s.discipline, weight: s.weight,
        overweight: s.weight - (T.CONFIG.MIN_WEIGHT[s.stage] || 5),
        lifeBattles: s.battles, lifeWins: s.wins, lifeLosses: s.battles - s.wins,
        lifeCareMistakes: s.careMistakes, age: s.ageMs, form: s.formId, stage: s.stage
      });
    },
    /** Ordered branch list for a form (secret first for day-2 forms). */
    branches(formId) {
      const f = T.FORMS[formId]; if (!f) return [];
      const own = T.EVOLUTION.tree[formId] || [];
      return f.stage === 'teen' ? T.EVOLUTION.secret.concat(own) : own;
    },
    /** Which form would this pet evolve into right now (ignoring age)? null if it's a final form. */
    pick(s) {
      const v = this.vars(s);
      for (const r of this.branches(s.formId)) if (!r.when || r.when(v)) return r.to;
      return null;
    },
    /** Branch list with a flag telling which one currently wins (debug / previews). */
    preview(s) {
      const v = this.vars(s), win = this.pick(s);
      return this.branches(s.formId).map(r => ({ to: r.to, desc: r.desc, ok: !r.when || !!r.when(v), chosen: r.to === win }));
    },
    /** Age (ms since hatching) at which the current stage ends; null for eggs and finals. */
    nextAgeAt(s) { const a = T.EVOLUTION.at[s.stage]; return a == null ? null : a; },
    due(s) { const a = this.nextAgeAt(s); return a != null && s.ageMs >= a && !!(T.EVOLUTION.tree[s.formId] || []).length; },
    /** Minimum age for a form's stage (used by the server's plausibility check). */
    entryAge(formId) { const st = (T.FORMS[formId] || {}).stage; return { baby: 0, teen: C.TEEN_AT, adult: C.ADULT_AT }[st]; },
    formsByStage(stage, withSecret) { return Object.keys(T.FORMS).filter(k => T.FORMS[k].stage === stage && (withSecret || !T.FORMS[k].secret)); },
    /** Parent day-2 form(s) of a final (for the gallery). */
    parents(formId) { return Object.keys(T.EVOLUTION.tree).filter(k => T.EVOLUTION.tree[k].some(r => r.to === formId)); }
  };
  T.Evolution = Evolution;
})(window.Tama);
