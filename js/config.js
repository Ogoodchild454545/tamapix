/* TAMA-PIX — global config & tunables.
 * All game durations are in "game milliseconds". Game time = real time (SPEED = 1); the pet lives in real time
 * (hatches in a minute, evolves at 2 and 5 days). For testing, ?debug=1&speed=N speeds everything up.
 */
window.Tama = window.Tama || {};
(function (T) {
  'use strict';
  const params = new URLSearchParams(location.search);

  const DEBUG = params.get('debug') === '1';
  const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR;

  T.CONFIG = {
    // Debug-only time multiplier: ?debug=1&speed=60 makes one real second count as a game minute.
    // Without ?debug=1 the game always runs in real time (SPEED = 1).
    SPEED: DEBUG ? (parseFloat(params.get('speed')) || 1) : 1,
    DEBUG,                                          // hidden debug panel (?debug=1)
    SAVE_KEY: 'tamapix.save.v1',
    SAVE_VERSION: 2,
    SETTINGS_KEY: 'tamapix.settings.v1',
    SIM_STEP_MS: 1000,                              // simulation granularity (game ms) while the page is open
    AWAY_STEP_MS: 30e3,                             // coarser steps when catching up on time spent away

    // Time away (tab closed / hidden): the pet AGES fully (evolution is real time), but its needs decay
    // more slowly so a normal night or workday away is survivable. Catch-up is capped for performance only.
    OFFLINE_FACTOR: 0.4,                            // need decay / neglect timers while away
    MAX_CATCHUP_MS: 60 * DAY,                       // beyond this only the age advances

    STAGE_W: 96, STAGE_H: 48,                       // gameplay stage (logical pixels) inside the full-screen scene

    // Online battles. '' = same host as the page (ws(s)://<host>/ws). Override with ?server=wss://host/ws
    // When the page is opened as a file:// (or the server can't be reached) RANDOM falls back to a CPU rival.
    SERVER_URL: params.get('server') || '',
    SEARCH_MS: 12000,                               // how long RANDOM looks for an opponent

    // All durations in game ms (= real ms unless the debug SPEED is set).
    T: {
      MIN, HOUR, DAY,
      HATCH: 60e3,              // egg -> baby after a minute
      TEEN_AT: 2 * DAY,         // 1st evolution: 2 days after hatching (baby -> day-2 form)
      ADULT_AT: 5 * DAY,        // 2nd evolution: 5 days after hatching (-> final form)
      // Sleep follows the pet's clock (= your local time): asleep from SLEEP_AT to WAKE_AT.
      SLEEP_AT: 22, WAKE_AT: 7,
      NEWBORN_AWAKE: HOUR,      // a fresh hatchling stays up for its first hour even at night
      // Heart decay (ms per heart lost) by stage, only while awake
      HUNGER: { baby: 45 * MIN, teen: 70 * MIN, adult: 90 * MIN },
      HAPPY:  { baby: 55 * MIN, teen: 80 * MIN, adult: 100 * MIN },
      POOP_MIN: 100 * MIN, POOP_MAX: 200 * MIN,   // babies poop 30% more often
      CALL_TIMEOUT: 30 * MIN,   // an empty heart ignored this long = care mistake
      LIGHT_TIMEOUT: 30 * MIN,  // lights left on while asleep = care mistake
      POOP_TIMEOUT: 2 * HOUR,   // a poop left this long = care mistake (and a "poop mistake")
      SICK_TIMEOUT: 3 * HOUR,   // untreated sickness = care mistake
      SICK_DEATH: 24 * HOUR,    // untreated sickness for this much awake time = death
      STARVE_DEATH: 24 * HOUR,  // hunger at zero for this much awake time = death
      // chance per awake hour of falling sick
      SICK_RATE: { perPoop: 0.12, starving: 0.08, miserable: 0.05 },
      FAKE_MIN: 2 * HOUR, FAKE_MAX: 5 * HOUR, FAKE_TIMEOUT: 20 * MIN   // discipline "fake" calls
    },
    MIN_WEIGHT: { egg: 5, baby: 5, teen: 15, adult: 25 }
  };


  T.util = {
    clamp: (v, a, b) => Math.max(a, Math.min(b, v)),
    rand: (a, b) => a + Math.random() * (b - a),
    pick: (arr) => arr[Math.floor(Math.random() * arr.length)],
    chance: (p) => Math.random() < p
  };
})(window.Tama);
