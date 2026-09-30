/* TAMA-PIX server: serves the static game and runs matchmaking + authoritative battles over WebSocket.
 *
 *   npm install && npm start        (from the repo root; PORT=8080 by default, HOST=0.0.0.0)
 *
 * Game rules are NOT duplicated here: the server loads the very same js/config.js, js/evolution.js
 * and js/battle.js the browser uses (inside a vm sandbox), so stats and battle maths always match.
 * Clients only send { t:'find', card, ageMs } and { t:'move', dir:'hi'|'lo' }; everything else
 * (stats, HP, hit/miss, specials, winner) is computed here.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { WebSocketServer } = require('ws');

const PORT = +process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = path.resolve(__dirname, '..');
const TURN_MS = 15000;            // auto-pick a move if a player idles this long
const SEARCH_TIMEOUT_MS = 15000;  // server-side cap on waiting in the queue
const log = (...a) => { if (!process.env.QUIET) console.log(new Date().toISOString(), ...a); };

// ------------------------------------------------------------------ shared game logic
const sandbox = { window: {}, location: { search: '' }, URLSearchParams, btoa, atob, console, Math, Date };
vm.createContext(sandbox);
for (const f of ['config.js', 'evolution.js', 'battle.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'), sandbox, { filename: f });
}
const T = sandbox.window.Tama;
const { FORMS, Battle, CONFIG } = T;
const ENTRY_AGE = { child: CONFIG.T.CHILD_AT, teen: CONFIG.T.TEEN_AT, adult: CONFIG.T.ADULT_AT, secret: CONFIG.T.SECRET_AT };

/** Plausibility checks for a pet a client wants to battle with. Returns [card, null] or [null, reason]. */
function validate(card, ageMs) {
  if (!card || typeof card !== 'object') return [null, 'no pet'];
  const f = FORMS[card.formId];
  if (!f || !Object.prototype.hasOwnProperty.call(FORMS, card.formId)) return [null, 'unknown form'];
  if (!ENTRY_AGE[f.stage]) return [null, 'too young to battle'];
  const name = String(card.name || '');
  if (!/^[A-Z0-9]{1,8}$/.test(name)) return [null, 'bad name'];
  const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
  if (!int(card.training, 0, 5000) || !int(card.battles, 0, 5000) || !int(card.wins, 0, 5000)) return [null, 'bad counters'];
  if (card.wins > card.battles) return [null, 'more wins than battles'];
  if (!int(card.weight, CONFIG.MIN_WEIGHT[f.stage] || 1, 99)) return [null, 'implausible weight'];
  if (typeof ageMs !== 'number' || !isFinite(ageMs) || ageMs < ENTRY_AGE[f.stage] || ageMs > 1e12) return [null, 'form does not match age'];
  // each play/battle takes a few seconds of game time at the very least
  if (card.training + card.battles > ageMs / 3000 + 20) return [null, 'too much training for its age'];
  if (card.formId === 'drakon' && card.battles < 10) return [null, 'implausible secret form'];
  return [{ name, formId: card.formId, training: card.training, wins: card.wins, battles: card.battles, weight: card.weight }, null];
}

// ------------------------------------------------------------------ static files
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.json': 'application/json', '.md': 'text/plain; charset=utf-8', '.ico': 'image/x-icon' };
const PUBLIC = new Set(['index.html', 'css', 'js', 'screenshots', 'README.md']);

const server = http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch (e) { res.writeHead(400); return res.end(); }
  if (p === '/') p = '/index.html';
  if (p === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok ' + queue.length + ' waiting, ' + battles.size + ' battles'); }
  const file = path.resolve(ROOT, '.' + p);
  const top = path.relative(ROOT, file).split(path.sep)[0];
  if (!file.startsWith(ROOT + path.sep) || !PUBLIC.has(top)) { res.writeHead(404); return res.end('not found'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  });
});

// ------------------------------------------------------------------ matchmaking & battles
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 2048 });
let queue = [];                // sockets waiting for an opponent
const battles = new Set();

function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function unqueue(ws) { queue = queue.filter(q => q !== ws); clearTimeout(ws.searchTimer); }

function startBattle(a, b) {
  const B = { id: Math.random().toString(36).slice(2, 8), p: [a, b], f: [Battle.fighter(a.card), Battle.fighter(b.card)],
              attacker: Math.random() < 0.5 ? 0 : 1, turn: 0, moves: [null, null], timer: null, over: false };
  a.battle = B; b.battle = B; a.side = 0; b.side = 1;
  battles.add(B);
  log('battle', B.id, a.card.name, a.card.formId, 'vs', b.card.name, b.card.formId);
  B.p.forEach((ws, i) => send(ws, { t: 'matched', id: B.id, you: Battle.view(B.f[i]), opp: Battle.view(B.f[1 - i]) }));
  nextTurn(B);
}
function nextTurn(B) {
  B.turn++; B.moves = [null, null];
  B.p.forEach((ws, i) => send(ws, { t: 'turn', n: B.turn, role: B.attacker === i ? 'atk' : 'def', ms: TURN_MS }));
  clearTimeout(B.timer);
  B.timer = setTimeout(() => {           // idle player: pick for them
    B.moves = B.moves.map(m => m || (Math.random() < 0.5 ? 'hi' : 'lo'));
    resolve(B);
  }, TURN_MS + 2500);
}
function resolve(B) {
  if (B.over || !B.moves[0] || !B.moves[1]) return;
  clearTimeout(B.timer);
  const att = B.attacker, def = 1 - att;
  const res = Battle.attack(B.f[att], B.f[def], B.moves[att], B.moves[def]);
  B.p.forEach((ws, i) => send(ws, { t: 'result', n: B.turn, attacker: i === att ? 'you' : 'opp', res,
                                     hp: { you: B.f[i].hp, opp: B.f[1 - i].hp } }));
  const loser = B.f.findIndex(f => f.hp <= 0);
  if (loser >= 0) return finish(B, 1 - loser, 'ko');
  B.attacker = def;
  nextTurn(B);
}
function finish(B, winner, reason) {
  if (B.over) return;
  B.over = true; clearTimeout(B.timer); battles.delete(B);
  B.p.forEach((ws, i) => { send(ws, { t: 'end', result: i === winner ? 'win' : 'lose', reason }); ws.battle = null; });
  log('battle', B.id, 'winner', B.p[winner].card.name, reason);
}

wss.on('connection', (ws, req) => {
  ws.alive = true; ws.msgs = 0; ws.battle = null;
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', (raw) => {
    if (++ws.msgs > 60) return ws.terminate();               // crude flood protection (per 10 s window)
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    switch (m.t) {
      case 'find': {
        if (ws.battle || queue.includes(ws)) return;
        const [card, why] = validate(m.card, m.ageMs);
        if (!card) return send(ws, { t: 'rejected', reason: why });
        ws.card = card;
        const opp = queue.find(q => q !== ws && q.readyState === 1);
        if (opp) { unqueue(opp); startBattle(opp, ws); }
        else {
          queue.push(ws); send(ws, { t: 'searching' });
          ws.searchTimer = setTimeout(() => { if (queue.includes(ws)) { unqueue(ws); send(ws, { t: 'nomatch' }); } }, SEARCH_TIMEOUT_MS);
        }
        break;
      }
      case 'cancel': unqueue(ws); break;
      case 'move': {
        const B = ws.battle;
        if (!B || B.over || (m.dir !== 'hi' && m.dir !== 'lo') || m.n !== B.turn || B.moves[ws.side]) return;
        B.moves[ws.side] = m.dir;
        resolve(B);
        break;
      }
      case 'leave': if (ws.battle) finish(ws.battle, 1 - ws.side, 'left'); break;
    }
  });
  ws.on('close', () => { unqueue(ws); if (ws.battle) finish(ws.battle, 1 - ws.side, 'left'); });
});

setInterval(() => {
  wss.clients.forEach(ws => {
    ws.msgs = 0;
    if (!ws.alive) return ws.terminate();
    ws.alive = false; ws.ping();
  });
}, 10000);

server.listen(PORT, HOST, () => log(`TAMA-PIX server on http://${HOST}:${PORT}  (WebSocket at /ws)`));

// Hosts (Render, Docker, systemd) stop the process with SIGTERM on redeploy/spin-down: close sockets cleanly.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.once(sig, () => {
    log('received', sig, '- shutting down');
    wss.clients.forEach(ws => { try { ws.close(1001, 'server restarting'); } catch (e) {} });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
module.exports = { validate, server };
