/* TAMA-PIX — HTTP API client. The server owns the game; the page only sends intents and shows the state it gets.
 * Api.get/post resolve to {status, data}. A network failure (server unreachable, file://) rejects with {offline:true}. */
(function (T) {
  'use strict';
  const Api = {
    base: '',
    available() { return location.protocol === 'http:' || location.protocol === 'https:'; },
    async req(method, path, body) {
      if (!this.available()) throw { offline: true, why: 'file' };
      let r;
      try {
        r = await fetch(this.base + path, {
          method, credentials: 'same-origin', cache: 'no-store',
          headers: method === 'POST' ? { 'content-type': 'application/json', 'x-tama': '1' } : {},
          body: method === 'POST' ? JSON.stringify(body || {}) : undefined
        });
      } catch (e) { throw { offline: true, why: 'network' }; }
      let data = null;
      try { data = await r.json(); } catch (e) { data = null; }
      if (data === null && r.status >= 404 && r.status !== 429) throw { offline: true, why: 'no_api', status: r.status };
      return { status: r.status, data: data || {} };
    },
    get(path) { return this.req('GET', path); },
    post(path, body) { return this.req('POST', path, body); }
  };
  T.Api = Api;
})(window.Tama);
