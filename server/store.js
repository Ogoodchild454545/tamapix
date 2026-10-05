/* TAMA-PIX storage adapters. Same async interface, two backends:
 *   - PgStore   when DATABASE_URL is set (Postgres via the 'pg' package; SSL unless the URL says sslmode=disable)
 *   - FileStore otherwise: one JSON file (DATA_FILE, default server/data/tamapix-db.json), kept in memory and written
 *     atomically. Fine for local dev/tests; on hosts with an ephemeral disk (Render free) it resets on every restart.
 * Schema migrations run automatically on start (Postgres: table schema_migrations; file: db.schema number).
 */
'use strict';
const fs = require('fs');
const path = require('path');

const MAX_EVENTS = 5000, MAX_LEDGER = 20000, MAX_BATTLES = 5000;

// ------------------------------------------------------------------ file store
const FILE_MIGRATIONS = [
  (db) => { Object.assign(db, { seq: { user: 0, battle: 0, ledger: 0, challenge: 0 }, users: {}, sessions: {}, games: {}, ledger: [], battles: [], events: [], challenges: {} }); },
];

class FileStore {
  constructor(file) { this.kind = 'file'; this.file = file; this.db = null; this.timer = null; }
  async init() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    try { this.db = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (e) { this.db = { schema: 0 }; }
    while ((this.db.schema || 0) < FILE_MIGRATIONS.length) { FILE_MIGRATIONS[this.db.schema || 0](this.db); this.db.schema = (this.db.schema || 0) + 1; }
    this.flushNow();
  }
  dirty() { if (!this.timer) this.timer = setTimeout(() => this.flushNow(), 400); }
  flushNow() {
    clearTimeout(this.timer); this.timer = null;
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.db)); fs.renameSync(tmp, this.file);
  }
  async close() { this.flushNow(); }
  pub(u) { return u ? Object.assign({}, u) : null; }
  async createUser(o) {
    const id = ++this.db.seq.user;
    const u = { id, username: o.username || null, passHash: o.passHash || null, isGuest: !!o.isGuest, birthYear: o.birthYear || null,
                adult: o.adult == null ? null : !!o.adult, friendCode: o.friendCode, imported: false, createdAt: Date.now(), lastSeen: Date.now() };
    if (u.username && Object.values(this.db.users).some(x => x.username === u.username)) throw Object.assign(new Error('taken'), { code: 'taken' });
    if (Object.values(this.db.users).some(x => x.friendCode === u.friendCode)) throw Object.assign(new Error('code'), { code: 'code' });
    this.db.users[id] = u; this.dirty(); return this.pub(u);
  }
  async getUser(id) { return this.pub(this.db.users[id]); }
  async getUserByName(name) { return this.pub(Object.values(this.db.users).find(u => u.username === name)); }
  async getUserByCode(code) { return this.pub(Object.values(this.db.users).find(u => u.friendCode === code)); }
  async updateUser(id, patch) {
    const u = this.db.users[id]; if (!u) return null;
    if (patch.username && Object.values(this.db.users).some(x => x.username === patch.username && x.id !== id)) throw Object.assign(new Error('taken'), { code: 'taken' });
    Object.assign(u, patch); this.dirty(); return this.pub(u);
  }
  async deleteUser(id) {
    delete this.db.users[id]; delete this.db.games[id];
    for (const k in this.db.sessions) if (this.db.sessions[k].userId === id) delete this.db.sessions[k];
    for (const k in this.db.challenges) { const c = this.db.challenges[k]; if (c.fromId === id || c.toId === id) delete this.db.challenges[k]; }
    this.db.ledger = this.db.ledger.filter(r => r.userId !== id);
    this.dirty();
  }
  async createSession(key, userId, expiresAt) { this.db.sessions[key] = { userId, expiresAt }; this.dirty(); }
  async getSession(key) { const s = this.db.sessions[key]; if (!s) return null; if (s.expiresAt < Date.now()) { delete this.db.sessions[key]; return null; } return Object.assign({}, s); }
  async deleteSession(key) { delete this.db.sessions[key]; this.dirty(); }
  async deleteUserSessions(userId) { for (const k in this.db.sessions) if (this.db.sessions[k].userId === userId) delete this.db.sessions[k]; this.dirty(); }
  async loadGame(userId) { const g = this.db.games[userId]; return g ? JSON.parse(JSON.stringify(g)) : null; }
  async saveGame(userId, state, coinTx) {
    this.db.games[userId] = JSON.parse(JSON.stringify(state));
    for (const t of coinTx || []) this.db.ledger.push({ id: ++this.db.seq.ledger, userId, delta: t.delta, reason: t.reason, balance: t.balance, at: Date.now() });
    if (this.db.ledger.length > MAX_LEDGER) this.db.ledger.splice(0, this.db.ledger.length - MAX_LEDGER);
    this.dirty();
  }
  async ledger(userId, limit) { return this.db.ledger.filter(r => r.userId === userId).slice(-(limit || 50)).reverse(); }
  async addBattle(b) {
    this.db.battles.push(Object.assign({ id: ++this.db.seq.battle, at: Date.now() }, b));
    if (this.db.battles.length > MAX_BATTLES) this.db.battles.splice(0, this.db.battles.length - MAX_BATTLES);
    this.dirty();
  }
  async battles(userId, limit) { return this.db.battles.filter(b => b.aUser === userId || b.bUser === userId).slice(-(limit || 20)).reverse(); }
  async addEvent(userId, type, data) {
    this.db.events.push({ userId, type, data: data || null, at: Date.now() });
    if (this.db.events.length > MAX_EVENTS) this.db.events.splice(0, this.db.events.length - MAX_EVENTS);
    this.dirty();
  }
  async createChallenge(c) {
    const id = ++this.db.seq.challenge;
    const ch = Object.assign({ id, status: 'pending', createdAt: Date.now() }, c);
    this.db.challenges[id] = ch; this.dirty(); return Object.assign({}, ch);
  }
  async getChallenge(id) { const c = this.db.challenges[id]; return c ? Object.assign({}, c) : null; }
  async updateChallenge(id, patch) { const c = this.db.challenges[id]; if (!c) return null; Object.assign(c, patch); this.dirty(); return Object.assign({}, c); }
  async listChallenges(userId, since) {
    return Object.values(this.db.challenges).filter(c => (c.toId === userId || c.fromId === userId) && c.createdAt >= since)
      .sort((a, b) => b.createdAt - a.createdAt).slice(0, 30).map(c => Object.assign({}, c));
  }
  async stats() { return { users: Object.keys(this.db.users).length, games: Object.keys(this.db.games).length }; }
}

// ------------------------------------------------------------------ Postgres store
const PG_MIGRATIONS = [
  `CREATE TABLE users (
     id BIGSERIAL PRIMARY KEY,
     username TEXT UNIQUE,
     pass_hash TEXT,
     is_guest BOOLEAN NOT NULL DEFAULT FALSE,
     birth_year INTEGER,
     adult BOOLEAN,
     friend_code TEXT NOT NULL UNIQUE,
     imported BOOLEAN NOT NULL DEFAULT FALSE,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     last_seen TIMESTAMPTZ NOT NULL DEFAULT now());
   CREATE TABLE sessions (
     key TEXT PRIMARY KEY,
     user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     expires_at TIMESTAMPTZ NOT NULL);
   CREATE INDEX sessions_user ON sessions(user_id);
   CREATE TABLE games (
     user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
     state JSONB NOT NULL,
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
   CREATE TABLE coin_ledger (
     id BIGSERIAL PRIMARY KEY,
     user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     delta INTEGER NOT NULL,
     reason TEXT NOT NULL,
     balance INTEGER NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now());
   CREATE INDEX coin_ledger_user ON coin_ledger(user_id, id);
   CREATE TABLE battles (
     id BIGSERIAL PRIMARY KEY,
     kind TEXT NOT NULL,
     a_user BIGINT, b_user BIGINT,
     a_form TEXT, b_form TEXT,
     winner SMALLINT, reason TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now());
   CREATE INDEX battles_a ON battles(a_user); CREATE INDEX battles_b ON battles(b_user);
   CREATE TABLE events (
     id BIGSERIAL PRIMARY KEY,
     user_id BIGINT,
     type TEXT NOT NULL,
     data JSONB,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now());
   CREATE TABLE challenges (
     id BIGSERIAL PRIMARY KEY,
     from_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     to_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     from_name TEXT, to_name TEXT,
     status TEXT NOT NULL DEFAULT 'pending',
     result TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now());
   CREATE INDEX challenges_to ON challenges(to_id, created_at); CREATE INDEX challenges_from ON challenges(from_id, created_at);`
];

const USER_COLS = { username: 'username', passHash: 'pass_hash', isGuest: 'is_guest', birthYear: 'birth_year', adult: 'adult',
                    friendCode: 'friend_code', imported: 'imported', lastSeen: 'last_seen' };
const toUser = (r) => r ? { id: Number(r.id), username: r.username, passHash: r.pass_hash, isGuest: r.is_guest, birthYear: r.birth_year, adult: r.adult,
  friendCode: r.friend_code, imported: r.imported, createdAt: +new Date(r.created_at), lastSeen: +new Date(r.last_seen) } : null;
const toCh = (r) => r ? { id: Number(r.id), fromId: Number(r.from_id), toId: Number(r.to_id), fromName: r.from_name, toName: r.to_name,
  status: r.status, result: r.result, createdAt: +new Date(r.created_at) } : null;

class PgStore {
  constructor(url) {
    this.kind = 'postgres';
    const { Pool } = require('pg');
    const noSsl = /sslmode=disable/.test(url) || /@(localhost|127\.0\.0\.1)[:/]/.test(url);
    this.pool = new Pool({ connectionString: url, ssl: noSsl ? false : { rejectUnauthorized: false }, max: 5 });
    this.pool.on('error', (e) => console.error('pg pool error', e.message));
  }
  q(sql, args) { return this.pool.query(sql, args); }
  async init() {
    const c = await this.pool.connect();
    try {
      await c.query('SELECT pg_advisory_lock(424242)');
      await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
      const done = new Set((await c.query('SELECT version FROM schema_migrations')).rows.map(r => r.version));
      for (let v = 1; v <= PG_MIGRATIONS.length; v++) {
        if (done.has(v)) continue;
        await c.query('BEGIN');
        try { await c.query(PG_MIGRATIONS[v - 1]); await c.query('INSERT INTO schema_migrations(version) VALUES ($1)', [v]); await c.query('COMMIT'); }
        catch (e) { await c.query('ROLLBACK'); throw e; }
        console.log('db migration', v, 'applied');
      }
    } finally { await c.query('SELECT pg_advisory_unlock(424242)').catch(() => {}); c.release(); }
  }
  async close() { await this.pool.end(); }
  async createUser(o) {
    try {
      const r = await this.q(`INSERT INTO users(username, pass_hash, is_guest, birth_year, adult, friend_code) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [o.username || null, o.passHash || null, !!o.isGuest, o.birthYear || null, o.adult == null ? null : !!o.adult, o.friendCode]);
      return toUser(r.rows[0]);
    } catch (e) {
      if (e.code === '23505') throw Object.assign(new Error('dup'), { code: /friend_code/.test(e.constraint || e.detail || '') ? 'code' : 'taken' });
      throw e;
    }
  }
  async getUser(id) { return toUser((await this.q('SELECT * FROM users WHERE id=$1', [id])).rows[0]); }
  async getUserByName(name) { return toUser((await this.q('SELECT * FROM users WHERE username=$1', [name])).rows[0]); }
  async getUserByCode(code) { return toUser((await this.q('SELECT * FROM users WHERE friend_code=$1', [code])).rows[0]); }
  async updateUser(id, patch) {
    const sets = [], args = [];
    for (const k in patch) { if (!USER_COLS[k]) continue; args.push(k === 'lastSeen' ? new Date(patch[k]) : patch[k]); sets.push(`${USER_COLS[k]}=$${args.length}`); }
    if (!sets.length) return this.getUser(id);
    args.push(id);
    try { return toUser((await this.q(`UPDATE users SET ${sets.join(',')} WHERE id=$${args.length} RETURNING *`, args)).rows[0]); }
    catch (e) { if (e.code === '23505') throw Object.assign(new Error('taken'), { code: 'taken' }); throw e; }
  }
  async deleteUser(id) { await this.q('DELETE FROM users WHERE id=$1', [id]); }
  async createSession(key, userId, expiresAt) { await this.q('INSERT INTO sessions(key, user_id, expires_at) VALUES ($1,$2,$3)', [key, userId, new Date(expiresAt)]); }
  async getSession(key) {
    const r = (await this.q('SELECT user_id, expires_at FROM sessions WHERE key=$1', [key])).rows[0];
    if (!r) return null;
    if (+new Date(r.expires_at) < Date.now()) { await this.deleteSession(key); return null; }
    return { userId: Number(r.user_id), expiresAt: +new Date(r.expires_at) };
  }
  async deleteSession(key) { await this.q('DELETE FROM sessions WHERE key=$1', [key]); }
  async deleteUserSessions(userId) { await this.q('DELETE FROM sessions WHERE user_id=$1', [userId]); }
  async loadGame(userId) { const r = (await this.q('SELECT state FROM games WHERE user_id=$1', [userId])).rows[0]; return r ? r.state : null; }
  async saveGame(userId, state, coinTx) {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`INSERT INTO games(user_id, state, updated_at) VALUES ($1,$2,now())
                     ON CONFLICT (user_id) DO UPDATE SET state=EXCLUDED.state, updated_at=now()`, [userId, JSON.stringify(state)]);
      for (const t of coinTx || []) await c.query('INSERT INTO coin_ledger(user_id, delta, reason, balance) VALUES ($1,$2,$3,$4)', [userId, t.delta, t.reason, t.balance]);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  }
  async ledger(userId, limit) {
    return (await this.q('SELECT delta, reason, balance, created_at FROM coin_ledger WHERE user_id=$1 ORDER BY id DESC LIMIT $2', [userId, limit || 50]))
      .rows.map(r => ({ delta: r.delta, reason: r.reason, balance: r.balance, at: +new Date(r.created_at) }));
  }
  async addBattle(b) {
    await this.q('INSERT INTO battles(kind, a_user, b_user, a_form, b_form, winner, reason) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [b.kind, b.aUser || null, b.bUser || null, b.aForm || null, b.bForm || null, b.winner, b.reason || null]);
  }
  async battles(userId, limit) {
    return (await this.q('SELECT * FROM battles WHERE a_user=$1 OR b_user=$1 ORDER BY id DESC LIMIT $2', [userId, limit || 20])).rows
      .map(r => ({ kind: r.kind, aUser: r.a_user && Number(r.a_user), bUser: r.b_user && Number(r.b_user), aForm: r.a_form, bForm: r.b_form, winner: r.winner, reason: r.reason, at: +new Date(r.created_at) }));
  }
  async addEvent(userId, type, data) { await this.q('INSERT INTO events(user_id, type, data) VALUES ($1,$2,$3)', [userId || null, type, data ? JSON.stringify(data) : null]); }
  async createChallenge(c) {
    return toCh((await this.q('INSERT INTO challenges(from_id, to_id, from_name, to_name) VALUES ($1,$2,$3,$4) RETURNING *', [c.fromId, c.toId, c.fromName, c.toName])).rows[0]);
  }
  async getChallenge(id) { return toCh((await this.q('SELECT * FROM challenges WHERE id=$1', [id])).rows[0]); }
  async updateChallenge(id, patch) {
    return toCh((await this.q('UPDATE challenges SET status=COALESCE($2,status), result=COALESCE($3,result) WHERE id=$1 RETURNING *', [id, patch.status || null, patch.result || null])).rows[0]);
  }
  async listChallenges(userId, since) {
    return (await this.q('SELECT * FROM challenges WHERE (to_id=$1 OR from_id=$1) AND created_at >= $2 ORDER BY created_at DESC LIMIT 30', [userId, new Date(since)])).rows.map(toCh);
  }
  async stats() {
    const r = (await this.q('SELECT (SELECT count(*) FROM users) u, (SELECT count(*) FROM games) g')).rows[0];
    return { users: Number(r.u), games: Number(r.g) };
  }
}

function createStore() {
  if (process.env.DATABASE_URL) return new PgStore(process.env.DATABASE_URL);
  return new FileStore(process.env.DATA_FILE || path.join(__dirname, 'data', 'tamapix-db.json'));
}
module.exports = { createStore, FileStore, PgStore };
