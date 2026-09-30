/* TAMA-PIX — global config & tunables.
 * All game durations are in "game milliseconds". Game time = real time * SPEED.
 * Change SPEED here (or use ?speed=10 in the URL) to make everything faster/slower.
 */
window.Tama = window.Tama || {};
(function (T) {
  'use strict';
  const params = new URLSearchParams(location.search);

  T.CONFIG = {
    SPEED: parseFloat(params.get('speed')) || 1,   // <-- global time multiplier
    DEBUG: params.get('debug') === '1',             // hidden debug panel (?debug=1)
    SAVE_KEY: 'tamapix.save.v1',
    SETTINGS_KEY: 'tamapix.settings.v1',
    SIM_STEP_MS: 1000,                              // simulation granularity (game ms)

    // Time spent away (tab closed / hidden) is simulated, but slowed down so a pet
    // isn't instantly lost overnight. Set OFFLINE_FACTOR = 1 for "hardcore" real time.
    OFFLINE_FACTOR: 0.25,
    MAX_OFFLINE_REAL_MS: 3 * 60 * 60 * 1000,        // at most 3h of real absence is simulated

    STAGE_W: 48, STAGE_H: 24,                       // gameplay stage (logical pixels) inside the full-screen scene

    // Online battles. '' = same host as the page (ws(s)://<host>/ws). Override with ?server=wss://host/ws
    // When the page is opened as a file:// (or the server can't be reached) RANDOM falls back to a CPU rival.
    SERVER_URL: params.get('server') || '',
    SEARCH_MS: 12000,                               // how long RANDOM looks for an opponent

    T: {
      HATCH: 12e3,              // egg -> baby
      DAY: 240e3,               // one "day" == one year of age (like the original)
      NIGHT_FRAC: 0.78,         // pet sleeps for the last 22% of each day
      // Evolution age thresholds (game ms since hatching)
      CHILD_AT: 150e3,
      TEEN_AT: 540e3,
      ADULT_AT: 1140e3,
      SECRET_AT: 2160e3,
      // Heart decay (ms per heart lost) by stage
      HUNGER: { baby: 40e3, child: 55e3, teen: 65e3, adult: 75e3, secret: 80e3 },
      HAPPY:  { baby: 50e3, child: 65e3, teen: 75e3, adult: 90e3, secret: 95e3 },
      POOP_MIN: 80e3, POOP_MAX: 140e3,
      CALL_TIMEOUT: 60e3,       // ignoring an empty-heart call this long = care mistake
      LIGHT_TIMEOUT: 40e3,      // lights left on while asleep
      POOP_TIMEOUT: 100e3,      // an uncleaned poop this old = care mistake
      SICK_TIMEOUT: 90e3,       // untreated sickness = care mistake
      SICK_DEATH: 300e3,        // untreated sickness this long = death
      STARVE_DEATH: 420e3,      // hunger at zero this long = death
      FAKE_MIN: 90e3, FAKE_MAX: 200e3, FAKE_TIMEOUT: 45e3   // discipline "fake" calls
    },
    MIN_WEIGHT: { egg: 5, baby: 5, child: 10, teen: 20, adult: 30, secret: 30 }
  };


  T.util = {
    clamp: (v, a, b) => Math.max(a, Math.min(b, v)),
    rand: (a, b) => a + Math.random() * (b - a),
    pick: (arr) => arr[Math.floor(Math.random() * arr.length)],
    chance: (p) => Math.random() < p
  };
})(window.Tama);
