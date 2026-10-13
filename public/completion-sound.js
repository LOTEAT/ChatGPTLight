(function (root, factory) {
  const sound = factory();
  if (typeof module === 'object' && module.exports) module.exports = sound;
  else root.CodexCompletionSound = sound;
})(typeof window === 'undefined' ? globalThis : window, function () {
  function createTracker() {
    let previous = null;
    return {
      reset() { previous = null; },
      update(sessions) {
        const completed = sessions.filter(session => session.state === 'finished' &&
          previous?.has(session.id) && previous.get(session.id) !== 'finished');
        // New lamps and the first snapshot after connecting establish a silent baseline.
        previous = new Map(sessions.map(session => [session.id, session.state]));
        return completed.map(session => session.id);
      }
    };
  }

  function createPlayer(createContext = () => new window.AudioContext()) {
    let context;
    let output;
    let generation = 0;
    const active = new Map();
    async function unlock() {
      if (!context) {
        context = createContext();
        // Mix all conversations together and tame peaks when several bells overlap.
        output = context.createDynamicsCompressor();
        output.threshold.value = -18;
        output.knee.value = 12;
        output.ratio.value = 6;
        output.attack.value = 0.003;
        output.release.value = 0.2;
        output.connect(context.destination);
      }
      if (context.state === 'suspended') await context.resume();
      return context.state === 'running';
    }

    return {
      unlock,
      stop() {
        generation++;
        if (!context) return;
        const now = context.currentTime;
        active.forEach((envelope, oscillator) => {
          envelope.gain.cancelScheduledValues(now);
          envelope.gain.setTargetAtTime(0, now, 0.015);
          oscillator.stop(now + 0.05);
        });
      },
      async play() {
        const started = generation;
        if (!await unlock() || started !== generation) return;
        const start = context.currentTime + 0.01;
        for (let ding = 0; ding < 3; ding++) {
          const time = start + ding * 0.95;
          // Let the bell linger audibly before fading out, with a relaxed three-bell rhythm.
          [[1046.5, 0.16], [2093, 0.045], [3139.5, 0.015]].forEach(([frequency, volume]) => {
            const oscillator = context.createOscillator();
            const envelope = context.createGain();
            oscillator.type = 'sine';
            oscillator.frequency.value = frequency;
            envelope.gain.setValueAtTime(0, time);
            envelope.gain.linearRampToValueAtTime(volume, time + 0.015);
            envelope.gain.exponentialRampToValueAtTime(volume * 0.45, time + 0.3);
            envelope.gain.exponentialRampToValueAtTime(0.0001, time + 1.0);
            oscillator.connect(envelope);
            envelope.connect(output);
            active.set(oscillator, envelope);
            oscillator.onended = () => { active.delete(oscillator); oscillator.disconnect(); envelope.disconnect(); };
            oscillator.start(time);
            oscillator.stop(time + 1.01);
          });
        }
      }
    };
  }

  return { createTracker, createPlayer };
});
