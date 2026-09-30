/* TAMA-PIX — tiny square-wave beeper (Web Audio). */
(function (T) {
  'use strict';
  let ctx = null;
  const Audio = {
    muted: false,
    init() {
      try { const s = JSON.parse(localStorage.getItem(T.CONFIG.SETTINGS_KEY) || '{}'); this.muted = !!s.muted; } catch (e) {}
    },
    unlock() {
      if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) { try { ctx = new AC(); } catch (e) { ctx = null; } }
    },
    setMuted(m) {
      this.muted = m;
      try { localStorage.setItem(T.CONFIG.SETTINGS_KEY, JSON.stringify({ muted: m })); } catch (e) {}
    },
    /** notes: array of [freqHz, durationMs] (freq 0 = rest) */
    play(notes) {
      if (this.muted || !ctx) return;
      let t = ctx.currentTime + 0.01;
      for (const [f, d] of notes) {
        if (f > 0) {
          const o = ctx.createOscillator(), g = ctx.createGain();
          o.type = 'square'; o.frequency.value = f;
          g.gain.setValueAtTime(0.0001, t);
          g.gain.exponentialRampToValueAtTime(0.06, t + 0.005);
          g.gain.setValueAtTime(0.06, t + d / 1000 - 0.01);
          g.gain.exponentialRampToValueAtTime(0.0001, t + d / 1000);
          o.connect(g).connect(ctx.destination);
          o.start(t); o.stop(t + d / 1000 + 0.02);
        }
        t += d / 1000;
      }
    },
    sfx(name) {
      const S = {
        click: [[2400, 35]],
        ok: [[1800, 50], [2400, 60]],
        no: [[500, 120], [0, 40], [400, 160]],
        call: [[1600, 90], [0, 60], [1600, 90], [0, 60], [1600, 90]],
        happy: [[1319, 90], [1568, 90], [2093, 160]],
        sad: [[784, 150], [659, 150], [523, 250]],
        eat: [[1200, 40], [0, 80], [1200, 40]],
        hit: [[300, 70], [200, 90]],
        shoot: [[1500, 30], [1200, 30], [900, 30]],
        block: [[2600, 40], [0, 20], [2600, 40]],
        evolve: [[523, 90], [659, 90], [784, 90], [1047, 90], [0, 60], [784, 90], [1047, 90], [1319, 250]],
        hatch: [[1047, 80], [1319, 80], [1568, 80], [2093, 200]],
        win: [[1047, 100], [1319, 100], [1568, 100], [2093, 300]],
        lose: [[600, 200], [500, 200], [400, 400]],
        death: [[523, 300], [494, 300], [440, 300], [392, 600]]
      };
      if (S[name]) this.play(S[name]);
    }
  };
  T.Audio = Audio;
})(window.Tama);
