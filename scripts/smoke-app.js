// Verify real windows. --fixtures isolates data and exercises concurrent lamp changes.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const assert = require('assert/strict');
const errors = [];
const fixtureMode = process.argv.includes('--fixtures');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let fixtureRoot;
let fixtureFiles;
app.on('web-contents-created', (_, contents) => {
  contents.on('console-message', details => { if (details.level === 'error') errors.push(details.message); });
  contents.on('render-process-gone', (_, details) => errors.push(`renderer: ${details.reason}`));
});

async function prepareFixtures() {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-light-ui-'));
  const directory = path.join(fixtureRoot, 'data', 'sessions', '2026', '10', '13');
  fs.mkdirSync(directory, { recursive: true });
  fs.mkdirSync(path.join(fixtureRoot, 'user-data'));
  app.setPath('userData', path.join(fixtureRoot, 'user-data'));
  process.env.CODEX_LIGHT_DATA_DIR = path.join(fixtureRoot, 'data');
  process.env.CODEX_LIGHT_CONFIG_FILE = path.join(fixtureRoot, 'config.json');
  const fakeApp = path.join(fixtureRoot, 'ChatGPT.app');
  fs.mkdirSync(path.join(fakeApp, 'Contents', 'MacOS'), { recursive: true });
  fs.writeFileSync(path.join(fakeApp, 'Contents', 'Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>ChatGPT</string></dict></plist>');
  fs.writeFileSync(path.join(fakeApp, 'Contents', 'MacOS', 'ChatGPT'), '');
  fs.writeFileSync(process.env.CODEX_LIGHT_CONFIG_FILE, JSON.stringify({ codexAppPath: fakeApp, scale: 1 }));
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  process.env.CODEX_LIGHT_PORT = String(socket.address().port);
  await new Promise(resolve => socket.close(resolve));
  fixtureFiles = new Map();
  const names = ['数据分析', '页面修改', '报告生成', '等待你的确认', '接口调试', '文档整理', '资料检索'];
  const types = ['task_started', 'function_call', 'task_complete', 'exec_approval_request', 'task_started', 'task_started', 'task_started'];
  names.forEach((title, index) => {
    const id = `task-${index + 1}`;
    const file = path.join(directory, `rollout-${id}.jsonl`);
    const timestamp = new Date(Date.now() - (names.length - index) * 1000).toISOString();
    fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id, title, cwd: '/projects/界面验证' } }) + '\n' +
      JSON.stringify({ type: 'event_msg', timestamp, payload: { type: 'user_message', message: title } }) + '\n' +
      JSON.stringify({ type: 'event_msg', timestamp, payload: { type: types[index], name: '编辑页面' } }) + '\n');
    fixtureFiles.set(id, file);
  });
  fs.appendFileSync(fixtureFiles.get('task-1'), JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(),
    payload: { type: 'token_count', rate_limits: { plan_type: 'pro', primary: { used_percent: 27, window_minutes: 10080 } } } }) + '\n');
}

async function run() {
  if (fixtureMode) await prepareFixtures();
  require('../main');
  const service = require('../server');
  await Promise.all([app.whenReady(), service.ready]);
  await sleep(2500);
  const windows = BrowserWindow.getAllWindows();
  assert.equal(windows.length, 1, 'startup should show only the floating widget');
  const widget = windows.find(window => window.webContents.getURL().endsWith('/widget.html'));
  assert.ok(widget);
  if (fixtureMode) {
    assert.equal(service.getConfig().quotaDisplay, 'widget');
    assert.equal(await widget.webContents.executeJavaScript(`document.getElementById('widget-quota').classList.contains('hidden')`), false);
    assert.equal(await widget.webContents.executeJavaScript(`document.getElementById('widget-quota-five-hour').textContent`), '5 小时 100%');
    assert.equal(await widget.webContents.executeJavaScript(`document.getElementById('widget-quota-weekly').textContent`), 'Weekly 73%');
  }
  if (fixtureMode) {
    // Exercise real Web Audio without making the verification itself audible.
    widget.webContents.setAudioMuted(true);
    await widget.webContents.executeJavaScript(`
      window.soundProbe = { starts: [], contexts: [] };
      const originalCreateOscillator = AudioContext.prototype.createOscillator;
      AudioContext.prototype.createOscillator = function () {
        if (!window.soundProbe.contexts.includes(this)) window.soundProbe.contexts.push(this);
        const oscillator = originalCreateOscillator.call(this);
        const originalStart = oscillator.start.bind(oscillator);
        oscillator.start = time => { window.soundProbe.starts.push(time); originalStart(time); };
        return oscillator;
      };
      void 0;
    `);
  }
  app.emit('activate');
  await sleep(100);
  assert.equal(BrowserWindow.getAllWindows().length, 1, 'activation should not open settings');
  app.emit('second-instance');
  await sleep(100);
  assert.equal(BrowserWindow.getAllWindows().length, 1, 'reopening should not open settings');
  await widget.webContents.executeJavaScript(`document.getElementById('btn-open-control').click()`);
  await sleep(500);
  assert.equal(BrowserWindow.getAllWindows().length, 2, 'settings should open only on request');
  let control = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'));
  const result = await control.webContents.executeJavaScript(`({ title: document.title, connected: document.getElementById('codex-ws-status').classList.contains('online'), rows: document.querySelectorAll('.session-row').length, count: document.getElementById('sessions-count').textContent, overflow: document.documentElement.scrollWidth > window.innerWidth })`);
  assert.equal(result.connected, true);
  assert.equal(result.overflow, false);
  assert.equal(control.getBounds().width, 480, 'settings should be a small window');
  assert.equal(control.getBounds().height, 564);
  assert.equal(await control.webContents.executeJavaScript(`document.getElementById('conversation-settings').open || document.getElementById('advanced-settings').open`), false, 'extra settings should start collapsed');
  assert.equal(await control.webContents.executeJavaScript(`!!document.getElementById('codex-monitor') || !!document.getElementById('log-console')`), false, 'settings should not contain the old dashboard');
  await control.webContents.executeJavaScript(`document.getElementById('conversation-settings').open = true; document.getElementById('session-filter').value = 'all'; document.getElementById('session-filter').dispatchEvent(new Event('change'));`);
  assert.ok(await control.webContents.executeJavaScript(`document.querySelectorAll('.session-row').length > 0`), 'expected conversation rows');
  await control.webContents.executeJavaScript(`document.getElementById('session-search').value = '__nonexistent_query__'; document.getElementById('session-search').dispatchEvent(new Event('input'));`);
  assert.equal(await control.webContents.executeJavaScript(`document.querySelectorAll('.session-row').length`), 0);
  await control.webContents.executeJavaScript(`document.getElementById('session-search').value = ''; document.getElementById('session-search').dispatchEvent(new Event('input'));`);
  const inspect = () => widget.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.conversation-tile')).map(el => ({ id: el.dataset.sessionId, state: el.dataset.state, x: el.getBoundingClientRect().x, title: el.querySelector('.conversation-title').textContent }))`);
  if (fixtureMode) {
    await control.webContents.executeJavaScript(`document.getElementById('scale-slider').value = '1.2'; document.getElementById('scale-slider').dispatchEvent(new Event('input'));`);
    await sleep(300);
    assert.equal(service.getConfig().scale, 1.2, 'scale should save without a submit button');
    assert.equal(widget.getBounds().height, Math.round(164 * 1.2));
    await control.webContents.executeJavaScript(`document.getElementById('scale-slider').value = '1'; document.getElementById('scale-slider').dispatchEvent(new Event('input'));`);
    await sleep(300);
    await control.webContents.executeJavaScript(`document.getElementById('show-quota').click()`);
    await sleep(300);
    assert.equal(service.getConfig().quotaDisplay, 'hidden');
    await control.webContents.executeJavaScript(`document.getElementById('show-quota').click()`);
    await sleep(300);
    assert.equal(service.getConfig().quotaDisplay, 'widget');
    const first = await inspect();
    assert.equal(first.length, 6);
    assert.deepEqual(first.map(lamp => lamp.id), ['task-7', 'task-6', 'task-5', 'task-4', 'task-3', 'task-2'], 'lamps should show the latest question first');
    assert.ok(first.some(lamp => lamp.state === 'thinking'));
    assert.ok(first.some(lamp => lamp.state === 'executing'));
    assert.ok(first.some(lamp => lamp.state === 'finished'));
    assert.ok(first.some(lamp => lamp.state === 'permission'));
    assert.ok(first.every((lamp, i) => !i || lamp.x > first[i - 1].x), 'lamps must be horizontal');
    assert.equal(widget.getBounds().height, 164);
    assert.equal(await widget.webContents.executeJavaScript(`window.soundProbe.starts.length`), 0, 'existing green lamps and config changes must stay silent');
    fs.appendFileSync(fixtureFiles.get('task-6'), JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'task_complete' } }) + '\n');
    await sleep(600);
    const updated = await inspect();
    assert.deepEqual(updated.map(lamp => lamp.id), first.map(lamp => lamp.id));
    assert.equal(updated.find(lamp => lamp.id === 'task-6').state, 'finished');
    assert.equal(updated.find(lamp => lamp.id === 'task-2').state, 'executing');
    const sound = await widget.webContents.executeJavaScript(`({ starts: window.soundProbe.starts, states: window.soundProbe.contexts.map(context => context.state) })`);
    assert.equal(sound.starts.length, 9, 'one completion must play three bells with three partials each');
    assert.deepEqual(sound.states, ['running'], 'audio must run without a widget gesture');
    assert.ok(Math.abs(sound.starts[3] - sound.starts[0] - 0.95) < 0.001);
    assert.ok(Math.abs(sound.starts[6] - sound.starts[0] - 1.9) < 0.001);
    fs.appendFileSync(fixtureFiles.get('task-6'), JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'task_complete' } }) + '\n');
    await sleep(300);
    assert.equal(await widget.webContents.executeJavaScript(`window.soundProbe.starts.length`), 9, 'duplicate completion must stay silent');
    // Both sequences should start together, including the conversation on page two.
    for (const id of ['task-5', 'task-1']) {
      fs.appendFileSync(fixtureFiles.get(id), JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'task_complete' } }) + '\n');
    }
    await sleep(400);
    const overlapping = await widget.webContents.executeJavaScript(`window.soundProbe.starts.slice(9)`);
    assert.equal(overlapping.length, 18, 'both completions must play their own three bells');
    assert.ok(Math.abs(overlapping[9] - overlapping[0]) < 0.95, 'sequences must overlap instead of queuing');
    assert.equal(await control.webContents.executeJavaScript(`document.getElementById('play-completion-sound').checked`), true);
    await control.webContents.executeJavaScript(`document.getElementById('play-completion-sound').click()`);
    await sleep(300);
    assert.equal(service.getConfig().completionSoundEnabled, false);
    assert.equal(JSON.parse(fs.readFileSync(process.env.CODEX_LIGHT_CONFIG_FILE, 'utf8')).completionSoundEnabled, false, 'sound preference must be persisted');
    fs.appendFileSync(fixtureFiles.get('task-4'), JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'task_complete' } }) + '\n');
    await sleep(400);
    assert.equal(await widget.webContents.executeJavaScript(`window.soundProbe.starts.length`), 27, 'muted completions must stay silent');
    await widget.webContents.executeJavaScript(`document.getElementById('widget-next').click()`);
    assert.deepEqual((await inspect()).map(lamp => lamp.id), ['task-1'], 'the oldest question should be on the last page');
    await widget.webContents.executeJavaScript(`document.getElementById('widget-prev').click()`);
    assert.equal((await inspect()).length, 6);
    const checkbox = `document.querySelector('.session-widget-choice input[data-session-id="task-3"]')`;
    await control.webContents.executeJavaScript(`${checkbox}.click()`);
    await sleep(300);
    assert.ok(!(await inspect()).some(lamp => lamp.id === 'task-3'), 'unchecked conversation must hide');
    await control.webContents.executeJavaScript(`${checkbox}.click()`);
    await sleep(300);
    assert.ok((await inspect()).some(lamp => lamp.id === 'task-3'));
    await control.webContents.executeJavaScript(`document.getElementById('widget-mode').value = 'manual'; document.getElementById('widget-mode').dispatchEvent(new Event('change'));`);
    await sleep(300);
    assert.deepEqual((await inspect()).map(lamp => lamp.id), ['task-3']);
    assert.equal(await widget.webContents.executeJavaScript(`document.documentElement.scrollWidth > window.innerWidth`), false, 'both quota labels should fit a two-column widget');
    const quotaFixture = plan => ({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'token_count', rate_limits: plan === 'plus'
      ? { plan_type: 'plus', primary: { used_percent: 18, window_minutes: 300 }, secondary: { used_percent: 54, window_minutes: 10080 } }
      : { plan_type: 'pro', primary: { used_percent: 27, window_minutes: 10080 } } } });
    fs.appendFileSync(fixtureFiles.get('task-1'), JSON.stringify(quotaFixture('plus')) + '\n');
    await sleep(400);
    assert.equal(await widget.webContents.executeJavaScript(`document.getElementById('widget-quota-five-hour').textContent`), '5 小时 82%');
    assert.equal(await widget.webContents.executeJavaScript(`document.getElementById('widget-quota-weekly').textContent`), 'Weekly 46%');
    assert.equal(await widget.webContents.executeJavaScript(`document.documentElement.scrollWidth > window.innerWidth`), false);
    fs.appendFileSync(fixtureFiles.get('task-1'), JSON.stringify(quotaFixture('pro')) + '\n');
    await sleep(400);
    assert.equal(await widget.webContents.executeJavaScript(`document.getElementById('widget-quota-five-hour').textContent`), '5 小时 100%');
    const narrowDir = path.join(__dirname, '..', 'dist');
    fs.mkdirSync(narrowDir, { recursive: true });
    fs.writeFileSync(path.join(narrowDir, 'widget-quota-narrow-preview.png'), (await widget.webContents.capturePage()).toPNG());
    await control.webContents.executeJavaScript(`document.getElementById('widget-mode').value = 'auto'; document.getElementById('widget-mode').dispatchEvent(new Event('change'));`);
    await sleep(300);
    // Restore the sample's thinking state for the preview, then check resizing and button behavior.
    fs.appendFileSync(fixtureFiles.get('task-1'), JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'task_started' } }) + '\n');
    await sleep(400);
    await new Promise(resolve => {
      control.once('closed', resolve);
      control.webContents.executeJavaScript(`document.getElementById('btn-close-settings').click()`);
    });
    assert.equal(BrowserWindow.getAllWindows().length, 1);
    await widget.webContents.executeJavaScript(`document.getElementById('btn-open-control').click()`);
    await sleep(500);
    assert.equal(BrowserWindow.getAllWindows().length, 2);
    control = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'));
    assert.equal(await control.webContents.executeJavaScript(`document.querySelectorAll('.session-widget-choice input:checked').length`), 7);
    assert.equal(await control.webContents.executeJavaScript(`document.getElementById('play-completion-sound').checked`), false, 'reopening settings must retain the sound preference');
    await control.webContents.executeJavaScript(`document.getElementById('play-completion-sound').click()`);
    await sleep(300);
    assert.equal(await widget.webContents.executeJavaScript(`window.soundProbe.starts.length`), 27, 'enabling sound must not replay muted completions');
    fs.appendFileSync(fixtureFiles.get('task-4'), JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'task_started' } }) + '\n');
    await sleep(400);
    fs.appendFileSync(fixtureFiles.get('task-4'), JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'task_complete' } }) + '\n');
    await sleep(400);
    assert.equal(await widget.webContents.executeJavaScript(`window.soundProbe.starts.length`), 36, 'new completions must sound after enabling');
    // Simulate an aged event without waiting five real minutes; the other lamps stay fresh.
    fs.appendFileSync(fixtureFiles.get('task-1'), JSON.stringify({ type: 'event_msg', timestamp: new Date(Date.now() - 301000).toISOString(), payload: { type: 'task_complete' } }) + '\n');
    await sleep(400);
    assert.ok(!(await inspect()).some(lamp => lamp.id === 'task-1'), 'idle conversation should disappear');
    assert.ok((await inspect()).some(lamp => lamp.id === 'task-2'), 'other conversations must stay');
    fs.appendFileSync(fixtureFiles.get('task-1'), JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'task_started' } }) + '\n');
    await sleep(400);
    await widget.webContents.executeJavaScript(`document.getElementById('widget-next').click()`);
    assert.deepEqual((await inspect()).map(lamp => lamp.id), ['task-1'], 'output-only recovery should restore the oldest question on the last page');
    fs.appendFileSync(fixtureFiles.get('task-1'), JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'user_message', message: '继续下一个问题' } }) + '\n');
    await sleep(400);
    await widget.webContents.executeJavaScript(`document.getElementById('widget-prev').click()`);
    assert.deepEqual((await inspect()).map(lamp => lamp.id), ['task-1', 'task-7', 'task-6', 'task-5', 'task-4', 'task-3'], 'a new user question should move the conversation to the front');
  }
  assert.ok(widget.getBounds().width > widget.getBounds().height);
  const widgetResult = await widget.webContents.executeJavaScript(`({ count: document.getElementById('widget-count').textContent, page: document.getElementById('widget-page').textContent, overflow: document.documentElement.scrollWidth > window.innerWidth, tiles: document.querySelectorAll('.conversation-tile').length })`);
  assert.equal(widgetResult.overflow, false);
  control.show();
  control.focus();
  await control.webContents.executeJavaScript(`document.getElementById('conversation-settings').open = false; document.getElementById('advanced-settings').open = false;`);
  assert.equal(await control.webContents.executeJavaScript(`document.querySelector('main').scrollHeight > document.querySelector('main').clientHeight`), false, 'default settings should fit without scrolling');
  await sleep(500);
  const dir = path.join(__dirname, '..', 'dist');
  fs.mkdirSync(dir, { recursive: true });
  const suffix = fixtureMode ? '-fixture' : '';
  fs.writeFileSync(path.join(dir, `settings-preview${suffix}.png`), (await control.webContents.capturePage()).toPNG());
  fs.writeFileSync(path.join(dir, `widget-preview${suffix}.png`), (await widget.webContents.capturePage()).toPNG());
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('SMOKE PASS', JSON.stringify({ ...result, widget: widgetResult, fixtureMode, widgetOnlyStartup: true }));
  app.exit(0);
}
run().catch(error => { console.error(error); app.exit(1); });
setTimeout(() => { console.error('SMOKE TIMEOUT'); app.exit(1); }, 30000).unref();
