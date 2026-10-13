const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const WebSocket = require('ws');

test('reads independent conversations, titles and live terminal events without changing source files', { timeout: 25000 }, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-light-test-'));
  const dir = path.join(home, '.codex', 'sessions', '2026', '10', '13');
  fs.mkdirSync(dir, { recursive: true });
  const fakeApp = path.join(home, 'ChatGPT.app');
  fs.mkdirSync(path.join(fakeApp, 'Contents', 'MacOS'), { recursive: true });
  fs.writeFileSync(path.join(fakeApp, 'Contents', 'MacOS', 'ChatGPT'), '');
  fs.writeFileSync(path.join(home, '.traffic-light-service-config.json'), JSON.stringify({ codexAppPath: fakeApp }));
  const entry = (type, extra = {}) => JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type, ...extra } }) + '\n';
  const files = {};
  const questionTimes = { old: Date.now() - 90000, one: Date.now() - 60000, two: Date.now() - 30000, child: Date.now() - 15000 };
  for (const [id, type] of [['one', 'task_started'], ['two', 'task_complete'], ['old', 'task_started'], ['child', 'task_started']]) {
    files[id] = path.join(dir, `rollout-${id}.jsonl`);
    const question = JSON.stringify({ type: 'event_msg', timestamp: new Date(questionTimes[id]).toISOString(), payload: { type: 'user_message', message: '问题' } }) + '\n';
    // Recover question time even after output exceeds the 512 KiB status tail,
    // including a UTF-8 line spanning multiple backward-read chunks.
    const longOutput = id === 'one' ? JSON.stringify({ type: 'response_item', timestamp: new Date().toISOString(), payload: { type: 'function_call_output', output: '界面'.repeat(120000) } }) + '\n' : '';
    fs.writeFileSync(files[id], JSON.stringify({ type: 'session_meta', payload: { id, cwd: '/projects/demo', source: id === 'child' ? { subagent: 'test' } : 'vscode' } }) + '\n' + question + longOutput + entry(type));
  }
  const oldTime = new Date(Date.now() - 180000);
  fs.utimesSync(files.old, oldTime, oldTime);
  const oldContent = fs.readFileSync(files.old, 'utf8');
  // A reopened conversation can have a recent mtime in an old creation-date directory.
  const ancientDir = path.join(home, '.codex', 'sessions', '1900', '01', '01');
  fs.mkdirSync(ancientDir, { recursive: true });
  fs.mkdirSync(path.join(home, '.codex', 'sessions', '2025'), { recursive: true });
  fs.writeFileSync(path.join(ancientDir, 'rollout-ancient.jsonl'), JSON.stringify({ type: 'session_meta', payload: { id: 'ancient' } }) + '\n' + entry('task_complete'));
  const db = path.join(home, '.codex', 'state_5.sqlite');
  execFileSync('/usr/bin/sqlite3', [db, 'CREATE TABLE threads (rollout_path TEXT, title TEXT, cwd TEXT, archived INTEGER, updated_at INTEGER);']);
  // The old schema intentionally has no "name" column.
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  execFileSync('/usr/bin/sqlite3', [db, `INSERT INTO threads VALUES (${quote(files.one)}, '<script>标题</script>', '/projects/demo', 0, 1)`]);
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, CODEX_LIGHT_CONFIG_FILE: path.join(home, '.traffic-light-service-config.json'), CODEX_LIGHT_DATA_DIR: path.join(home, '.codex'), CODEX_LIGHT_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    fs.rmSync(home, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${port}`;
  async function until(predicate) {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      try { const data = await (await fetch(`${url}/api/status`)).json(); if (predicate(data)) return data; } catch (_) {}
      if (child.exitCode !== null) assert.fail(output);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.fail(`Timed out: ${output.slice(-1200)}`);
  }
  let data = await until(data => data.codex.sessions.find(s => s.id === 'one')?.title === '<script>标题</script>');
  assert.equal((await (await fetch(`${url}/api/config`)).json()).quotaDisplay, 'widget', 'quota should be visible by default');
  assert.equal((await (await fetch(`${url}/api/config`)).json()).completionSoundEnabled, true);
  await fetch(`${url}/api/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ completionSoundEnabled: false }) });
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.traffic-light-service-config.json'), 'utf8')).completionSoundEnabled, false);
  assert.equal(data.codex.sessions.length, 4);
  assert.ok(data.codex.sessions.some(s => s.id === 'ancient'));
  assert.equal(data.codex.sessions.find(s => s.id === 'old').state, 'unknown');
  assert.equal(data.codex.sessions.find(s => s.id === 'two').state, 'finished');
  assert.equal(data.codex.sessions.find(s => s.id === 'one').lastUserMessageAt, questionTimes.one);
  assert.deepEqual(data.codex.widgetSessions.filter(s => s.lastUserMessageAt).map(s => s.id), ['two', 'one', 'old']);
  const ws = new WebSocket(url.replace('http', 'ws'));
  t.after(() => ws.close());
  const messages = [];
  ws.on('message', bytes => messages.push(JSON.parse(bytes)));
  await once(ws, 'open');
  fs.appendFileSync(files.one, entry('function_call', { name: 'functions.request_user_input_async' }));
  await until(data => data.codex.state === 'permission');
  fs.appendFileSync(files.one, entry('task_complete'));
  data = await until(data => data.codex.sessions.find(s => s.id === 'one')?.state === 'finished');
  assert.equal(data.codex.state, 'unknown');
  assert.equal(data.codex.counts.finished, 3);
  assert.deepEqual(data.codex.widgetSessions.filter(s => s.lastUserMessageAt).map(s => s.id), ['two', 'one', 'old'], 'completion must not change question chronology');
  assert.ok(messages.some(m => m.data?.sessions?.find(s => s.id === 'one')?.state === 'permission'));
  fs.appendFileSync(files.two, entry('turn_aborted'));
  await until(data => data.codex.sessions.find(s => s.id === 'two')?.state === 'interrupted');
  const nextQuestionTime = Date.now();
  fs.appendFileSync(files.one, JSON.stringify({ type: 'event_msg', timestamp: new Date(nextQuestionTime).toISOString(), payload: { type: 'user_message', message: '下一个问题' } }) + '\n');
  data = await until(data => data.codex.sessions.find(s => s.id === 'one')?.lastUserMessageAt === nextQuestionTime);
  assert.deepEqual(data.codex.widgetSessions.filter(s => s.lastUserMessageAt).map(s => s.id), ['one', 'two', 'old']);
  fs.unlinkSync(files.two);
  await until(data => !data.codex.sessions.some(s => s.id === 'two'));
  assert.equal(fs.readFileSync(files.old, 'utf8'), oldContent);
});
