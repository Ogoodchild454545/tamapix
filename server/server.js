/* TAMA-PIX server: static game + JSON API (accounts, server-side saves, actions) + WebSocket (battles, challenges).
 *
 *   npm install && npm start      (repo root; PORT=8080, HOST=0.0.0.0)
 *   env: DATABASE_URL (Postgres; otherwise a JSON file under server/data/), SESSION_SECRET, DEBUG=1 (dev only:
 *        server-side time skips; ignored when NODE_ENV=production or on Render), DATA_FILE, QUIET.
 *
 * The server is authoritative: pets, coins, energy, inventory and battle records live in the store; the browser sends
 * intents (feed, train guess, start job, buy...) and gets the resulting state back. Game rules come from the same
 * js/*.js files the browser uses (see rules.js). Battles only use the pets stored here, never client-sent stats.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const R = require('./rules');
const A = require('./auth');
const { createStore } = require('./store');

const PORT = +process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = path.resolve(__dirname, '..');
const DEBUG = process.env.DEBUG === '1' && !A.PROD;
const TURN_MS = 15000, SEARCH_TIMEOUT_MS = 15000, CHALLENGE_TTL = 24 * 3600e3;
const log = (...a) => { if (!process.env.QUIET) console.log(new Date().toISOString(), ...a); };
const { Battle, FORMS, T } = R;
const store = createStore();
if (process.env.DEBUG === '1' && !DEBUG) console.warn('DEBUG=1 ignored in production.');

// ------------------------------------------------------------------ small utils
const RL = +process.env.RATE_LIMIT_SCALE || 1;
const limitAuth = A.limiter(20 * RL, 10 * 60e3), limitGuest = A.limiter(10 * RL, 60 * 60e3), limitLoginName = A.limiter(10, 15 * 60e3);
const limitApi = A.limiter(80 * RL, 10e3), limitChallenge = A.limiter(10 * RL, 60 * 60e3);
const ipOf = (req) => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
const locks = new Map();
/** Run fn with exclusive access to one user's game (serialises concurrent requests / battle results). */
function withUser(uid, fn) {
  const prev = locks.get(uid) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  locks.set(uid, next.finally(() => { if (locks.get(uid) === next) locks.delete(uid); }));
  return next;
}
async function loadGame(user, tz) {
  let g = await store.loadGame(user.id);
  if (!g) g = R.newGame(tz, Date.now());
  return R.upgrade(g);
}
/** Load + sync + (fn) + save, under the user's lock. fn(game) may return {tx, ...}. drain = hand the queued events to this response. */
function mutate(user, present, fn, drain) {
  return withUser(user.id, async () => {
    const g = await loadGame(user);
    const tx = R.sync(g, Date.now(), present);
    const out = fn ? await fn(g) : {};
    if (out && out.tx) tx.push(...out.tx);
    const events = drain ? g.events.splice(0) : [];           // delivered with this response, so not stored again
    await store.saveGame(user.id, g, tx);
    return { g, out, events };
  });
}
function publicUser(u) { return { id: u.id, username: u.username, isGuest: u.isGuest, friendCode: u.friendCode, imported: u.imported, birthYear: u.birthYear, adult: u.adult }; }
async function challengesFor(uid) {
  const list = await store.listChallenges(uid, Date.now() - CHALLENGE_TTL * 2);
  const now = Date.now();
  const norm = (c) => Object.assign(c, { status: c.status === 'pending' && now - c.createdAt > CHALLENGE_TTL ? 'expired' : c.status });
  list.forEach(norm);
  return {
    incoming: list.filter(c => c.toId === uid && c.status === 'pending').map(c => ({ id: c.id, from: c.fromName, at: c.createdAt, online: isOnline(c.fromId) })),
    outgoing: list.filter(c => c.fromId === uid).slice(0, 5).map(c => ({ id: c.id, to: c.toName, status: c.status, result: c.result, at: c.createdAt }))
  };
}
async function stateFor(user, g, events) {
  const v = R.view(g, Date.now(), events);
  v.challenges = await challengesFor(user.id);
  v.user = publicUser(user);
  return v;
}

// ------------------------------------------------------------------ HTTP
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.json': 'application/json', '.md': 'text/plain; charset=utf-8', '.ico': 'image/x-icon' };
const PUBLIC = new Set(['index.html', 'css', 'js', 'screenshots', 'README.md']);

function json(res, code, obj, headers) {
  res.writeHead(code, Object.assign({ 'content-type': 'application/json', 'cache-control': 'no-store' }, headers || {}));
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if (n > 64 * 1024) { reject(Object.assign(new Error('too big'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { if (!n) return resolve({}); try { const o = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(o && typeof o === 'object' ? o : {}); } catch (e) { reject(Object.assign(e, { status: 400 })); } });
    req.on('error', reject);
  });
}
async function userFrom(req) {
  const tok = A.tokenFrom(req); if (!tok) return null;
  const s = await store.getSession(A.keyOf(tok)); if (!s) return null;
  return store.getUser(s.userId);
}
async function startSession(req, user) {
  const tok = A.newToken(), days = user.isGuest ? A.GUEST_DAYS : A.SESSION_DAYS;
  await store.createSession(A.keyOf(tok), user.id, Date.now() + days * 86400e3);
  return A.sessionCookie(req, tok, days);
}
async function createUserWithCode(o) {
  for (let i = 0; i < 8; i++) {
    try { return await store.createUser(Object.assign({ friendCode: A.newFriendCode() }, o)); }
    catch (e) { if (e.code !== 'code') throw e; }
  }
  throw new Error('could not allocate a friend code');
}

const routes = {
  'GET /api/config': async () => [200, { storage: store.kind, ephemeral: store.kind === 'file' && A.PROD, debug: DEBUG,
    economy: { jobs: R.E.JOBS.length, skus: R.E.SKUS.length } }],
  'GET /api/me': async (req, b, user) => [200, { user: user ? publicUser(user) : null }],
  'POST /api/signup': async (req, b) => {
    if (!limitAuth(ipOf(req))) return [429, { error: 'rate', msg: 'Too many attempts. Try again later.' }];
    const [username, bad] = A.checkCredentials(b.username, b.password); if (bad) return [200, { ok: false, error: 'invalid', msg: bad }];
    const [birthYear, badY] = A.checkBirthYear(b.birthYear); if (badY) return [200, { ok: false, error: 'invalid', msg: badY }];
    if (await store.getUserByName(username)) return [200, { ok: false, error: 'taken', msg: 'That username is taken.' }];
    let user;
    try { user = await createUserWithCode({ username, passHash: await A.hashPassword(b.password), isGuest: false, birthYear, adult: b.adult == null ? null : !!b.adult }); }
    catch (e) { if (e.code === 'taken') return [200, { ok: false, error: 'taken', msg: 'That username is taken.' }]; throw e; }
    const g = R.newGame(b.tz, Date.now()); await store.saveGame(user.id, g, []);
    store.addEvent(user.id, 'signup', null).catch(() => {});
    return [200, { ok: true, user: publicUser(user) }, { 'set-cookie': await startSession(req, user) }];
  },
  'POST /api/login': async (req, b) => {
    if (!limitAuth(ipOf(req))) return [429, { error: 'rate', msg: 'Too many attempts. Try again later.' }];
    const name = String(b.username || '').trim().toLowerCase();
    if (!limitLoginName(name)) return [429, { error: 'rate', msg: 'Too many attempts for this account. Wait 15 minutes.' }];
    const user = name && await store.getUserByName(name);
    const ok = await A.checkPassword(String(b.password || ''), user && user.passHash);
    if (!user || !ok) return [200, { ok: false, error: 'bad_login', msg: 'Wrong username or password.' }];
    await store.updateUser(user.id, { lastSeen: Date.now() });
    if (b.tz && T.util.validTz(b.tz)) await withUser(user.id, async () => { const g = await loadGame(user, b.tz); g.pet.tz = b.tz; await store.saveGame(user.id, g, []); });
    store.addEvent(user.id, 'login', null).catch(() => {});
    return [200, { ok: true, user: publicUser(user) }, { 'set-cookie': await startSession(req, user) }];
  },
  'POST /api/guest': async (req, b) => {
    if (!limitGuest(ipOf(req))) return [429, { error: 'rate', msg: 'Too many new guests from here. Try again later.' }];
    const user = await createUserWithCode({ isGuest: true });
    const g = R.newGame(b.tz, Date.now()); await store.saveGame(user.id, g, []);
    store.addEvent(user.id, 'guest', null).catch(() => {});
    return [200, { ok: true, user: publicUser(user) }, { 'set-cookie': await startSession(req, user) }];
  },
  'POST /api/upgrade': async (req, b, user) => {
    if (!user) return [401, { error: 'auth' }];
    if (!user.isGuest) return [200, { ok: false, error: 'invalid', msg: 'Already an account.' }];
    if (!limitAuth(ipOf(req))) return [429, { error: 'rate', msg: 'Too many attempts. Try again later.' }];
    const [username, bad] = A.checkCredentials(b.username, b.password); if (bad) return [200, { ok: false, error: 'invalid', msg: bad }];
    const [birthYear, badY] = A.checkBirthYear(b.birthYear); if (badY) return [200, { ok: false, error: 'invalid', msg: badY }];
    let u;
    try { u = await store.updateUser(user.id, { username, passHash: await A.hashPassword(b.password), isGuest: false, birthYear, adult: b.adult == null ? null : !!b.adult }); }
    catch (e) { if (e.code === 'taken') return [200, { ok: false, error: 'taken', msg: 'That username is taken.' }]; throw e; }
    await store.deleteUserSessions(user.id);
    return [200, { ok: true, user: publicUser(u) }, { 'set-cookie': await startSession(req, u) }];
  },
  'POST /api/logout': async (req) => {
    const tok = A.tokenFrom(req); if (tok) await store.deleteSession(A.keyOf(tok));
    return [200, { ok: true }, { 'set-cookie': A.clearCookie(req) }];
  },
  'POST /api/delete-account': async (req, b, user) => {
    if (!user) return [401, { error: 'auth' }];
    if (!user.isGuest && !(await A.checkPassword(String(b.password || ''), user.passHash))) return [200, { ok: false, error: 'bad_login', msg: 'Wrong password.' }];
    await store.deleteUser(user.id); dropSockets(user.id);
    return [200, { ok: true }, { 'set-cookie': A.clearCookie(req) }];
  },
  'GET /api/state': async (req, b, user) => {
    if (!user) return [200, { auth: false }];                  // not an error: the page shows the log-in sheet
    const { g, events } = await mutate(user, true, null, true);
    return [200, await stateFor(user, g, events)];
  },
  'POST /api/act': async (req, b, user) => {
    if (!user) return [401, { error: 'auth', msg: 'Not logged in.' }];
    if (inBattle(user.id)) return [200, { ok: false, error: 'battle', msg: 'Finish your battle first.' }];
    const { g, out, events } = await mutate(user, true, (g) => R.act(g, b, Date.now()), true);
    if (b.type === 'buy' && out.ok && b.sku === 'fizz') store.addEvent(user.id, 'drink', { left: out.drinksLeft }).catch(() => {});
    if (b.type === 'job_start' && out.ok) store.addEvent(user.id, 'job_start', { job: out.job.id }).catch(() => {});
    const res = Object.assign({}, out); delete res.tx;
    return [200, Object.assign(res, { state: await stateFor(user, g, events) })];
  },
  'POST /api/import': async (req, b, user) => {
    if (!user) return [401, { error: 'auth' }];
    const fresh = await store.getUser(user.id);
    if (fresh.imported) return [200, { ok: false, error: 'imported', msg: 'This account already imported a pet.' }];
    const { g, out, events } = await mutate(user, true, (g) => R.importSave(g, b.save, Date.now()), true);
    if (!out.ok) return [200, out];
    const u = await store.updateUser(user.id, { imported: true });
    store.addEvent(user.id, 'import', { form: out.form, notes: out.notes }).catch(() => {});
    return [200, Object.assign({}, out, { state: await stateFor(u, g, events) })];
  },
  'POST /api/import/skip': async (req, b, user) => {
    if (!user) return [401, { error: 'auth' }];
    await store.updateUser(user.id, { imported: true });
    return [200, { ok: true }];
  },
  'GET /api/ledger': async (req, b, user) => user ? [200, { ledger: await store.ledger(user.id, 50) }] : [401, { error: 'auth' }],
  'POST /api/challenge': async (req, b, user) => {
    if (!user) return [401, { error: 'auth' }];
    if (!limitChallenge(user.id)) return [429, { error: 'rate', msg: 'Too many challenges. Try later.' }];
    const raw = String(b.target || '').trim();
    const code = Battle.normCode(raw);
    const target = Battle.CODE_RE.test(code) ? await store.getUserByCode(code) : await store.getUserByName(raw.toLowerCase());
    if (!target) return [200, { ok: false, error: 'no_user', msg: 'No player with that name or code.' }];
    if (target.id === user.id) return [200, { ok: false, error: 'self', msg: "You can't challenge yourself." }];
    const mine = await challengesFor(user.id);
    if (mine.outgoing.filter(c => c.status === 'pending').length >= 5) return [429, { error: 'rate', msg: 'You have 5 open challenges already.' }];
    const g = await store.loadGame(user.id);
    if (!g || g.pet.dead || g.pet.stage === 'egg') return [200, { ok: false, error: 'egg', msg: 'Your monster must be hatched and alive.' }];
    const nameOf = (u) => u.username || ('guest ' + u.friendCode);
    const ch = await store.createChallenge({ fromId: user.id, toId: target.id, fromName: nameOf(user), toName: nameOf(target) });
    notify(target.id, { t: 'challenge', ch: { id: ch.id, from: ch.fromName, at: ch.createdAt, online: true } });
    return [200, { ok: true, id: ch.id, to: ch.toName, online: isOnline(target.id) }];
  },
  'POST /api/challenge/decline': async (req, b, user) => {
    if (!user) return [401, { error: 'auth' }];
    const ch = await store.getChallenge(+b.id);
    if (!ch || ch.toId !== user.id || ch.status !== 'pending') return [200, { ok: false, error: 'no_challenge', msg: 'That challenge is gone.' }];
    await store.updateChallenge(ch.id, { status: 'declined' });
    notify(ch.fromId, { t: 'challengeUpdate', id: ch.id, status: 'declined', to: ch.toName });
    return [200, { ok: true }];
  },
  'POST /api/debug': async (req, b, user) => {
    if (!DEBUG) return [403, { error: 'no_debug', msg: 'Debug tools are off on this server (start it with DEBUG=1).' }];
    if (!user) return [401, { error: 'auth' }];
    const { g, out, events } = await mutate(user, true, (g) => R.debugOp(g, b, Date.now()), true);
    return [200, { ok: out.ok, msg: out.msg, state: await stateFor(user, g, events) }];
  }
};

async function handleApi(req, res, p) {
  const route = routes[req.method + ' ' + p];
  if (!route) return json(res, 404, { error: 'not_found' });
  if (req.method === 'POST' && req.headers['x-tama'] !== '1') return json(res, 403, { error: 'csrf', msg: 'Missing header.' });
  try {
    const body = req.method === 'POST' ? await readBody(req) : {};
    const user = await userFrom(req);
    if (user && !limitApi(user.id)) return json(res, 429, { error: 'rate', msg: 'Slow down.' });
    const [code, obj, headers] = await route(req, body, user);
    json(res, code, obj, headers);
  } catch (e) {
    if (e.status) return json(res, e.status, { error: 'bad_request' });
    console.error('API error', p, e); json(res, 500, { error: 'server', msg: 'Server error.' });
  }
}

const server = http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch (e) { res.writeHead(400); return res.end(); }
  if (p.startsWith('/api/')) return handleApi(req, res, p);
  if (p === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok ' + store.kind + ' ' + queue.length + ' waiting, ' + battles.size + ' battles'); }
  if (p === '/') p = '/index.html';
  const file = path.resolve(ROOT, '.' + p);
  const top = path.relative(ROOT, file).split(path.sep)[0];
  if (!file.startsWith(ROOT + path.sep) || !PUBLIC.has(top)) { res.writeHead(404); return res.end('not found'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
    res.end(data);
  });
});

// ------------------------------------------------------------------ WebSocket: presence, battles, challenges
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 2048 });
const online = new Map();          // userId -> Set(ws)
let queue = [];                    // sockets waiting for a RANDOM opponent
const battles = new Set();

function send(ws, msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function notify(uid, msg) { const set = online.get(uid); if (set) set.forEach(ws => send(ws, msg)); }
function isOnline(uid) { const set = online.get(uid); return !!(set && [...set].some(ws => ws.readyState === 1)); }
function inBattle(uid) { const set = online.get(uid); return !!(set && [...set].some(ws => ws.battle && !ws.battle.over)); }
function dropSockets(uid) { const set = online.get(uid); if (set) set.forEach(ws => { try { ws.close(4001, 'account deleted'); } catch (e) {} }); }
function unqueue(ws) { queue = queue.filter(q => q !== ws); clearTimeout(ws.searchTimer); }
function idle(ws) { return ws && ws.readyState === 1 && !ws.battle && !queue.includes(ws); }

/** Check (and pay for) a battle for this user; returns {ok, mult, card, level} or a failure. */
async function prepare(uid, kind) {
  const user = await store.getUser(uid); if (!user) return { ok: false, error: 'auth', msg: 'Not logged in.' };
  const { g, out } = await mutate(user, true, (g) => {
    const r = R.battleStart(g, kind);
    return r.ok ? Object.assign(r, { card: R.card(g) }) : r;
  });
  return out;
}
/** A stored pet used as a CPU-controlled opponent (friend codes, offline challengers). */
async function ghostCard(uid) {
  const user = await store.getUser(uid); if (!user) return null;
  const { g } = await mutate(user, false);
  if (g.pet.dead || g.pet.stage === 'egg') return null;
  return R.card(g);
}

function startBattle(kind, sides, extra) {
  const B = Object.assign({ id: Math.random().toString(36).slice(2, 8), kind, sides, attacker: Math.random() < 0.5 ? 0 : 1, turn: 0, moves: [null, null], timer: null, over: false }, extra || {});
  sides.forEach((s, i) => { s.f = Battle.fighter(s.card); if (s.ws) { s.ws.battle = B; s.ws.side = i; } });
  battles.add(B);
  log('battle', B.id, kind, sides.map(s => s.card.name + '/' + s.card.formId + (s.ws ? '' : '(cpu)')).join(' vs '));
  sides.forEach((s, i) => send(s.ws, { t: 'matched', id: B.id, kind, you: Battle.view(s.f), opp: Battle.view(sides[1 - i].f), ghost: !sides[1 - i].ws }));
  setTimeout(() => nextTurn(B), 50);
  return B;
}
function nextTurn(B) {
  if (B.over) return;
  B.turn++; B.moves = [null, null];
  B.sides.forEach((s, i) => send(s.ws, { t: 'turn', n: B.turn, role: B.attacker === i ? 'atk' : 'def', ms: TURN_MS }));
  B.sides.forEach((s, i) => {                  // computer-controlled side picks at once
    if (s.ws) return;
    const other = B.sides[1 - i].f;
    B.moves[i] = B.attacker === i ? (Math.random() < 0.5 ? 'hi' : 'lo') : Battle.cpuGuess(s.f, other);
  });
  clearTimeout(B.timer);
  B.timer = setTimeout(() => { B.moves = B.moves.map(m => m || (Math.random() < 0.5 ? 'hi' : 'lo')); resolve(B); }, TURN_MS + 2500);
}
function resolve(B) {
  if (B.over || !B.moves[0] || !B.moves[1]) return;
  clearTimeout(B.timer);
  const att = B.attacker, def = 1 - att;
  const res = Battle.attack(B.sides[att].f, B.sides[def].f, B.moves[att], B.moves[def]);
  B.sides.forEach((s, i) => send(s.ws, { t: 'result', n: B.turn, attacker: i === att ? 'you' : 'opp', res, hp: { you: B.sides[i].f.hp, opp: B.sides[1 - i].f.hp } }));
  const loser = B.sides.findIndex(s => s.f.hp <= 0);
  if (loser >= 0) return finish(B, 1 - loser, 'ko');
  B.attacker = def;
  nextTurn(B);
}
async function finish(B, winner, reason) {
  if (B.over) return;
  B.over = true; clearTimeout(B.timer); battles.delete(B);
  const lvl = B.sides.map(s => Battle.level(s.card));
  await Promise.all(B.sides.map(async (s, i) => {
    if (s.ws) s.ws.battle = null;
    if (!s.uid) return;
    const result = i === winner ? 'win' : (reason === 'left' ? 'fled' : 'loss');
    let gain = null;
    try {
      const user = await store.getUser(s.uid);
      if (user) ({ out: gain } = await mutate(user, false, (g) => { const r = R.battleEnd(g, B.kind, result, lvl[1 - i], s.mult); return { tx: r.tx, gain: r.gain }; }));
    } catch (e) { console.error('battle result', e); }
    send(s.ws, { t: 'end', result: i === winner ? 'win' : 'lose', reason, gain: gain && gain.gain });
  }));
  store.addBattle({ kind: B.kind, aUser: B.sides[0].uid || null, bUser: B.sides[1].uid || null, aForm: B.sides[0].card.formId, bForm: B.sides[1].card.formId, winner, reason }).catch(() => {});
  if (B.challengeId) store.updateChallenge(B.challengeId, { status: 'done', result: B.sides[winner].card.name + ' won' }).catch(() => {});
  log('battle', B.id, 'winner', B.sides[winner].card.name, reason);
}

async function onMessage(ws, m) {
  const uid = ws.uid;
  switch (m.t) {
    case 'find': {                                   // RANDOM online (costs energy when matched)
      if (!idle(ws)) return;
      const p = await prepare(uid, 'online');
      if (!p.ok) return send(ws, { t: 'rejected', reason: p.error, msg: p.msg, refill: p.refill });
      ws.pending = p;
      const opp = queue.find(q => q !== ws && q.uid !== uid && q.readyState === 1);
      if (opp) { unqueue(opp); startBattle('online', [{ ws: opp, uid: opp.uid, card: opp.pending.card, mult: opp.pending.mult }, { ws, uid, card: p.card, mult: p.mult }]); }
      else {
        queue.push(ws); send(ws, { t: 'searching' });
        ws.searchTimer = setTimeout(() => { if (queue.includes(ws)) { unqueue(ws); refundSearch(ws); send(ws, { t: 'nomatch' }); } }, SEARCH_TIMEOUT_MS);
      }
      break;
    }
    case 'cpu': {
      if (!idle(ws)) return;
      const p = await prepare(uid, 'cpu');
      if (!p.ok) return send(ws, { t: 'rejected', reason: p.error, msg: p.msg, refill: p.refill });
      const foe = Battle.cpuCard(FORMS[p.card.formId].stage, Battle.level(p.card));
      startBattle('cpu', [{ ws, uid, card: p.card, mult: p.mult }, { ws: null, uid: null, card: foe }]);
      break;
    }
    case 'friend': {                                 // friend code: fight the friend's stored pet (computer-controlled)
      if (!idle(ws)) return;
      const code = Battle.normCode(m.code);
      if (Battle.isLegacyCode(m.code)) return send(ws, { t: 'rejected', reason: 'old_code', msg: 'Old codes no longer work. Ask your friend for their new PX- code.' });
      const target = Battle.CODE_RE.test(code) ? await store.getUserByCode(code) : null;
      if (!target) return send(ws, { t: 'rejected', reason: 'no_user', msg: 'No player with that code.' });
      if (target.id === uid) return send(ws, { t: 'rejected', reason: 'self', msg: "That's your own code." });
      const foe = await ghostCard(target.id);
      if (!foe) return send(ws, { t: 'rejected', reason: 'foe_egg', msg: "Your friend's monster can't battle right now." });
      const p = await prepare(uid, 'friend');
      if (!p.ok) return send(ws, { t: 'rejected', reason: p.error, msg: p.msg, refill: p.refill });
      startBattle('friend', [{ ws, uid, card: p.card, mult: p.mult }, { ws: null, uid: null, card: foe }]);
      break;
    }
    case 'accept': {                                 // accept a challenge: live if the challenger is online, else vs their stored pet
      if (!idle(ws)) return;
      const ch = await store.getChallenge(+m.id);
      if (!ch || ch.toId !== uid || ch.status !== 'pending' || Date.now() - ch.createdAt > CHALLENGE_TTL) return send(ws, { t: 'rejected', reason: 'no_challenge', msg: 'That challenge is gone.' });
      const p = await prepare(uid, 'friend');
      if (!p.ok) return send(ws, { t: 'rejected', reason: p.error, msg: p.msg, refill: p.refill });
      await store.updateChallenge(ch.id, { status: 'accepted' });
      const oppWs = [...(online.get(ch.fromId) || [])].find(idle);
      let q = null;
      if (oppWs) { q = await prepare(ch.fromId, 'friend'); if (!q.ok) q = null; }
      if (q) {
        notify(ch.fromId, { t: 'challengeUpdate', id: ch.id, status: 'accepted', to: ch.toName, live: true });
        startBattle('friend', [{ ws: oppWs, uid: ch.fromId, card: q.card, mult: q.mult }, { ws, uid, card: p.card, mult: p.mult }], { challengeId: ch.id });
      } else {
        const foe = await ghostCard(ch.fromId);
        if (!foe) return send(ws, { t: 'rejected', reason: 'foe_egg', msg: "The challenger's monster can't battle right now." });
        notify(ch.fromId, { t: 'challengeUpdate', id: ch.id, status: 'accepted', to: ch.toName, live: false });
        startBattle('friend', [{ ws, uid, card: p.card, mult: p.mult }, { ws: null, uid: null, card: foe }], { challengeId: ch.id });
      }
      break;
    }
    case 'cancel': if (queue.includes(ws)) { unqueue(ws); refundSearch(ws); } break;
    case 'move': {
      const B = ws.battle;
      if (!B || B.over || (m.dir !== 'hi' && m.dir !== 'lo') || m.n !== B.turn || B.moves[ws.side]) return;
      B.moves[ws.side] = m.dir;
      resolve(B);
      break;
    }
    case 'leave': if (ws.battle) finish(ws.battle, 1 - ws.side, 'left'); break;
  }
}
/** RANDOM found nobody (or was cancelled): give the energy back - the player didn't get a battle. */
function refundSearch(ws) {
  const p = ws.pending; ws.pending = null;
  if (!p || !p.ok) return;
  store.getUser(ws.uid).then(user => user && mutate(user, false, (g) => {
    g.pet.energy = Math.min(R.C.ENERGY.MAX, g.pet.energy + R.E.COST.online);
    if (g.eco.daily.actions > 0) g.eco.daily.actions--;
    return {};
  })).catch(() => {});
}

wss.on('connection', async (ws, req) => {
  ws.alive = true; ws.msgs = 0; ws.battle = null;
  ws.on('pong', () => { ws.alive = true; });
  const pendingMsgs = [];
  ws.on('message', (raw) => {
    if (++ws.msgs > 60) return ws.terminate();               // crude flood protection (per 10 s window)
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    if (!ws.uid) return pendingMsgs.push(m);
    onMessage(ws, m).catch(e => console.error('ws', e));
  });
  ws.on('close', () => {
    unqueue(ws); if (ws.pending && !ws.battle) refundSearch(ws);
    if (ws.battle) finish(ws.battle, 1 - ws.side, 'left');
    const set = online.get(ws.uid); if (set) { set.delete(ws); if (!set.size) online.delete(ws.uid); }
  });
  const user = await userFrom(req).catch(() => null);
  if (!user) { send(ws, { t: 'auth', ok: false }); return ws.close(4001, 'login required'); }
  ws.uid = user.id;
  if (!online.has(user.id)) online.set(user.id, new Set());
  online.get(user.id).add(ws);
  send(ws, { t: 'hello', user: user.username || user.friendCode });
  pendingMsgs.splice(0).forEach(m => onMessage(ws, m).catch(e => console.error('ws', e)));
});

setInterval(() => {
  wss.clients.forEach(ws => {
    ws.msgs = 0;
    if (!ws.alive) return ws.terminate();
    ws.alive = false; ws.ping();
  });
}, 10000);

store.init().then(() => {
  server.listen(PORT, HOST, () => log(`TAMA-PIX server on http://${HOST}:${PORT}  (storage: ${store.kind}${DEBUG ? ', DEBUG time tools ON' : ''})`));
}).catch(e => { console.error('storage init failed:', e.message); process.exit(1); });

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.once(sig, () => {
    log('received', sig, '- shutting down');
    wss.clients.forEach(ws => { try { ws.close(1001, 'server restarting'); } catch (e) {} });
    server.close(() => {});
    Promise.resolve(store.close()).finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
module.exports = { server, store };
