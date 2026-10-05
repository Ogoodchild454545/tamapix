/* TAMA-PIX — global config & tunables (shared by the browser and the server, which loads this file in a vm).
 * All durations are in milliseconds of real time: the pet hatches in a minute and evolves at 2 and 5 days.
 * The server is authoritative: it runs the simulation from timestamps. Debug time skips / speed-ups only exist on a
 * server started with DEBUG=1 (never in production); ?debug=1 in the page just shows the debug panel.
 */
window.Tama = window.Tama || {};
(function (T) {
  'use strict';
  const params = new URLSearchParams((typeof location !== 'undefined' && location.search) || '');

  const DEBUG = params.get('debug') === '1';
  const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR;

  T.CONFIG = {
    SPEED: 1,                                       // time always runs at real speed in the browser (see server DEBUG)
    DEBUG,                                          // hidden debug panel (?debug=1); its actions need a DEBUG server
    SAVE_KEY: 'tamapix.save.v1',                    // old browser-only save (offered for a one-time import)
    SAVE_VERSION: 3,
    SETTINGS_KEY: 'tamapix.settings.v1',
    SIM_STEP_MS: 1000,                              // simulation granularity (game ms) while the page is open
    AWAY_STEP_MS: 30e3,                             // coarser steps when catching up on time spent away

    // Time away (tab closed / hidden): the pet AGES fully (evolution is real time), but its needs decay
    // more slowly so a normal night or workday away is survivable. Catch-up is capped for performance only.
    OFFLINE_FACTOR: 0.4,                            // need decay / neglect timers while away
    MAX_CATCHUP_MS: 60 * DAY,                       // beyond this only the age advances

    STAGE_W: 96, STAGE_H: 48,                       // gameplay stage (logical pixels) inside the full-screen scene

    // Server: the API (/api/...) and battles (WebSocket /ws) are on the same host as the page.
    SEARCH_MS: 12000,                               // how long RANDOM looks for an opponent
    POLL_MS: 10000,                                 // how often the page refreshes the pet from the server
    PRESENT_GAP_MS: 60000,                          // no request for this long = the player was away (softened needs)

    // Energy (design C "Fair Energy Hybrid"). Care actions never cost energy.
    // Sleep = the only energy source besides on-time care and drinks: lights off -> sleeps and recharges SLEEP_PER_H
    // until the lights go on; energy at 0 -> collapses into a nap (lights on) at NAP_PER_H until NAP_WAKE_AT.
    ENERGY: { MAX: 100, SLEEP_PER_H: 15, NAP_PER_H: 8, NAP_WAKE_AT: 40, EARNBACK: 2, EARNBACK_MAX: 10 },
    SLEEP_DECAY: 0.3,                               // hunger/mood/neglect timers run at 30% while asleep
    WORK_DECAY: 1.5,                                // hunger/mood fall 1.5x faster while working a job
    LEVEL_CAP: { egg: 10, baby: 10, teen: 25, adult: 40 },   // BLOB Lv10, day-2 forms Lv25, finals Lv40

    // All durations in game ms (= real ms unless the debug SPEED is set).
    T: {
      MIN, HOUR, DAY,
      HATCH: 60e3,              // egg -> baby after a minute
      TEEN_AT: 2 * DAY,         // 1st evolution: 2 days after hatching (baby -> day-2 form)
      ADULT_AT: 5 * DAY,        // 2nd evolution: 5 days after hatching (-> final form)
      // Heart decay (ms per heart lost) by stage (x SLEEP_DECAY while asleep)
      HUNGER: { baby: 45 * MIN, teen: 70 * MIN, adult: 90 * MIN },
      HAPPY:  { baby: 55 * MIN, teen: 80 * MIN, adult: 100 * MIN },
      POOP_MIN: 100 * MIN, POOP_MAX: 200 * MIN,   // babies poop 30% more often
      CALL_TIMEOUT: 30 * MIN,   // an empty heart ignored this long = care mistake
      POOP_TIMEOUT: 2 * HOUR,   // a poop left this long = care mistake (and a "poop mistake")
      SICK_TIMEOUT: 3 * HOUR,   // untreated sickness = care mistake
      SICK_DEATH: 24 * HOUR,    // untreated sickness for this much need-time = death
      STARVE_DEATH: 24 * HOUR,  // hunger at zero for this much need-time = death
      // chance per awake hour of falling sick
      SICK_RATE: { perPoop: 0.12, starving: 0.08, miserable: 0.05 },
      FAKE_MIN: 2 * HOUR, FAKE_MAX: 5 * HOUR, FAKE_TIMEOUT: 20 * MIN   // discipline "fake" calls
    },
    MIN_WEIGHT: { egg: 5, baby: 5, teen: 15, adult: 25 }
  };


  // ---- time zones: the pet's clock is the player's local time (server passes the IANA zone name)
  const offCache = {};
  function tzOffset(ms, tz) {            // minutes to add to UTC to get local time in `tz`
    if (!tz) return -new Date(ms).getTimezoneOffset();
    const bucket = Math.floor(ms / 900000), key = tz + ':' + bucket;
    if (offCache[key] != null) return offCache[key];
    let off = 0;
    try {
      const f = offCache['f:' + tz] || (offCache['f:' + tz] = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23',
        year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }));
      const p = {}; f.formatToParts(new Date(bucket * 900000)).forEach(x => { p[x.type] = +x.value; });
      off = Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute) - bucket * 900000) / 60000);
    } catch (e) { off = 0; }
    return (offCache[key] = off);
  }
  function validTz(tz) {
    if (typeof tz !== 'string' || tz.length > 64 || !/^[A-Za-z_+\-\/0-9]+$/.test(tz)) return false;
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (e) { return false; }
  }

  T.util = {
    tzOffset, validTz,
    /** Local wall-clock parts at `ms` in zone `tz` (undefined = this machine's zone). */
    local(ms, tz) {
      const d = new Date(ms + tzOffset(ms, tz) * 60000);
      return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds(),
               key: d.toISOString().slice(0, 10) };
    },
    /** ms until the next local midnight. */
    toMidnight(ms, tz) { const l = T.util.local(ms, tz); return ((24 - l.h) * 3600 - l.mi * 60 - l.s) * 1000; },
    clamp: (v, a, b) => Math.max(a, Math.min(b, v)),
    rand: (a, b) => a + Math.random() * (b - a),
    pick: (arr) => arr[Math.floor(Math.random() * arr.length)],
    chance: (p) => Math.random() < p
  };
})(window.Tama);
