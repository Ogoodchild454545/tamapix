/* TAMA-PIX — hidden debug panel. Open the page with ?debug=1. The pet lives on the server, so every tool here is a
 * server op (POST /api/debug) that only works when the server was started with DEBUG=1 (never in production).
 * Time jumps, need/sickness toggles, energy/coins, stage counters, forcing any evolution branch (with a preview
 * of the target and which branch the current counters would pick), and a gallery of the whole evolution tree.
 */
(function (T) {
  'use strict';
  const C = T.CONFIG;
  const STAGE_VARS = T.Evolution.STAGE_KEYS;             // per-stage counters (s.st.*)
  const PET_VARS = ['discipline', 'weight', 'hunger', 'happy', 'xp'];

  const Debug = {
    init() {
      const G = T.Game;
      const panel = document.createElement('div');
      panel.id = 'debug'; panel.className = 'collapsed';
      panel.innerHTML = `
        <h3 id="dbgToggle" title="click to expand/collapse">&#9881; DEBUG <small>(click to toggle)</small></h3>
        <div class="row"><small id="dbgNote">Time tools run on the server and only work when it was started with DEBUG=1.</small></div>
        <div class="row"><label>Server speed x<input id="dbgSpeed" type="number" min="1" step="1" value="1"></label>
          <small>(1 = real time)</small></div>
        <div class="row">
          <button data-d="hatch">Hatch</button>
          <button data-d="hour">+1 hour</button>
          <button data-d="day">+1 day</button>
          <button data-d="next">Age &rarr; next evolution</button>
        </div>
        <div class="row">
          <button data-d="full">Fill hearts</button>
          <button data-d="empty">Empty hearts</button>
          <button data-d="poop">+Poop</button>
          <button data-d="sick">Make sick</button>
          <button data-d="fake">Fake call</button>
          <button data-d="xp">+100 XP</button>
        </div>
        <div class="row">
          <button data-d="e0">Energy 0</button>
          <button data-d="efull">Energy full</button>
          <button data-d="coins">+500 coins</button>
          <button data-d="finish">Finish job</button>
          <button data-d="newday">New day</button>
        </div>
        <div class="row">
          <button data-d="kill">Kill</button>
          <button data-d="reset">New egg</button>
          <button data-d="gallery">Evolution tree</button>
        </div>
        <fieldset><legend>This stage (reset at each evolution)</legend><div id="dbgStage"></div></fieldset>
        <fieldset><legend>Pet</legend><div id="dbgVars"></div>
          <button data-d="apply">Apply</button> <button data-d="read">Read</button></fieldset>
        <fieldset><legend>Evolution branches of the current form</legend>
          <div id="dbgBranches"></div>
          <div class="row"><select id="dbgBranch"></select>
            <button data-d="force">Force this branch</button></div>
          <div class="row"><canvas id="dbgPrev" width="40" height="40"></canvas><span id="dbgPrevTxt"></span></div>
          <div class="row"><select id="dbgForm"></select><button data-d="setform">Set any form</button></div>
        </fieldset>
        <pre id="dbgInfo"></pre>`;
      document.body.appendChild(panel);
      const add = (box, keys, attr) => keys.forEach(k => box.insertAdjacentHTML('beforeend', `<label>${k}<input type="number" ${attr}="${k}"></label>`));
      add(panel.querySelector('#dbgStage'), STAGE_VARS, 'data-st');
      add(panel.querySelector('#dbgVars'), PET_VARS, 'data-v');
      const sel = panel.querySelector('#dbgForm');
      Object.keys(T.FORMS).forEach(k => sel.insertAdjacentHTML('beforeend', `<option value="${k}">${T.FORMS[k].name} (${k}, ${T.FORMS[k].stage})</option>`));
      const bsel = panel.querySelector('#dbgBranch');
      bsel.addEventListener('change', () => Debug.previewTarget(panel));
      const read = () => {
        const s = G.state; if (!s) return;
        STAGE_VARS.forEach(k => { panel.querySelector(`[data-st="${k}"]`).value = (s.st && s.st[k]) || 0; });
        PET_VARS.forEach(k => { panel.querySelector(`[data-v="${k}"]`).value = Math.floor(s[k] || 0); });
      };
      Debug.read = read;
      panel.querySelector('#dbgSpeed').addEventListener('change', e => Debug.op({ op: 'speed', speed: Math.max(1, parseFloat(e.target.value) || 1) }));
      panel.querySelector('#dbgToggle').addEventListener('click', () => { panel.classList.toggle('collapsed'); read(); });
      panel.addEventListener('click', e => {
        const d = e.target.dataset.d; if (!d) return;
        Debug.act(d, { form: sel.value, branch: bsel.value, panel });
      });
      Debug.info(panel);
      setInterval(() => Debug.info(panel), 500);
    },

    /** Send a debug op to the server (403 unless the server runs with DEBUG=1). */
    async op(body) {
      const note = document.getElementById('dbgNote');
      try {
        const r = await T.Api.post('/api/debug', body);
        if (r.status !== 200) { if (note) note.textContent = (r.data && r.data.msg) || 'Debug op refused (' + r.status + ').'; return false; }
        if (note) note.textContent = 'ok: ' + body.op;
        if (r.data.state) T.Game.applyView(r.data.state);
        if (Debug.read) Debug.read();
        return true;
      } catch (e) { if (note) note.textContent = 'Server unreachable.'; return false; }
    },

    act(d, o) {
      const TT = C.T, s = T.Game.state || {};
      const P = (pet, eco) => Debug.op({ op: 'patch', pet, eco });
      switch (d) {
        case 'hatch': return Debug.op({ op: 'hatch' });
        case 'hour': return Debug.op({ op: 'skip', ms: TT.HOUR });
        case 'day': return Debug.op({ op: 'skip', ms: TT.DAY });
        case 'next': return Debug.op({ op: 'next' });
        case 'full': return P({ hunger: 4, happy: 4 });
        case 'empty': return P({ hunger: 0, happy: 0 });
        case 'poop': return Debug.op({ op: 'poop' });
        case 'sick': return Debug.op({ op: 'sick' });
        case 'fake': return Debug.op({ op: 'fake' });
        case 'xp': return P({ xp: (s.xp | 0) + 100 });
        case 'e0': return P({ energy: 0 });
        case 'efull': return P({ energy: C.ENERGY.MAX, asleep: false, napping: false });
        case 'coins': return P(null, { coins: ((T.Game.eco && T.Game.eco.coins) || 0) + 500 });
        case 'finish': return Debug.op({ op: 'finish_job' });
        case 'newday': return Debug.op({ op: 'new_day' });
        case 'kill': return Debug.op({ op: 'kill' });
        case 'reset': return Debug.op({ op: 'reset' });
        case 'read': return Debug.read && Debug.read();
        case 'apply': {
          const st = {}, pet = {};
          STAGE_VARS.forEach(k => { const v = o.panel.querySelector(`[data-st="${k}"]`).value; if (v !== '') st[k] = Number(v); });
          PET_VARS.forEach(k => { const v = o.panel.querySelector(`[data-v="${k}"]`).value; if (v !== '') pet[k] = Number(v); });
          pet.st = st;
          return P(pet);
        }
        case 'force': if (o.branch) return Debug.force(o.branch, true); break;
        case 'setform': return Debug.force(o.form, false);
        case 'gallery': Debug.gallery(); break;
      }
    },

    /** Turn the pet into `to` now (on the server). anim = play the evolution animation. */
    force(to, anim) { T.Game.resetUI(); return Debug.op({ op: 'force', form: to, anim: !!anim }); },

    /** Test helper: hatch, set the baby-stage counters, evolve at day 2, set day 2-5 counters, evolve at day 5.
     *  pet = extra fields on the pet (discipline, weight...) applied before each evolution. Returns the history. */
    runScenario(baby, teen, pet) {
      const s = T.Pet.create(), TT = C.T;
      s.eggMs = TT.HATCH; T.Pet.simulate(s, 1000);
      const evolveWith = (counters, extra) => {
        const c = Object.assign({}, counters || {}); delete c.pet;
        Object.assign(s.st, c); Object.assign(s, pet || {}, extra || {});
        ['battles', 'wins', 'training', 'careMistakes', 'poopMistakes', 'meals', 'snacks'].forEach(k => { s[k] += c[k] || 0; });
        s.ageMs = T.Evolution.nextAgeAt(s);
        const to = T.Evolution.pick(s); if (to) T.Pet.evolve(s, to);
      };
      evolveWith(baby, baby && baby.pet);
      if (teen) evolveWith(teen, teen.pet);
      return { form: s.formId, history: s.history.slice() };
    },

    previewTarget(panel) {
      const k = panel.querySelector('#dbgBranch').value, cv = panel.querySelector('#dbgPrev'), txt = panel.querySelector('#dbgPrevTxt');
      if (!k) { txt.textContent = ''; cv.getContext('2d').clearRect(0, 0, cv.width, cv.height); return; }
      T.Scene.artCanvas(cv, k, 2);
      const f = T.FORMS[k];
      txt.textContent = `${f.name}: ${f.desc}`;
    },

    info(panel) {
      const s = T.Game.state, p = panel.querySelector('#dbgInfo');
      if (!s || !s.st) return;
      // branch list for the current form with the current verdicts
      const pv = T.Evolution.preview(s), bsel = panel.querySelector('#dbgBranch');
      const key = s.formId + ':' + pv.map(b => b.to).join(',');
      if (bsel.dataset.key !== key) {
        bsel.dataset.key = key; bsel.innerHTML = pv.map(b => `<option value="${b.to}">${T.FORMS[b.to].name}</option>`).join('');
        Debug.previewTarget(panel);
      }
      panel.querySelector('#dbgBranches').innerHTML = pv.length ? pv.map(b =>
        `<div class="${b.chosen ? 'chosen' : b.ok ? 'ok' : 'no'}">${b.chosen ? '&#9733;' : b.ok ? '&#10003;' : '&middot;'} ${T.FORMS[b.to].name} <small>${b.desc}</small></div>`).join('')
        : '<div class="no">final form - no more evolutions</div>';
      const left = T.Pet.evolvesIn(s), v = T.Evolution.vars(s);
      p.textContent = `form ${T.FORMS[s.formId].name} (${s.formId}, ${s.stage})  age ${(s.ageMs / C.T.HOUR).toFixed(2)} h
next evolution ${left == null ? '-' : (left / C.T.HOUR).toFixed(2) + ' h'}
energy ${Math.floor(s.energy)}  asleep ${s.asleep}  napping ${s.napping}  lightsOff ${s.lightsOff}  job ${s.job ? s.job.id : '-'}
coins ${T.Game.eco ? T.Game.eco.coins : '-'}  actions today ${T.Game.eco ? T.Game.eco.daily.actions : '-'}
Lv ${T.Pet.level(s)} (xp ${s.xp})  hunger ${s.hunger} happy ${s.happy} weight ${s.weight} disc ${s.discipline}
poops ${s.poops.length} sick ${s.sick}  mistakes ${s.careMistakes} (poop ${s.poopMistakes})
life: battles ${s.battles} wins ${s.wins} training ${s.training}
stage winRate ${(v.winRate * 100).toFixed(0)}%  overweight ${v.overweight}
history ${s.history.join(' > ')}
thought: ${T.Game.ui.thought || '-'}`;
    },

    /** Full evolution tree: EGG -> BLOB -> day-2 forms -> finals, with the conditions of every branch. */
    gallery() {
      let g = document.getElementById('gallery');
      if (g) { g.remove(); return; }
      g = document.createElement('div'); g.id = 'gallery';
      const F = T.FORMS, E = T.EVOLUTION;
      const cell = (k, cond) => {
        const f = F[k], st = f.stats ? `HP${f.stats.hp} P${f.stats.pow} D${f.stats.def} S${f.stats.spd}` : '';
        return `<div class="gal-cell${f.secret ? ' secret' : ''}" data-form="${k}"><canvas data-k="${k}"></canvas><b>${f.name}</b>` +
          (cond ? `<em>${cond}</em>` : '') + `<span>${f.desc}</span>` + (st ? `<span>${st}${f.special ? ' &middot; ' + f.special.name : ''}</span>` : '') + '</div>';
      };
      let html = `<div class="gal-head"><span>EVOLUTION TREE <small>hatch 1 min &middot; 1st evolution day 2 &middot; final day 5</small></span><button>close</button></div>`;
      html += `<div class="tree-root">${cell('egg')}<i>&rarr;</i>${cell('blob', 'every pet hatches as this after 1 minute')}</div>`;
      html += `<h4>Day 2: BLOB becomes (first match wins, counters from days 0-2)</h4><div class="tree">`;
      E.tree.blob.forEach(b => {
        const finals = (E.tree[b.to] || []);
        html += `<div class="tree-line">${cell(b.to, 'day 2: ' + b.desc)}<i>&rarr;</i><div class="finals">${finals.map(r => cell(r.to, 'day 5: ' + r.desc)).join('')}</div></div>`;
      });
      html += `</div><h4>Secret (checked first at day 5, any day-2 form)</h4><div class="tree-line">${E.secret.map(r => cell(r.to, r.desc)).join('')}</div>`;
      g.innerHTML = html;
      document.body.appendChild(g);
      g.querySelector('button').onclick = () => g.remove();
      g.querySelectorAll('canvas[data-k]').forEach(cv => T.Scene.artCanvas(cv, cv.dataset.k, 3));
    }
  };
  T.Debug = Debug;
})(window.Tama);
