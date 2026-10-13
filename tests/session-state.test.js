const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyEntry, snapshotSession, getUserQuestionTime, STALE_MS } = require('../session-state');

const event = (type, extra = {}) => ({ type: 'event_msg', payload: { type, ...extra } });

test('only a timestamped canonical user message sets the question time', () => {
  const timestamp = '2026-10-13T05:00:00.000Z';
  assert.equal(getUserQuestionTime({ ...event('user_message'), timestamp }), Date.parse(timestamp));
  for (const type of ['task_started', 'task_complete', 'reasoning', 'function_call', 'token_count']) {
    assert.equal(getUserQuestionTime({ ...event(type), timestamp }), null);
  }
  assert.equal(getUserQuestionTime({ type: 'response_item', timestamp, payload: { type: 'message', role: 'user' } }), null);
  assert.equal(getUserQuestionTime({ ...event('user_message'), timestamp: 'invalid' }), null);
  assert.equal(getUserQuestionTime(event('user_message')), null);
});

test('maps actual lifecycle events, including cancelled turns', () => {
  for (const [type, state] of [['task_started', 'thinking'], ['reasoning', 'thinking'],
    ['custom_tool_call', 'executing'], ['function_call_output', 'executing'],
    ['exec_approval_request', 'permission'], ['request_user_input', 'permission'],
    ['task_complete', 'finished'], ['turn_aborted', 'interrupted'], ['error', 'error']]) {
    assert.equal(classifyEntry(event(type)).state, state, type);
  }
  assert.equal(classifyEntry(event('message', { phase: 'final_answer' })).state, 'finished');
});

test('quoted status words in messages and tool outputs do not change lifecycle', () => {
  assert.equal(classifyEntry(event('user_message', { message: 'authorization_required "type":"error"' })).state, 'thinking');
  assert.equal(classifyEntry(event('function_call_output', { output: '{"status":"failed"}' })).state, 'executing');
  assert.equal(classifyEntry(event('custom_tool_call', { name: 'exec_command', arguments: '{"sandbox_permissions":"require_escalated"}' })).state, 'executing');
  assert.equal(classifyEntry({ type: 'session_meta', payload: { type: 'error' } }), null);
  assert.equal(classifyEntry(event('token_count')), null);
});

test('explicit questions are pending user actions', () => {
  assert.equal(classifyEntry(event('function_call', { name: 'functions.request_user_input_async' })).state, 'permission');
  assert.equal(classifyEntry(event('custom_tool_call', { name: 'mcp__questions__request_user_input' })).state, 'permission');
});

test('silence is unknown and never fabricated completion; new events recover', () => {
  const session = { state: 'thinking', detail: '正在思考', lastActive: 1000 };
  const stale = snapshotSession(session, 1000 + STALE_MS + 1);
  assert.equal(stale.state, 'unknown');
  assert.equal(stale.lastKnownState, 'thinking');
  assert.equal(session.state, 'thinking');
  assert.equal(snapshotSession(session, 1001).state, 'thinking');
  for (const state of ['finished', 'permission', 'interrupted', 'error']) {
    assert.equal(snapshotSession({ ...session, state }, 1000 + STALE_MS * 10).state, state);
  }
});
