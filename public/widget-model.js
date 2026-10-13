(function (root, factory) {
  const model = factory();
  if (typeof module === 'object' && module.exports) module.exports = model;
  else root.CodexWidgetModel = model;
})(typeof window === 'undefined' ? globalThis : window, function () {
  const IDLE_HIDE_MS = 5 * 60 * 1000;

  function compareQuestionTime(a, b) {
    const time = session => [session.lastUserMessageAt, session.createdAt].find(value => Number.isFinite(value) && value > 0) ?? 0;
    // Latest user question first; replies and completion do not move a lamp.
    const difference = time(b) - time(a);
    // Equal/unknown timestamps use a deterministic tie break, including on restart.
    return difference || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  }

  function createTracker() {
    const cache = new Map();
    const observed = [];
    return {
      update(sessions, config = {}, now = Date.now()) {
        const available = new Map(sessions.map(session => [session.id, session]));
        sessions.forEach(session => cache.set(session.id, session));
        const isFresh = session => Number.isFinite(session?.lastActive) && now - session.lastActive < IDLE_HIDE_MS;
        // Expiry only removes a lamp. Keep observing its log so new activity can add it again.
        for (let i = observed.length - 1; i >= 0; i--) {
          if (!isFresh(cache.get(observed[i]))) observed.splice(i, 1);
        }
        if (config.widgetMode !== 'manual') {
          const candidates = sessions.filter(session => session.state !== 'offline' && isFresh(session));
          candidates.forEach(session => {
            if (!observed.includes(session.id)) observed.push(session.id);
          });
        }
        const pins = config.widgetPinnedSessionIds || [];
        const ids = config.widgetMode === 'manual' ? pins : [...observed, ...pins.filter(id => !observed.includes(id))];
        const hidden = new Set(config.widgetHiddenSessionIds || []);
        return ids.filter(id => !hidden.has(id) && isFresh(cache.get(id))).map(id => available.get(id) || {
          ...(cache.get(id) || { id, title: `对话 ${id.slice(0, 8)}`, project: '' }),
          state: 'unknown', detail: '暂时没有该对话的日志'
        }).sort(compareQuestionTime);
      }
    };
  }
  function getColumns(viewportWidth, scale) {
    // Native window dimensions are rounded; tolerate that fraction of a CSS pixel.
    return Math.max(1, Math.min(6, Math.floor((viewportWidth / scale - 16 + 1.5) / 136)));
  }
  return { createTracker, compareQuestionTime, getColumns, IDLE_HIDE_MS };
});
