/* TAMA-PIX — hidden debug panel. Open the page with ?debug=1 (optionally &speed=20). */
(function (T) {
  'use strict';
  const C = T.CONFIG;
  const VARS = ['careMistakes', 'battles', 'wins', 'meals', 'snacks', 'weight', 'training', 'discipline', 'hunger', 'happy'];

  const Debug = {
    init() {
      const G = T.Game;
      const panel = document.createElement('div');
      panel.id = 'debug'; panel.className = 'collapsed';
      panel.innerHTML = `
        <h3 id="dbgToggle" title="click to expand/collapse">&#9881; DEBUG <small>(click to toggle)</small></h3>
        <div class="row"><label>Speed x<input id="dbgSpeed" type="number" min="0.1" step="0.5" value="${C.SPEED}"></label></div>
        <div class="row">
          <button data-d="hatch">Hatch</button>
          <button data-d="year">+1 year</button>
          <button data-d="next">Age → next stage</button>
        </div>
        <div class="row">
          <button data-d="full">Fill hearts</button>
          <button data-d="empty">Empty hearts</button>
          <button data-d="poop">+Poop</button>
          <button data-d="sick">Make sick</button>
          <button data-d="fake">Fake call</button>
        </div>
        <div class="row">
          <button data-d="night">Skip to night</button>
          <button data-d="kill">Kill</button>
          <button data-d="reset">New egg</button>
          <button data-d="gallery">Form gallery</button>
        </div>
        <fieldset><legend>Variables</legend><div id="dbgVars"></div>
          <button data-d="apply">Apply</button> <button data-d="read">Read</button></fieldset>
        <div class="row"><select id="dbgForm"></select><button data-d="setform">Set form</button><button data-d="evolve">Evolve (anim)</button></div>
        <div class="row">Next form by rules: <b id="dbgPreview">-</b></div>
        <pre id="dbgInfo"></pre>`;
      document.body.appendChild(panel);
      const vars = panel.querySelector('#dbgVars');
      VARS.forEach(k => { vars.insertAdjacentHTML('beforeend', `<label>${k}<input type="number" data-v="${k}"></label>`); });
      const sel = panel.querySelector('#dbgForm');
      Object.keys(T.FORMS).forEach(k => sel.insertAdjacentHTML('beforeend', `<option value="${k}">${k} (${T.FORMS[k].stage})</option>`));

      const read = () => VARS.forEach(k => { panel.querySelector(`[data-v="${k}"]`).value = G.state[k]; });
      read();
      panel.querySelector('#dbgSpeed').addEventListener('change', e => { C.SPEED = Math.max(0.1, parseFloat(e.target.value) || 1); });

      panel.querySelector('#dbgToggle').addEventListener('click', () => panel.classList.toggle('collapsed'));
      panel.addEventListener('click', e => {
        const d = e.target.dataset.d; if (!d) return;
        Debug.act(d, { form: sel.value, panel });
        if (d !== 'apply') read();
      });
      setInterval(() => Debug.info(panel), 500);
    },

    act(d, o) {
      const G = T.Game, s = G.state, TT = C.T, ev = [];
      switch (d) {
        case 'hatch': if (s.stage === 'egg') { s.eggMs = TT.HATCH; } break;
        case 'year': T.Pet.simulate(s, TT.DAY, ev); break;
        case 'next': {
          const at = T.Evolution.nextAgeAt(s);
          if (s.stage === 'egg') { s.eggMs = TT.HATCH; break; }
          if (at != null && s.ageMs < at) {
            s.ageMs = at - 500;
            if ((s.ageMs % TT.DAY) >= TT.DAY * TT.NIGHT_FRAC) s.ageMs = Math.ceil(s.ageMs / TT.DAY) * TT.DAY; // don't land at night
          }
          break;
        }
        case 'full': s.hunger = 4; s.happy = 4; break;
        case 'empty': s.hunger = 0; s.happy = 0; break;
        case 'poop': if (s.poops.length < 4) s.poops.push({ age: 0, counted: false }); break;
        case 'sick': T.Pet.makeSick(s); break;
        case 'fake': s.fakeCall = true; s.fakeCallMs = 0; break;
        case 'night': s.ageMs = Math.floor(s.ageMs / TT.DAY) * TT.DAY + TT.DAY * TT.NIGHT_FRAC; break;
        case 'kill': s.dead = true; s.cause = 'debug'; G.resetUI(); break;
        case 'reset': G.newEgg(); break;
        case 'apply':
          VARS.forEach(k => { const v = o.panel.querySelector(`[data-v="${k}"]`).value; if (v !== '') s[k] = Number(v); });
          break;
        case 'setform': {
          T.Pet.evolve(s, o.form);
          const entry = T.EVOLUTION.leaveAt[prevStage(s.stage)];
          if (entry && s.ageMs < entry) s.ageMs = entry;
          s.secretChecked = s.stage === 'secret'; G.resetUI(); break;
        }
        case 'evolve': { const from = s.formId; T.Pet.evolve(s, o.form); G.evolveAnim(from, o.form); break; }
        case 'gallery': Debug.gallery(); break;
      }
      G.render();
    },

    /** Set variables, fast-forward through every stage and return the resulting form history. */
    runScenario(vars, opts) {
      opts = opts || {};
      const s = T.Pet.create(), TT = C.T;
      s.eggMs = TT.HATCH; T.Pet.simulate(s, 1000);
      const stages = opts.untilSecret ? ['baby', 'child', 'teen', 'adult'] : ['baby', 'child', 'teen'];
      for (const st of stages) {
        if (s.stage !== st) break;
        Object.assign(s, vars);
        s.ageMs = T.EVOLUTION.leaveAt[st];
        T.Pet.simulate(s, 0);
        if (T.Evolution.due(s)) { const to = T.Evolution.pick(s); if (st === 'adult') s.secretChecked = true; if (to) T.Pet.evolve(s, to); }
      }
      return { form: s.formId, history: s.history.slice() };
    },

    info(panel) {
      const s = T.Game.state, p = panel.querySelector('#dbgInfo');
      panel.querySelector('#dbgPreview').textContent = (T.Evolution.pick(s) || '(none)') +
        (T.Evolution.nextAgeAt(s) != null ? ` @ ${Math.round((T.Evolution.nextAgeAt(s) - s.ageMs) / 1000 / C.SPEED)}s real` : '');
      const v = T.Evolution.vars(s);
      p.textContent = `form ${s.formId} (${s.stage})  age ${(s.ageMs / 1000).toFixed(0)}s game / ${v.years}y
hunger ${s.hunger} happy ${s.happy} weight ${s.weight} disc ${s.discipline}
poops ${s.poops.length} sick ${s.sick} asleep ${s.asleep} lightsOff ${s.lightsOff}
mistakes ${s.careMistakes} battles ${s.battles} wins ${s.wins} meals ${s.meals} snacks ${s.snacks} train ${s.training}
history ${s.history.join(' > ')}
thought: ${T.Game.ui.thought || '-'}`;
    },

    gallery() {
      let g = document.getElementById('gallery');
      if (g) { g.remove(); return; }
      g = document.createElement('div'); g.id = 'gallery';
      g.innerHTML = '<div class="gal-head">All forms <button>close</button></div><div class="gal-grid"></div>';
      document.body.appendChild(g);
      g.querySelector('button').onclick = () => g.remove();
      const grid = g.querySelector('.gal-grid');
      Object.keys(T.FORMS).forEach(k => {
        const f = T.FORMS[k], b = T.SPR[k];
        const cell = document.createElement('div'); cell.className = 'gal-cell';
        const cv = document.createElement('canvas'); cell.appendChild(cv);
        T.Scene.artCanvas(cv, k, 5);
        const st = f.stats ? `HP${f.stats.hp} P${f.stats.pow} D${f.stats.def} S${f.stats.spd}` : '';
        cell.insertAdjacentHTML('beforeend', `<b>${f.name}</b><span>${f.stage}</span><span>${st}</span><span>${f.special ? f.special.name + ' (' + f.special.type + ')' : ''}</span>`);
        grid.appendChild(cell);
      });
    }
  };
  function prevStage(st) { return { child: 'baby', teen: 'child', adult: 'teen', secret: 'adult' }[st]; }
  T.Debug = Debug;
})(window.Tama);
