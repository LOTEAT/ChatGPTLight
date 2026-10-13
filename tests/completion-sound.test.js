const test = require('node:test');
const assert = require('node:assert/strict');
const { createTracker } = require('../public/completion-sound');
const session = (id, state) => ({ id, state });

test('startup and repeated finished snapshots stay silent; each later completion alerts once', () => {
  const tracker = createTracker();
  assert.deepEqual(tracker.update([session('a', 'finished'), session('b', 'thinking')]), []);
  assert.deepEqual(tracker.update([session('a', 'finished'), session('b', 'finished')]), ['b']);
  assert.deepEqual(tracker.update([session('a', 'finished'), session('b', 'finished')]), []);
  tracker.update([session('a', 'executing'), session('b', 'finished')]);
  assert.deepEqual(tracker.update([session('a', 'finished'), session('b', 'finished')]), ['a']);
});

test('simultaneous completions return every conversation regardless of pagination', () => {
  const tracker = createTracker();
  const sessions = Array.from({ length: 8 }, (_, i) => session(String(i), 'executing'));
  tracker.update(sessions);
  assert.deepEqual(tracker.update(sessions.map(s => session(s.id, 'finished'))), sessions.map(s => s.id));
});

test('new or reselected green lamps and reconnection establish a silent baseline', () => {
  const tracker = createTracker();
  tracker.update([session('a', 'thinking')]);
  assert.deepEqual(tracker.update([session('a', 'thinking'), session('new', 'finished')]), []);
  tracker.update([]);
  assert.deepEqual(tracker.update([session('a', 'finished')]), []);
  tracker.update([session('a', 'executing')]);
  tracker.reset();
  assert.deepEqual(tracker.update([session('a', 'finished')]), []);
});

test('a completion still alerts after a running lamp becomes unknown', () => {
  const tracker = createTracker();
  tracker.update([session('a', 'executing')]);
  tracker.update([session('a', 'unknown')]);
  assert.deepEqual(tracker.update([session('a', 'finished')]), ['a']);
});
