/* TAMA-PIX — live connection (WebSocket, /ws). One socket per logged-in page: challenges arrive live, and battles
 * (RANDOM online, vs computer, friend code, accepted challenges) are played on it. The server builds both fighters
 * from the pets it stores and decides every outcome; the page only sends HI/LO choices.
 *
 *   Net.connect(); Net.on('challenge', fn); Net.on('challengeUpdate', fn); Net.on('incomingBattle', fn(msg, session))
 *   const session = Net.battle('find'|'cpu'|'friend'|'accept', payload, { onSearching, onMatched, onTurn, onResult, onEnd, onFail })
 *   session.move('hi'|'lo'); session.cancel(); session.leave();
 * onFail(reason, msg): 'offline' | 'nomatch' | 'rejected:<why>'.
 */
(function (T) {
  'use strict';
  const C = T.CONFIG;

  const Net = {
    ws: null, opened: false, want: false, retry: 0, listeners: {}, session: null,
    url() {
      if (location.protocol !== 'http:' && location.protocol !== 'https:') return null;
      return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
    },
    on(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
    emit(t, ...a) { (this.listeners[t] || []).forEach(fn => { try { fn(...a); } catch (e) { console.error(e); } }); },
    get connected() { return !!(this.ws && this.ws.readyState === 1 && this.opened); },
    connect() {
      this.want = true;
      const url = this.url();
      if (!url || typeof WebSocket === 'undefined' || (this.ws && this.ws.readyState <= 1)) return;
      let ws;
      try { ws = new WebSocket(url); } catch (e) { return this.later(); }
      this.ws = ws; this.opened = false;
      ws.onopen = () => {};
      ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch (err) { return; } this.handle(m); };
      ws.onclose = (e) => {
        if (this.ws !== ws) return;
        this.opened = false; this.ws = null;
        const s = this.session;
        if (s && !s.done) { if (s.matched) { s.done = true; this.session = null; s.h.onEnd && s.h.onEnd({ result: 'lost', reason: 'lost' }); } else s.fail('offline'); }
        if (e.code === 4001) { this.want = false; this.emit('auth'); return; }
        this.later();
      };
    },
    later() { if (!this.want) return; const d = Math.min(15000, 1000 * Math.pow(2, this.retry++)); clearTimeout(this.rt); this.rt = setTimeout(() => this.connect(), d); },
    disconnect() { this.want = false; clearTimeout(this.rt); if (this.ws) { const w = this.ws; this.ws = null; try { w.close(); } catch (e) {} } },
    send(o) { if (this.connected) { this.ws.send(JSON.stringify(o)); return true; } return false; },
    /** Wait up to ms for the socket to be ready. */
    ready(ms) {
      if (this.connected) return Promise.resolve(true);
      this.connect();
      return new Promise(res => { const t0 = Date.now(); const iv = setInterval(() => { if (this.connected || Date.now() - t0 > ms) { clearInterval(iv); res(this.connected); } }, 60); });
    },
    handle(m) {
      if (m.t === 'hello') { this.opened = true; this.retry = 0; this.emit('hello', m); return; }
      if (m.t === 'challenge' || m.t === 'challengeUpdate') return this.emit(m.t, m);
      let s = this.session;
      if (m.t === 'matched' && (!s || s.done)) { s = this.newSession({}); this.emit('incomingBattle', m, s); }
      if (!s || s.done) return;
      const h = s.h;
      switch (m.t) {
        case 'searching': h.onSearching && h.onSearching(); break;
        case 'nomatch': s.fail('nomatch'); break;
        case 'rejected': s.fail('rejected:' + m.reason, m.msg, m); break;
        case 'matched': s.matched = true; clearTimeout(s.timer); h.onMatched && h.onMatched(m); break;
        case 'turn': s.turn = m.n; h.onTurn && h.onTurn(m); break;
        case 'result': h.onResult && h.onResult(m); break;
        case 'end': s.done = true; this.session = null; h.onEnd && h.onEnd(m); break;
      }
    },
    newSession(h) {
      const net = this;
      const s = {
        h, done: false, matched: false, turn: 0, timer: null,
        fail(why, msg, extra) { if (s.done) return; s.done = true; clearTimeout(s.timer); if (net.session === s) net.session = null; s.h.onFail && s.h.onFail(why, msg, extra); },
        move(dir) { if (s.matched && !s.done) net.send({ t: 'move', dir, n: s.turn }); },
        cancel() { if (s.done) return; s.done = true; clearTimeout(s.timer); net.send({ t: 'cancel' }); if (net.session === s) net.session = null; },
        leave() { if (s.done) return; s.done = true; net.send({ t: 'leave' }); if (net.session === s) net.session = null; }
      };
      this.session = s;
      return s;
    },
    /** Start a battle request. kind: 'find' (RANDOM) | 'cpu' | 'friend' {code} | 'accept' {id}. */
    battle(kind, payload, h) {
      const s = this.newSession(h);
      if (kind === 'find') s.timer = setTimeout(() => { if (!s.matched) { s.cancel(); s.done = false; s.fail('nomatch'); } }, C.SEARCH_MS + 1500);
      this.ready(3500).then(ok => {
        if (s.done) return;
        if (!ok) return s.fail('offline');
        this.send(Object.assign({ t: kind }, payload || {}));
      });
      return s;
    }
  };
  T.Net = Net;
})(window.Tama);
