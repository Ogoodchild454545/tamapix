# TAMA·PIX — a 90s-style virtual pet (plain HTML/CSS/JS + optional Node server)

A full-screen pixel-art meadow (drifting clouds, swaying grass and flowers; dusk when your pet sleeps, a starry
night sky when the lights are off, a sandy arena for battles) with chunky, colour, dark-outlined pixel pets.
**Tap-only** controls, fills phones (portrait first) and desktops, branching evolution, and battles against the computer, a friend's code, or a random player online.

## Play
* **Just the game:** open `index.html` directly (file://) or serve the folder with any static server
  (`python3 -m http.server`). Everything works; RANDOM online battles fall back to a computer rival.
* **With online battles:**
  ```bash
  npm install          # (repo root) installs the single dependency: ws
  npm start            # http://localhost:8080  (PORT=xxxx and HOST=... env vars supported)
  ```
  The Node server serves the game **and** the WebSocket endpoint (`/ws`). Open the page from it on two
  devices/browsers, pick BATTLE › RANDOM on both, and they get matched.
* Health check: `GET /healthz`.

## Controls (touch / mouse)
* **Tap a button in the pixel bars**: feed, light, play, medicine, clean up (top bar); ↩ back, status, discipline,
  battle, ♪ sound (bottom bar). The bell at the top-right flashes when the pet needs something. All buttons are ≥ 44 px.
* **Sub-screens show pixel panels over the meadow** – tap the choices: MEAL/SNACK, ON/OFF, RANDOM/FRIEND/COMPUTER,
  play = tap the left or right half, battles = tap the upper half (HI) or lower half (LO), status = tap to flip pages,
  death = tap, then YES for a new egg.
* **↩ (bottom-left) always goes back** – closes menus/status, quits the mini-game, cancels a search, flees a battle.
* Tap the pet for a little reaction.
* Optional keyboard: `1`/`A` next, `2`/`B`/Enter OK, `3`/`C`/Esc back, `M` mute.

## Battles
Turn-based: players take turns attacking; the attacker picks HI or LO and the defender guesses where to guard.
A correct guess blocks; a faster defender can sometimes side-step anyway. Every 3rd attack triggers the species'
special move (see `js/evolution.js`).
* **RANDOM** – searches ~12 s (`CONFIG.SEARCH_MS`) for another online player. If nobody is found the screen says
  `NO RIVAL`; if the server can't be reached (static hosting, file://, offline) it says `OFFLINE`; either way a
  computer rival steps in.
* **FRIEND** – opens a sheet with your pet's code (Copy) and a box to paste a friend's code; battles their pet locally.
* **COMPUTER** – a random rival of your stage.

### Server authority / anti-cheat
The server (`server/server.js`) loads the *same* `js/config.js`, `js/evolution.js` and `js/battle.js` the browser uses
(in a `vm` sandbox) so rules never drift. Clients only send `find {card, ageMs}` and `move {dir, n}`:
* pet data is validated (known form old enough for its stage, integer counters in range, wins ≤ battles, weight ≥ stage
  minimum, training not absurd for its age, secret forms plausible);
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
  manager (systemd/pm2). There are no accounts, so the server can't stop someone from editing their *own* save
  in localStorage (it only checks the pet is plausible) – real persistence would need server-side profiles.

## Files
| File | What |
|---|---|
| `index.html`, `css/style.css` | full-screen canvas, pixel HUD bars, friend-code sheet |
| `js/config.js` | **SPEED** (`?speed=10`), timings, `SERVER_URL`, `SEARCH_MS` |
| `js/evolution.js` | species table (stats, specials, traits) + ordered evolution rules |
| `js/personality.js` | mood/idle brain; `Tama.Personality.setBrain(fn)` hook for an AI layer |
| `js/pet.js` | state, simulation, care actions, save/load, offline catch-up |
| `js/battle.js` | battle maths (shared with the server), CPU rivals, friend codes |
| `js/net.js` | WebSocket client (matchmaking, moves) |
| `js/game.js` | UI state machine, tap zones, animations, battles, main loop, fit-to-screen |
| `js/scene.js` | scene renderer: integer-scaled low-res canvas, meadow/dusk/night/arena backgrounds, auto-colourised sprites (flood-fill: outline art gets a body colour, filled art gets an ink outline), panels, labels |
| `js/sprites.js` | 1-bit pixel art, colour palettes per species (`T.ART`), emote tints, 3×5 font |
| `js/audio.js`, `js/debug.js` | beeps; hidden debug panel (`?debug=1`) |
| `server/server.js` | static host + WebSocket matchmaking/battles (`package.json` at the root: dependency `ws`) |
| `render.yaml`, `.node-version` | Render Blueprint (free web service) and Node version pin |
| `test_e2e.py` | Playwright tests + screenshots (starts/stops its own servers on :8765) |

## Evolution
egg → PIXBIT → MOCHI | KUCHIBO → NEKORU | SCRAPPER | BLOBBO →
KINGLEO | ROKKUN | STARLA | MIMIKO | CHUBBO | GHOULIE | OYAJI → secret DRAKON | SERAPHI.
