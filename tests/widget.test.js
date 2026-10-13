const test = require('node:test');
const assert = require('node:assert/strict');
const { createTracker, getColumns, IDLE_HIDE_MS } = require('../public/widget-model');
const { getWidgetSize, getWidgetBounds } = require('../widget-layout');
const now = 2000000000;
const session = (id, state, lastActive = now, lastUserMessageAt = now) => ({ id, title: `对话 ${id}`, state, lastActive, lastUserMessageAt });

test('latest question comes first regardless of output time, input order, status and manual selection order', () => {
  const tracker = createTracker();
  const questions = [session('c', 'thinking', now, now - 1000), session('a', 'executing', now - 100, now - 3000), session('b', 'finished', now - 200, now - 2000)];
  assert.deepEqual(tracker.update(questions, {}, now).map(s => s.id), ['c', 'b', 'a']);
  questions[1] = session('a', 'finished', now + 1000, now - 3000);
  assert.deepEqual(tracker.update(questions.reverse(), {}, now + 1000).map(s => s.id), ['c', 'b', 'a']);
  assert.deepEqual(tracker.update(questions, { widgetMode: 'manual', widgetPinnedSessionIds: ['a', 'b', 'c'] }, now + 1000).map(s => s.id), ['c', 'b', 'a']);
  const next = questions.map(s => s.id === 'a' ? session('a', 'thinking', now + 2000, now + 2000) : s);
  assert.deepEqual(tracker.update(next, {}, now + 2000).map(s => s.id), ['a', 'c', 'b']);
  assert.deepEqual(createTracker().update(next.reverse(), {}, now + 2000).map(s => s.id), ['a', 'c', 'b'], 'restart must restore the same chronology');
});

test('equal or unavailable question timestamps use a fixed tie break and creation fallback', () => {
  const records = [session('b', 'thinking'), session('a', 'thinking'), { ...session('old', 'thinking'), lastUserMessageAt: null, createdAt: now - 1000 }, { ...session('unknown', 'thinking'), lastUserMessageAt: null }];
  assert.deepEqual(createTracker().update(records, {}, now).map(s => s.id), ['a', 'b', 'old', 'unknown']);
  assert.deepEqual(createTracker().update(records.reverse(), {}, now).map(s => s.id), ['a', 'b', 'old', 'unknown']);
});

test('independent lights keep their slots when one conversation completes', () => {
  const tracker = createTracker();
  const first = tracker.update([session('a', 'thinking'), session('b', 'executing')], {}, now);
  const second = tracker.update([session('b', 'finished'), session('a', 'executing')], {}, now);
  assert.deepEqual(first.map(s => s.id), ['a', 'b']);
  assert.deepEqual(second.map(s => [s.id, s.state]), [['a', 'executing'], ['b', 'finished']]);
  assert.equal(tracker.update([session('a', 'finished')], {}, now)[1].state, 'unknown');
});

test('automatic lights exclude old history and keep completion until idle expiry', () => {
  const tracker = createTracker();
  const values = tracker.update([session('old', 'finished', 0), session('recent', 'finished'), session('live', 'thinking')], {}, now);
  assert.deepEqual(values.map(s => s.id).sort(), ['live', 'recent']);
  assert.ok(tracker.update([session('live', 'finished'), session('recent', 'finished')], {}, now + IDLE_HIDE_MS - 1).some(s => s.id === 'live'));
  assert.equal(tracker.update([session('live', 'finished'), session('recent', 'finished')], {}, now + IDLE_HIDE_MS).length, 0);
});

test('manual pins, hidden conversations and unavailable pins are distinct', () => {
  const tracker = createTracker();
  const sessions = [session('a', 'thinking'), session('b', 'finished')];
  assert.deepEqual(tracker.update(sessions, { widgetHiddenSessionIds: ['a'] }, now).map(s => s.id), ['b']);
  const selected = tracker.update(sessions, { widgetMode: 'manual', widgetPinnedSessionIds: ['b', 'gone'] }, now);
  assert.deepEqual(selected.map(s => [s.id, s.state]), [['b', 'finished']]);
});

test('five minutes is per conversation; new events renew expiry and expired IDs return', () => {
  const tracker = createTracker();
  const older = session('a', 'thinking', now, now - 1000);
  tracker.update([older, session('b', 'executing')], {}, now);
  const later = now + IDLE_HIDE_MS;
  assert.deepEqual(tracker.update([session('a', 'unknown'), session('b', 'executing', later)], {}, later).map(s => s.id), ['b']);
  assert.deepEqual(tracker.update([{ ...older, lastActive: later + 1 }, session('b', 'executing', later)], {}, later + 1).map(s => s.id), ['b', 'a'], 'output-only activity restores the original question position');
  assert.deepEqual(tracker.update([session('a', 'thinking', later + 1, later + 1), session('b', 'executing', later)], {}, later + 1).map(s => s.id), ['a', 'b'], 'a new question moves the conversation first');
  assert.equal(tracker.update([session('a', 'finished', later + 1), session('b', 'finished', later)], {}, later + IDLE_HIDE_MS + 1).length, 0);
});

test('all status types and manual selections follow idle expiry without forgetting selection', () => {
  for (const state of ['thinking', 'executing', 'permission', 'finished', 'interrupted', 'error', 'unknown']) {
    const tracker = createTracker();
    const config = { widgetMode: 'manual', widgetPinnedSessionIds: ['a'] };
    assert.equal(tracker.update([session('a', state)], config, now).length, 1);
    assert.equal(tracker.update([session('a', state)], config, now + IDLE_HIDE_MS).length, 0);
    assert.deepEqual(config.widgetPinnedSessionIds, ['a']);
    assert.equal(tracker.update([session('a', 'thinking', now + IDLE_HIDE_MS + 1)], config, now + IDLE_HIDE_MS + 1).length, 1);
  }
});

test('a disappeared log only retains its cached lamp until the same idle deadline', () => {
  const tracker = createTracker();
  tracker.update([session('a', 'executing')], {}, now);
  assert.equal(tracker.update([], {}, now + 1000)[0].state, 'unknown');
  assert.equal(tracker.update([], {}, now + IDLE_HIDE_MS).length, 0);
});

test('horizontal layout stays inside offset displays at every supported scale', () => {
  const workArea = { x: -1280, y: 30, width: 1280, height: 770 };
  for (const scale of [.4, 1, 2]) {
    const size = getWidgetSize(20, scale, workArea);
    const bounds = getWidgetBounds(size, workArea, { x: -100, y: 740, width: 140 });
    assert.ok(size.columns >= 1 && size.columns <= 6);
    assert.ok(bounds.x >= workArea.x && bounds.x + bounds.width <= workArea.x + workArea.width);
    assert.ok(bounds.y >= workArea.y && bounds.y + bounds.height <= workArea.y + workArea.height);
    assert.ok(size.width > size.height);
  }
});

test('fractional zoom preserves the same number of native and rendered columns', () => {
  const workArea = { x: 0, y: 0, width: 1280, height: 800 };
  for (let value = 4; value <= 20; value++) {
    const scale = value / 10;
    for (const count of [0, 1, 2, 3, 4, 5, 6, 20]) {
      const size = getWidgetSize(count, scale, workArea);
      assert.equal(getColumns(size.width, scale), size.columns, `${count} conversations at ${scale}x`);
    }
  }
});
