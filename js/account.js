/* TAMA-PIX — accounts UI (DOM sheets): log in / sign up / guest, one-time import of an old browser save,
 * and the account sheet (upgrade a guest, log out, delete). Talks to the server through T.Api. */
(function (T) {
  'use strict';
  const Api = T.Api;
  const $ = (id) => document.getElementById(id);
  let hooks = {}, tab = 'login', cfg = {};
  const tz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; } };

  function setTab(t) {
    tab = t;
    $('tabLogin').classList.toggle('on', t === 'login'); $('tabSignup').classList.toggle('on', t === 'signup');
    $('tabLogin').setAttribute('aria-selected', String(t === 'login')); $('tabSignup').setAttribute('aria-selected', String(t === 'signup'));
    $('authForm').classList.toggle('signup', t === 'signup');
    $('authGo').textContent = t === 'login' ? 'Log in' : 'Create account';
    $('authPass').setAttribute('autocomplete', t === 'login' ? 'current-password' : 'new-password');
    $('authError').textContent = '';
  }
  function busy(on) { ['authGo', 'guestGo'].forEach(id => { $(id).disabled = on; }); }
  function fail(e) {
    if (e && e.offline) { hide(); hooks.goOffline && hooks.goOffline(e); return; }
    $('authError').textContent = 'Something went wrong. Try again.';
  }
  async function submit(ev) {
    ev.preventDefault();
    const username = $('authUser').value.trim(), password = $('authPass').value;
    const err = $('authError'); err.textContent = '';
    if (!/^[A-Za-z0-9_]{3,16}$/.test(username)) { err.textContent = 'Username: 3-16 letters, numbers or _.'; return; }
    if (password.length < 8) { err.textContent = 'Password: at least 8 characters.'; return; }
    const body = { username, password, tz: tz() };
    if (tab === 'signup') {
      const y = $('authYear').value.trim();
      if (y) { if (!/^\d{4}$/.test(y)) { err.textContent = 'Year of birth: 4 digits, or leave it empty.'; return; } body.birthYear = +y; }
      if ($('authAdult').checked) body.adult = true;
    }
    busy(true);
    try {
      const r = await Api.post(tab === 'login' ? '/api/login' : '/api/signup', body);
      if (r.status !== 200 || !r.data.ok) { err.textContent = (r.data && r.data.msg) || 'Could not ' + (tab === 'login' ? 'log in.' : 'sign up.'); return; }
      $('authPass').value = '';
      hide(); hooks.onLoggedIn && hooks.onLoggedIn(r.data.user);
    } catch (e) { fail(e); } finally { busy(false); }
  }
  async function guest() {
    busy(true); $('authError').textContent = '';
    try {
      const r = await Api.post('/api/guest', { tz: tz() });
      if (r.status !== 200 || !r.data.ok) { $('authError').textContent = (r.data && r.data.msg) || 'Could not start a guest game.'; return; }
      hide(); hooks.onLoggedIn && hooks.onLoggedIn(r.data.user);
    } catch (e) { fail(e); } finally { busy(false); }
  }
  function hide() { $('authPanel').hidden = true; }
  function drawArt() {
    const cv = $('authArt'); if (!cv || !T.Monsters) return;
    const g = cv.getContext('2d'); g.fillStyle = '#1e2636'; g.fillRect(0, 0, cv.width, cv.height);
    ['egg', 'blob'].filter(k => T.Monsters.has(k)).forEach((k, i) => {
      const a = T.Monsters.get(k, 0), s = 2, ox = i * 80 + Math.floor((80 - a.w * s) / 2), oy = 76 - a.h * s;
      for (let j = 0; j < a.px.length; j += 3) { g.fillStyle = a.px[j + 2]; g.fillRect(ox + a.px[j] * s, oy + a.px[j + 1] * s, s, s); }
    });
  }

  const Account = {
    init(h) {
      hooks = h || {};
      $('tabLogin').addEventListener('click', () => setTab('login'));
      $('tabSignup').addEventListener('click', () => setTab('signup'));
      $('authForm').addEventListener('submit', submit);
      $('guestGo').addEventListener('click', guest);
      $('accClose').addEventListener('click', () => { $('accountPanel').hidden = true; });
      $('accLogout').addEventListener('click', async () => {
        if (this.user && this.user.isGuest && !confirm('Guests cannot log back in. Log out and lose this monster?')) return;
        try { await Api.post('/api/logout', {}); } catch (e) {}
        $('accountPanel').hidden = true; hooks.onLoggedOut && hooks.onLoggedOut();
      });
      $('accDelete').addEventListener('click', async () => {
        const u = this.user; if (!u) return;
        let password = '';
        if (!u.isGuest) { password = prompt('Type your password to delete your account and monster forever:') || ''; if (!password) return; }
        else if (!confirm('Delete this guest monster forever?')) return;
        try {
          const r = await Api.post('/api/delete-account', { password });
          if (r.status !== 200 || !r.data.ok) { $('accError').textContent = (r.data && r.data.msg) || 'Could not delete.'; return; }
          $('accountPanel').hidden = true; hooks.onLoggedOut && hooks.onLoggedOut();
        } catch (e) { fail(e); }
      });
      $('upgradeForm').addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const username = $('upUser').value.trim(), password = $('upPass').value, y = $('upYear').value.trim(), err = $('accError');
        err.textContent = '';
        if (!/^[A-Za-z0-9_]{3,16}$/.test(username)) { err.textContent = 'Username: 3-16 letters, numbers or _.'; return; }
        if (password.length < 8) { err.textContent = 'Password: at least 8 characters.'; return; }
        if (y && !/^\d{4}$/.test(y)) { err.textContent = 'Year of birth: 4 digits, or leave it empty.'; return; }
        try {
          const r = await Api.post('/api/upgrade', { username, password, birthYear: y ? +y : undefined });
          if (r.status !== 200 || !r.data.ok) { err.textContent = (r.data && r.data.msg) || 'Could not save.'; return; }
          $('upPass').value = '';
          this.user = r.data.user; this.fill(r.data.user);
          err.classList.add('ok'); err.textContent = 'Saved! You can now log in as ' + r.data.user.username + ' anywhere.';
          if (T.Game) T.Game.refresh();
        } catch (e) { fail(e); }
      });
      setTab('login');
    },
    showLogin(c) {
      cfg = c || {};
      $('ephemeralNote').hidden = !cfg.ephemeral;
      drawArt();
      $('authPanel').hidden = false;
      setTimeout(() => { if (!$('authPanel').hidden && window.matchMedia('(hover: hover)').matches) $('authUser').focus(); }, 50);
    },
    fill(u) {
      $('accWho').textContent = u.isGuest ? 'Playing as a guest.' : 'Logged in as ' + u.username + '.';
      $('accCode').textContent = u.friendCode || '…';
      $('upgradeForm').hidden = !u.isGuest;
      $('accError').classList.remove('ok');
    },
    openAccount(u) {
      if (!u) return;
      this.user = u; this.fill(u); $('accError').textContent = '';
      $('accountPanel').hidden = false;
    },
    /** Offer the old browser save once. Resolves {imported, state, notes} or {imported:false}. */
    offerImport(save) {
      return new Promise((resolve) => {
        const p = $('importPanel');
        const form = (T.FORMS && T.FORMS[(T.LEGACY_FORMS && T.LEGACY_FORMS[save.formId]) || save.formId]) || null;
        $('importText').textContent = 'This device has ' + (save.name || 'a monster') + (form ? ' the ' + form.name : '') + ' from the old version of TAMA·PIX.';
        const cv = $('importArt'); const g = cv.getContext('2d'); g.fillStyle = '#1e2636'; g.fillRect(0, 0, cv.width, cv.height);
        try { if (T.Scene && form) { const key = T.Monsters.has(save.formId) ? save.formId : (T.LEGACY_FORMS && T.LEGACY_FORMS[save.formId]) || 'blob'; T.Scene.artCanvas(cv, key, 2, '#1e2636'); } } catch (e) {}
        $('importError').textContent = '';
        p.hidden = false;
        const done = (v) => { p.hidden = true; $('importGo').onclick = $('importSkip').onclick = null; resolve(v); };
        $('importGo').onclick = async () => {
          $('importGo').disabled = true;
          try {
            const r = await Api.post('/api/import', { save });
            if (r.status !== 200 || !r.data.ok) { $('importError').textContent = (r.data && r.data.msg) || 'Import failed.'; if (r.data && r.data.error === 'imported') setTimeout(() => done({ imported: false }), 1200); return; }
            done({ imported: true, state: r.data.state, notes: r.data.notes || [] });
          } catch (e) { $('importError').textContent = 'Offline. Try again.'; } finally { $('importGo').disabled = false; }
        };
        $('importSkip').onclick = async () => {
          try { await Api.post('/api/import/skip', {}); } catch (e) {}
          done({ imported: false });
        };
      });
    }
  };
  T.Account = Account;
})(window.Tama);
