/* TAMA-PIX — economy tables (design C "Fair Energy Hybrid", phase 1: no real money).
 * Shared by the browser (to show prices, caps and timers) and the server (which applies them; see server/rules.js).
 *
 * Principles: care is always free; energy limits how MUCH you do, never how WELL; XP tapers after the first actions
 * of the day; levels are capped per stage; drinks are capped at 3 a day; nothing is random; coins can't be cashed out.
 * Golden rule: coins earned per energy point from work (with every bonus) stay below what a Fizz costs per point.
 */
(function (T) {
  'use strict';
  const C = T.CONFIG, MIN = 60e3, HOUR = 60 * MIN;

  const E = {
    START_COINS: 0,
    // energy costs (care = 0). Friend battles are free but only the first FRIEND_XP_PER_DAY give XP (never coins).
    COST: { train: 10, cpu: 6, online: 10, friend: 0 },
    FRIEND_XP_PER_DAY: 5,
    // XP taper: the first 8 energy actions of the day give full XP, the next 8 half, then a quarter
    TAPER: [{ upTo: 8, mult: 1 }, { upTo: 16, mult: 0.5 }, { upTo: Infinity, mult: 0.25 }],
    // coins
    COINS: { cpuWin: 4, onlineWin: 12, onlineLoss: 4, battleCapPerDay: 80, careBonus: 30, levelUp: 10, evolve: 50 },
    CARE_BONUS_MIN_ACTS: 2,                               // + needs kept at 50%+ and poop cleaned within 1 h (while awake)
    GIFT: [10, 15, 20, 25, 30, 40, 80],                   // 7-day login calendar: pauses when you skip a day, never resets
    // Pix Town Jobs: fixed pay shown in advance, one at a time, the pet is away while working
    JOBS: [
      { id: 'tidy',    name: 'TIDY-UP',     place: 'Pix Town square', ms: 30 * MIN, energy: 10, coins: 10, ore: 0, stages: ['baby', 'teen', 'adult'],
        desc: 'Sweep the town square.' },
      { id: 'cart',    name: 'ORE CART',    place: 'Pix Town Mine',   ms: 1 * HOUR, energy: 20, coins: 25, ore: 1, stages: ['teen', 'adult'],
        desc: 'Push ore carts to the surface.' },
      { id: 'deep',    name: 'DEEP SHIFT',  place: 'Pix Town Mine',   ms: 4 * HOUR, energy: 40, coins: 60, ore: 2, stages: ['teen', 'adult'],
        desc: 'A long shift at the rock face.' },
      { id: 'smelter', name: 'SMELTER',     place: 'Pix Town Mine',   ms: 8 * HOUR, energy: 60, coins: 90, ore: 3, stages: ['adult'],
        desc: 'Feed the furnace all day.' }
    ],
    // shop. price.coins today; add e.g. price.gbp for real-money SKUs later (phase 2) without touching the flow.
    SKUS: [
      { id: 'fizz',   name: 'FIZZ DRINK',  kind: 'drink', price: { coins: 60 }, energy: 30, perDay: 3,
        desc: '+30 energy. Max 3 a day.' },
      { id: 'bun',    name: 'SWEET BUN',   kind: 'food',  price: { coins: 5 },  happy: 1, weight: 1,
        desc: '+1 mood. A treat.', short: '+1 mood' },
      { id: 'stew',   name: 'HEARTY STEW', kind: 'food',  price: { coins: 12 }, hunger: 2, weight: 1,
        desc: '+2 hunger. Good before a shift.', short: '+2 hunger' },
      { id: 'candy',  name: 'RARE CANDY',  kind: 'candy', price: { coins: 300 }, perDay: 1,
        desc: '+1 level now (stats grow). Max 1 a day.', short: '+1 level' },
      { id: 'peptide', name: 'EVOLVE PEPTIDE', kind: 'peptide', price: { coins: 500 }, perStage: 2, cutMs: 12 * HOUR,
        desc: 'Evolves 12 h sooner. Max 2 per stage.', short: '-12 h to evolve' },
      { id: 'pick2',  name: 'PICKAXE II',  kind: 'tool',  price: { coins: 600 },  tool: 'pickaxe', tier: 2, bonus: 0.10,
        desc: '+10% coins from mine jobs.', short: '+10% mine pay' },
      { id: 'pick3',  name: 'PICKAXE III', kind: 'tool',  price: { coins: 1800 }, tool: 'pickaxe', tier: 3, bonus: 0.18, needs: 'pick2',
        desc: '+18% coins from mine jobs.', short: '+18% mine pay' }
    ],
    MAX_WORK_BONUS: 0.30,                                  // rule: total work bonuses never exceed +30%

    job(id) { return E.JOBS.find(j => j.id === id) || null; },
    sku(id) { return E.SKUS.find(k => k.id === id) || null; },
    taperMult(actionsToday) { for (const t of E.TAPER) if (actionsToday < t.upTo) return t.mult; return 0.25; },
    levelCap(stage) { return C.LEVEL_CAP[stage] || C.LEVEL_CAP.adult; },
    workBonus(inv) {
      const tier = (inv && inv.pickaxe) || 1;
      const b = E.SKUS.filter(k => k.tool === 'pickaxe' && k.tier <= tier).reduce((m, k) => Math.max(m, k.bonus), 0);
      return Math.min(E.MAX_WORK_BONUS, b);
    },
    /** Coins a job pays with the player's tools (the tidy-up isn't a mine job: no pickaxe bonus). */
    jobPay(job, inv) { return Math.round(job.coins * (1 + (job.ore ? E.workBonus(inv) : 0))); },
    /** Best coins-per-energy from work vs. a Fizz's coin cost per energy point (must stay below). */
    freeMoneyCheck() {
      const best = Math.max(...E.JOBS.map(j => j.coins * (1 + E.MAX_WORK_BONUS) / j.energy));
      const fizz = E.sku('fizz'), drink = fizz.price.coins / fizz.energy;
      return { best, drink, ok: best < drink };
    },
    /** Minutes of sleep needed to refill from `energy` (display). */
    refillMs(energy) { return Math.max(0, (C.ENERGY.MAX - energy) / C.ENERGY.SLEEP_PER_H * HOUR); }
  };
  T.Economy = E;
})(window.Tama);
