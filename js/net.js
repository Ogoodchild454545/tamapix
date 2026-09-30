/* TAMA-PIX — online client (WebSocket). Only move choices are sent; the server decides outcomes.
 *
 *   const session = Tama.Net.findMatch({ card, ageMs }, {
 *     onSearching, onMatched(msg), onTurn(msg), onResult(msg), onEnd(msg), onFail(reason)
 *   });
 *   session.move('hi'|'lo');  session.cancel();  session.leave();
 *
 * onFail(reason): 'offline' (no server / file://), 'nomatch' (nobody found in time), 'rejected:<why>',
 * 'lost' (connection dropped mid-battle).
 */
(function (T) {
  'use strict';
  const C = T.CONFIG;

  const Net = {
    url() {
      if (C.SERVER_URL) return C.SERVER_URL;
      if (location.protocol !== 'http:' && location.protocol !== 'https:') return null;
      return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
    },

    findMatch(payload, h) {
      const url = this.url();
      let ws = null, done = false, matched = false, turn = 0, timer = null;
      const fail = (why) => { if (done) return; done = true; clearTimeout(timer); try { ws && ws.close(); } catch (e) {} h.onFail && h.onFail(why); };
      const session = {
        get matched() { return matched; },
        move(dir) { if (ws && ws.readyState === 1 && matched) ws.send(JSON.stringify({ t: 'move', dir, n: turn })); },
        cancel() { if (done) return; done = true; clearTimeout(timer); try { ws.send(JSON.stringify({ t: 'cancel' })); ws.close(); } catch (e) {} },
        leave() { if (done) return; done = true; try { ws.send(JSON.stringify({ t: 'leave' })); setTimeout(() => ws.close(), 200); } catch (e) {} }
      };
      if (!url || typeof WebSocket === 'undefined') { setTimeout(() => fail('offline'), 1200); return session; }

      timer = setTimeout(() => { if (!matched) { session.cancel(); done = false; fail('nomatch'); } }, C.SEARCH_MS);
      try { ws = new WebSocket(url); } catch (e) { setTimeout(() => fail('offline'), 800); return session; }
      let opened = false;
      ws.onopen = () => { opened = true; ws.send(JSON.stringify({ t: 'find', card: payload.card, ageMs: payload.ageMs })); };
      ws.onerror = () => { if (!opened) fail('offline'); };
      ws.onclose = () => {
        if (done) return;
        if (!opened) fail('offline'); else if (matched) { done = true; h.onEnd && h.onEnd({ result: 'lost', reason: 'lost' }); } else fail('offline');
      };
      ws.onmessage = (e) => {
        let m; try { m = JSON.parse(e.data); } catch (err) { return; }
        switch (m.t) {
          case 'searching': h.onSearching && h.onSearching(); break;
          case 'nomatch': fail('nomatch'); break;
          case 'rejected': fail('rejected:' + m.reason); break;
          case 'matched': matched = true; clearTimeout(timer); h.onMatched && h.onMatched(m); break;
          case 'turn': turn = m.n; h.onTurn && h.onTurn(m); break;
          case 'result': h.onResult && h.onResult(m); break;
          case 'end': done = true; h.onEnd && h.onEnd(m); try { ws.close(); } catch (err) {} break;
        }
      };
      return session;
    }
  };
  T.Net = Net;
})(window.Tama);
