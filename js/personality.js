/* TAMA-PIX — personality / mood module.
 *
 * This is the seam for a future "AI" layer. The game only ever calls:
 *     Tama.Personality.think(snapshot)  ->  { move, emote, thought, mood }
 *  - move:    'walk' | 'stay' | 'hop' | 'turn'
 *  - emote:   null | 'heart' | 'note' | 'angry' | 'zzz' | 'sweat' | 'question' | 'food' | 'skull' | 'excl'
 *  - thought: short free text (shown in the debug panel / available to UI; the LCD shows the emote)
 *  - mood:    a label, handy for logging
 *
 * To plug in a smarter brain later:
 *     Tama.Personality.setBrain(async (snapshot, fallback) => ({ move:'hop', emote:'note', thought:'Yay!' }))
 * A brain may be sync or return a Promise; if it throws or is slow, the rule-based fallback is used.
 */
(function (T) {
  'use strict';
  const U = T.util;

  const Personality = {
    brain: null,
    pending: null,      // last async decision waiting to be consumed
    log: [],            // recent thoughts (for debugging / future memory)

    setBrain(fn) { this.brain = fn; },

    /** Plain, serialisable description of the pet — what an AI layer would receive. */
    snapshot(s) {
      const f = T.FORMS[s.formId] || {};
      return {
        name: s.name, form: s.formId, formName: f.name, stage: s.stage, traits: f.traits || {},
        years: Math.floor(s.ageMs / T.CONFIG.T.DAY), hunger: s.hunger, happy: s.happy, weight: s.weight,
        discipline: s.discipline, sick: s.sick, asleep: s.asleep, lightsOff: s.lightsOff,
        poops: s.poops.length, fakeCall: s.fakeCall, careMistakes: s.careMistakes,
        battles: s.battles, wins: s.wins, training: s.training
      };
    },

    /** Simple rule-based brain. */
    rules(p) {
      const tr = p.traits, r = Math.random();
      const out = (mood, emote, move, thought) => ({ mood, emote, move, thought });
      if (p.asleep) return out('asleep', 'zzz', 'stay', 'Zzz... ' + (p.lightsOff ? 'so cosy' : 'too bright...'));
      if (p.sick) return out('sick', r < 0.5 ? 'skull' : 'sweat', 'stay', 'I feel awful...');
      if (p.hunger === 0) return out('starving', r < 0.5 ? 'food' : 'angry', 'stay', 'FOOD. NOW.');
      if (p.fakeCall) return out('bratty', 'angry', r < 0.5 ? 'turn' : 'stay', 'Hmph! Not listening!');
      if (p.poops >= 2) return out('disgusted', 'angry', 'walk', 'It stinks in here!');
      if (p.happy === 0) return out('lonely', 'sweat', 'stay', 'Nobody plays with me...');
      if (p.hunger === 1 && r < 0.6) return out('peckish', 'food', 'walk', 'Tummy rumbling...');
      if (p.happy === 1 && r < 0.5) return out('bored', 'question', 'walk', 'Wanna play?');
      if (p.hunger >= 3 && p.happy >= 3) {
        if (r < 0.18 + 0.2 * (tr.cheer || 0.5)) return out('happy', U.pick(['heart', 'note', 'note']), 'hop', U.pick(['La la la~', 'I love you!', 'Best day ever!']));
        if (r > 1 - 0.1 * (tr.temper || 0)) return out('grumpy', 'angry', 'walk', 'Grr. Just because.');
      }
      if (r < 0.25 * (tr.lazy || 0.3)) return out('lazy', null, 'stay', '...');
      return out('content', null, U.chance(0.15) ? 'turn' : 'walk', '');
    },

    think(s) {
      const snap = this.snapshot(s);
      let d = null;
      if (this.pending) { d = this.pending; this.pending = null; }
      else if (this.brain) {
        try {
          const res = this.brain(snap, this.rules.bind(this));
          if (res && typeof res.then === 'function') res.then(x => { this.pending = x; }).catch(() => {});
          else d = res;
        } catch (e) { d = null; }
      }
      d = Object.assign({ move: 'walk', emote: null, thought: '', mood: 'content' }, d || this.rules(snap));
      if (d.thought) { this.log.push(d.thought); if (this.log.length > 20) this.log.shift(); }
      return d;
    }
  };
  T.Personality = Personality;
})(window.Tama);
