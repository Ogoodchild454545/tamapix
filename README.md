# TAMA·PIX — a 90s-style virtual pet (plain HTML/CSS/JS + optional Node server)

A classic monster-RPG look (think Gen 2-3 handheld monster games, less cute): a muted GBA-era meadow with
textured dark grass, swaying tall-grass tufts, mountains, a treeline and rocks (muted dusk while your pet sleeps,
a dark-blue night with faint stars when the lights are off), fierce 40×40 shaded monsters with dark outlines and a
2-frame idle, Gen-3 style battles, and a dark slate RPG interface with a crisp pixel font.
**Tap-only** controls, fills phones (portrait first) and desktops. The pet lives in **real time** (hatches in a
minute, evolves at day 2 and day 5 down a branching tree), levels up from training and battles, and fights the
computer, a friend's code, or a random player online.

## Life cycle (real time)
* **Egg** hatches after 1 minute into the **BLOB**: every pet is this shapeless mass until day 2.
* **Day 2** (48 h after hatching): 1st evolution into one of 6 forms, chosen from what happened during days 0-2.
* **Day 5**: final evolution; each day-2 form has 2 possible finals, chosen from days 2-5 (+1 secret final).
* Age is real elapsed time since hatching and keeps counting while the game is closed. The pet sleeps when energy is empty or the lights are off (not on a fixed night clock); needs don't drop and evolutions wait while
  it sleeps. The status screen shows
  "Evolves in 1d 4h".
* **Needs** (awake time): a hunger heart every 45-90 min, a mood heart every 55-100 min, a poop every ~2-3 h.
  Ignoring an empty heart 30 min, leaving the light on 30 min at night, a poop 2 h or sickness 3 h = a **care mistake**.
  Poop, starving and misery make it fall sick. Care mistakes, poop mistakes, snacks, weight, discipline, training and
  battle record steer the evolution.
* **Death** needs sustained serious neglect: hunger at zero for 24 h of awake time, or sickness left untreated for
  24 h of awake time (i.e. about 1.5-2 real days of neglect while you play). While the game is closed the needs
  decay at 40% speed (`CONFIG.OFFLINE_FACTOR`), so a night or a day away costs a few care mistakes at most; roughly
  4+ days of total absence can be fatal.
* Old saves (before this version) are migrated: the pet keeps its form (old child/teen forms become day-2 forms,
  old adults/secrets stay finals, FANGLET becomes the BLOB), its age is set to the start of that stage, and XP is
  estimated from its training/battle record.
* Debug/testing only: `?debug=1` opens a panel (time jumps, stage counters, force any branch with a preview,
  evolution-tree gallery); `?debug=1&speed=60` makes one real second a game minute. Without `?debug=1` the
  speed is always real time.

## Levels & XP
Level 1-50, derived only from XP; XP comes only from **training** (a 5-round session: 10 XP + 4 per hit) and
**battles** (win 40, loss 15, ±6 / ±3 per level the foe is above/below you, capped 15-80 / 5-35; fleeing gives
nothing). XP needed for level L: `5·(L-1)·(L+4)` (Lv2 30, Lv10 630, Lv20 2280, Lv50 13230). The level adds a
little to battle stats: +1 HP per 15 levels, +1 POW per 12, +1 DEF per 18, +1 SPD per 25.

## Play
* **Just the game:** open `index.html` directly (file://) or serve the folder with any static server
  (`python3 -m http.server`). Everything works; RANDOM online battles fall back to a computer rival.
* **With accounts, economy and online battles:**
  ```bash
  npm install          # bcryptjs, pg, ws
  SESSION_SECRET=dev npm start   # http://localhost:8080  (PORT / HOST env vars supported)
  ```
  Optional: `DATABASE_URL` for Postgres. Without it the server uses a JSON file under `server/data/`
  (resets if the host wipes the disk). Set `SESSION_SECRET` in production.
  Sign up, log in, or play as guest. Energy/coins, Fizz shop, Pix Town jobs, main menu and the
  notification bell need the Node server (not file://).
  The same process serves the game **and** the WebSocket endpoint (`/ws`). Open it on two
  devices/browsers, pick BATTLE › RANDOM on both, and they get matched.
* Health check: `GET /healthz`.

## Controls (touch / mouse)
* **Tap a button in the pixel bars**: feed, light, play, medicine, clean up (top bar); ↩ back, status, discipline,
  battle, ♪ sound (bottom bar). The bell at the top-right flashes when the pet needs something. All buttons are ≥ 44 px.
* **Sub-screens show dark RPG panels over the meadow** – tap the choices: MEAL/SNACK, LIGHTS ON/OFF,
  RANDOM ONLINE / FRIEND CODE / VS COMPUTER, play = tap the left or right half, battles = tap HIGH or LOW in the text
  box, status = tap to flip pages (PROFILE, HUNGER, MOOD, DISCIPLINE, RECORD), death = tap, then YES for a new egg.
* **↩ (bottom-left) always goes back** – closes menus/status, quits the mini-game, cancels a search, flees a battle.
* Tap the pet for a little reaction.
* Optional keyboard: `1`/`A` next, `2`/`B`/Enter OK, `3`/`C`/Esc back, `M` mute.

## Battles
Gen-3 style layout: the foe stands top-right on a grass platform, your monster bottom-left; each side has a name
plate with level and an HP bar (green → yellow → red), and a text box at the bottom narrates ("DRAKON used CLAW
STRIKE!"), with lunges, hit flashes and screen shake. The ×10 HP numbers are cosmetic (the rules use the small HP
values from `js/evolution.js` + level bonus). Every pet can battle from the BLOB stage on (wins/losses as a BLOB
decide the day-2 branch).

Turn-based: players take turns attacking; the attacker picks HI or LO and the defender guesses where to guard.
A correct guess blocks; a faster defender can sometimes side-step anyway. Every 3rd attack triggers the species'
special move (see `js/evolution.js`).
* **RANDOM** – searches ~12 s (`CONFIG.SEARCH_MS`) for another online player. If nobody is found the screen says
  `NO RIVAL`; if the server can't be reached (static hosting, file://, offline) it says `OFFLINE`; either way a
  computer rival steps in.
* **FRIEND** – opens a sheet with your pet's code (Copy) and a box to paste a friend's code; battles their pet locally.
* **COMPUTER** – a random rival of your stage, within -2..+3 levels of yours.

### Server authority / anti-cheat
The server (`server/server.js`) loads the *same* `js/config.js`, `js/evolution.js` and `js/battle.js` the browser uses
(in a `vm` sandbox) so rules never drift. Clients only send `find {card, ageMs}` and `move {dir, n}`:
* pet data is validated with the shared rules (the form must be reachable at the claimed age: BLOB from hatching,
  day-2 forms from 2 days, finals from 5 days; integer counters in range, wins ≤ battles, weight ≥ stage minimum,
  training not absurd for its age, XP explainable by its trainings/battles, secret form with 15+ battles);
* stats/HP are derived server-side from the form + counters – extra fields like `hp: 999` are ignored;
* moves must be `hi`/`lo` for the current turn number; forged `result` messages, wrong turns and repeats are dropped;
* damage, specials, blocks and the winner are computed only on the server; idle players get a random move after 15 s;
  disconnecting or fleeing forfeits.

Config: `CONFIG.SERVER_URL` in `js/config.js` (default `''` = same host, `ws(s)://<host>/ws`), or `?server=wss://host/ws`.

## Hosting publicly
* **Render (free, permanent `https://<name>.onrender.com` URL):** the repo contains a `render.yaml` Blueprint
  (free Node web service, `npm ci` / `npm start`, health check `/healthz`). Push the repo to GitHub, then open
  `https://render.com/deploy?repo=https://github.com/<you>/<repo>` and click *Apply* (or Dashboard › New › Blueprint).
  Free services sleep after 15 min without traffic and take ~1 min to wake on the next visit.
* Quick demo: `npm start`, then `cloudflared tunnel --url http://localhost:8080` gives a temporary
  `https://*.trycloudflare.com` URL (WebSockets work through it; the URL changes every time the tunnel restarts).
* Run `node server/server.js` on any Node ≥18 host (VPS, Fly.io, Render, Railway…) behind HTTPS; the page then uses
  `wss://` automatically. The reverse proxy must allow WebSocket upgrades on `/ws` (e.g. nginx `proxy_set_header
  Upgrade $http_upgrade; proxy_set_header Connection "upgrade";`) and a read timeout > 30 s.
* Or host the static files on a CDN/GitHub Pages and point `SERVER_URL` at the WebSocket host (enable CORS-free wss).
* It keeps all state in memory and is a single process: fine for a hobby deployment; for more players add sticky
  sessions or a shared queue (Redis), per-IP connection limits/rate limiting, logging/monitoring, and a process
  manager (systemd/pm2). With accounts, pets/coins/energy are server-side; without a login a guest can still edit a local save
  in localStorage (it only checks the pet is plausible) – real persistence would need server-side profiles.

## Files
| File | What |
|---|---|
| `index.html`, `css/style.css` | full-screen canvas, pixel HUD bars, friend-code sheet |
| `js/config.js` | real-time timings (hatch, day 2/5, sleep hours, need decay, neglect limits), `OFFLINE_FACTOR`, debug `SPEED`, `SERVER_URL` |
| `js/evolution.js` | species table (stats, specials, traits) + the branching evolution tree (data table) |
| `js/personality.js` | mood/idle brain; `Tama.Personality.setBrain(fn)` hook for an AI layer |
| `js/pet.js` | state, real-time simulation, care actions, XP, save/load + v1 save migration, time-away catch-up |
| `js/battle.js` | XP/levels, battle maths (shared with the server), CPU rivals, friend codes (TP2 with XP; TP1 still read) |
| `js/net.js` | WebSocket client (matchmaking, moves) |
| `js/game.js` | UI state machine, tap zones, animations, battles, main loop, fit-to-screen |
| `js/scene.js` | scene renderer: integer-scaled low-res canvas, cached GBA-style meadow (sky, mountains, treeline, textured grass, rocks; dusk/night by tinting) + animated tufts/clouds/stars, battle field with grass platforms, dark RPG UI helpers (panels, buttons, text boxes, HP bars, emotes) |
| `js/monsters.js` | monster sprite engine: every form (and props like food, rocks, tomb) is built from shaded parts (ellipses, capsules, polygons) with 4-tone material ramps, top-left light, inner lines and a dark outline; frames 0/1 = idle, 2 = asleep |
| `js/font.js` | proportional pixel font (upper/lower case, digits, punctuation) |
| `js/sprites.js` | small 1-bit icons for the HUD buttons and emotes |
| `js/audio.js`, `js/debug.js` | beeps; hidden debug panel (`?debug=1`: time jumps, stage counters, force/preview branches, tree gallery) |
| `server/server.js` | static host + WebSocket matchmaking/battles (`package.json` at the root: dependency `ws`) |
| `render.yaml`, `.node-version` | Render Blueprint (free web service) and Node version pin |
| `test_e2e.py` | Playwright tests + screenshots (starts/stops its own servers on :8765) |

## Evolution tree
All rules live in one data table in `js/evolution.js` (`T.EVOLUTION.tree`, first matching branch wins; counters are
those of the stage that is ending and reset at each evolution; discipline and weight are current values).

**EGG → BLOB** (1 min, every pet). **Day 2, BLOB becomes:**
| Day-2 form | Condition (days 0-2) | Day-5 finals (condition during days 2-5) |
|---|---|---|
| MUCKSPAWN (sludge) | 4+ poops left uncleaned for 2 h | TOXITAN (10+ trainings/battles and ≤3 poop mistakes) · SLUDGE KING (otherwise) |
| VESPERAN (dark angel) | 5+ battle wins at 70%+ | WARSERAPH (6+ wins at 60%+, discipline 50%+, ≤3 care mistakes) · NOXSERAPH (otherwise) |
| TALONIX (battered) | 5+ losses, more losses than wins | DREADCLAW (6+ battles at 50%+ wins, or 12+ trainings) · GRIMTUSK (otherwise) |
| MIREBACK (brute) | overfed: 10+ snacks (≥1 per 2 meals) or 15+ over min weight | BASTION (10+ trainings, <20 over min weight) · BEHEMOTH (otherwise) |
| LYNXAR (noble) | ≤2 care mistakes, discipline 50%+, 5+ trainings | LUMISTAG (≤1 care mistake, discipline 75%+) · KAISERON (otherwise) |
| GNASHER (default) | otherwise | WRAITH (4+ care mistakes and <8 trainings) · GALEHARE (otherwise) |

**Secret:** DRAKON – checked first at day 5 from any day-2 form: 15+ battles in its life, never lost, 8+ during days 2-5.

Internal form ids (`blob`, `vesper`, `kingleo`…) are what saves, friend codes and the server use; old ids are
mapped (`pixbit` → `blob`, `mochi` → `nekoru`). The debug panel (`?debug=1`) lists the branches of the current form
with the one the current counters would pick, can force any branch (with a preview) and shows the whole tree
(*Evolution tree*).
