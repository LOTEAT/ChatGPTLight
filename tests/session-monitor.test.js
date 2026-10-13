const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { SessionMonitor } = require('../session-monitor');

const line = (type, payload, timestamp = Date.now()) => JSON.stringify({ type, timestamp: new Date(timestamp).toISOString(), payload }) + '\n';
const meta = id => line('session_meta', { id, title: `标题 ${id}`, cwd: '/project/中文' });
const event = (type, extra = {}, timestamp) => line('event_msg', { type, ...extra }, timestamp);

async function fixture(t, content) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'light-monitor-'));
  const directory = path.join(root, '2026', '10', '13');
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, 'rollout-one.jsonl');
  await fs.writeFile(file, content);
  const changes = [];
  const removed = [];
  const errors = [];
  const monitor = new SessionMonitor({ directory: root, pollMs: 100000,
    onSession: (file, session, entry, historical) => changes.push({ file, session, entry, historical }),
    onRemove: file => removed.push(file), onError: error => errors.push(error) });
  t.after(async () => { monitor.stop(); if (monitor.pending) await monitor.pending; await fs.rm(root, { recursive: true, force: true }); });
  await monitor.start();
  return { root, file, monitor, changes, removed, errors };
}

test('restores a question before a long output and buffers a split UTF-8 completion without replaying history', async t => {
  const questionTime = Date.now() - 60000;
  const original = meta('one') + event('user_message', { message: '问题' }, questionTime) +
    event('function_call_output', { output: '数据'.repeat(120000) });
  const { file, monitor, changes, errors } = await fixture(t, original);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].historical, true);
  assert.equal(changes[0].session.lastUserMessageAt, questionTime);
  assert.equal(changes[0].session.state, 'executing');
  assert.equal(changes[0].session.project, '中文');
  const completion = Buffer.from(event('agent_message', { phase: 'final_answer', message: '完成' }));
  const cut = completion.indexOf(Buffer.from('完成')) + 1;
  await fs.appendFile(file, completion.subarray(0, cut));
  await monitor.poll();
  assert.equal(changes.length, 1, 'partial lines must not update the lamp');
  await fs.appendFile(file, completion.subarray(cut));
  await monitor.poll();
  assert.equal(changes.length, 2);
  assert.equal(changes[1].entry.payload.message, '完成');
  assert.equal(changes[1].session.state, 'finished');
  assert.equal(changes[1].historical, false);
  await monitor.poll();
  assert.equal(changes.length, 2, 'unchanged files must not replay events');
  assert.equal(await fs.readFile(file, 'utf8'), original + completion.toString());
  assert.deepEqual(errors, []);
});

test('truncation, replacement and deletion reset cursors without retaining the previous conversation', async t => {
  const { file, monitor, changes, removed, errors } = await fixture(t, meta('one') + event('task_started') + event('reasoning', { text: 'x'.repeat(1000) }));
  await fs.writeFile(file, meta('one') + event('exec_approval_request'));
  await monitor.poll();
  assert.equal(changes.at(-1).session.state, 'permission');
  await fs.rename(file, file + '.backup');
  await fs.writeFile(file, meta('replacement') + event('turn_aborted'));
  await monitor.poll();
  assert.equal(changes.at(-1).session.id, 'replacement');
  assert.equal(changes.at(-1).session.state, 'interrupted');
  await fs.unlink(file);
  await monitor.poll(true);
  assert.deepEqual(removed, [file]);
  assert.equal(monitor.cursors.size, 0);
  assert.deepEqual(errors, []);
});

test('changing the log directory removes old sessions; stop prevents subsequent reads', async t => {
  const { root, file, monitor, changes, removed } = await fixture(t, meta('one') + event('task_started'));
  const replacementRoot = path.join(root, 'alternate');
  await fs.mkdir(replacementRoot);
  const replacementFile = path.join(replacementRoot, 'rollout-two.jsonl');
  await fs.writeFile(replacementFile, meta('two') + event('task_complete'));
  await monitor.reset(replacementRoot);
  assert.deepEqual(removed, [file]);
  assert.equal(changes.at(-1).session.id, 'two');
  monitor.stop();
  const count = changes.length;
  await fs.appendFile(replacementFile, event('task_started'));
  await monitor.poll(true);
  assert.equal(changes.length, count);
});
