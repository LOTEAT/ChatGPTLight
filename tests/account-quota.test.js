const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { once } = require('node:events');
const { AppServerClient, AccountQuotaReader, fromAccount, fromLog } = require('../account-quota');

async function fakeServer(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'light-account-'));
  const file = path.join(root, 'fake-codex.cjs');
  await fs.writeFile(file, `#!/usr/bin/env node
const { createInterface } = require('node:readline');
let initialized = false;
let count = 0;
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  const reply = result => process.stdout.write(JSON.stringify({ id: message.id, result }) + '\\n');
  if (message.method === 'initialize') {
    if (process.argv.includes('--init-error')) return process.stdout.write(JSON.stringify({ id: message.id, error: { message: 'Unsupported client' } }) + '\\n');
    process.stdout.write('unstructured startup text\\n');
    const response = JSON.stringify({ id: message.id, result: { userAgent: '测试' } }) + '\\n';
    process.stdout.write(response.slice(0, 8));
    setTimeout(() => process.stdout.write(response.slice(8)), 5);
  } else if (message.method === 'initialized') initialized = true;
  else if (!initialized) process.stdout.write(JSON.stringify({ id: message.id, error: { message: 'Not initialized' } }) + '\\n');
  else if (message.method === 'account/read') setTimeout(() => reply({ account: { type: 'chatgpt', planType: 'pro' } }), 15);
  else if (message.method === 'account/rateLimits/read') {
    if (process.argv.includes('--timeout')) return;
    if (process.argv.includes('--disconnect')) return process.exit(0);
    reply({ rateLimitsByLimitId: { codex: { primary: { usedPercent: 12 + count++, windowDurationMins: 10080 } }, other: { primary: { usedPercent: 90, windowDurationMins: 300 } } } });
  } else if (message.method === 'test/notify') {
    process.stdout.write(JSON.stringify({ method: 'account/rateLimits/updated', params: { rateLimits: { primary: { usedPercent: 20, windowDurationMins: 10080 } } } }) + '\\n');
    reply({});
  }
});
`, { mode: 0o755 });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return file;
}

test('normalizes the Codex bucket without selecting another bucket and accepts a separate account plan', () => {
  const quota = fromAccount({ rateLimitsByLimitId: { codex: { primary: { usedPercent: 12, windowDurationMins: 10080 } }, other: { primary: { usedPercent: 90, windowDurationMins: 300 } } } }, 'pro', 2000);
  assert.equal(quota.primaryRemaining, 88);
  assert.equal(quota.primaryWindowMinutes, 10080);
  assert.equal(quota.secondaryRemaining, null);
  assert.equal(quota.planType, 'pro');
  assert.equal(quota.sourceKind, 'account');
  assert.equal(fromAccount({}), null);
  assert.equal(fromLog({ payload: { type: 'task_complete' } }), null);
  assert.equal(fromLog({ timestamp: new Date(1000).toISOString(), payload: { type: 'token_count', rate_limits: { plan_type: 'plus', primary: { used_percent: 14, window_minutes: 300 } } } }).primaryRemaining, 86);
});

test('initializes the official protocol, correlates out-of-order replies and reuses one account process', async t => {
  const command = await fakeServer(t);
  const readings = [];
  const errors = [];
  const reader = new AccountQuotaReader({ getCommand: () => command, getEnv: () => process.env,
    clientInfo: { name: 'test', version: '1' }, intervalMs: 100000,
    onQuota: value => readings.push(value), onError: error => errors.push(error) });
  t.after(() => reader.stop());
  await reader.start();
  const child = reader.client.child;
  assert.equal(readings[0].planType, 'pro');
  assert.equal(readings[0].primaryRemaining, 88);
  await reader.refresh();
  assert.equal(reader.client.child.pid, child.pid);
  assert.equal(readings.at(-1).primaryRemaining, 87);
  await reader.client.request('test/notify');
  assert.equal(readings.at(-1).primaryRemaining, 80);
  assert.deepEqual(errors, []);
  const exited = once(child, 'exit');
  reader.stop();
  await exited;
  assert.equal(child.killed, true);
});

test('protocol errors, disconnections and timeouts reject requests and terminate the child', async t => {
  const command = await fakeServer(t);
  for (const mode of ['--init-error', '--disconnect', '--timeout']) {
    const client = new AppServerClient({ command, args: [mode], clientInfo: { name: 'test', version: '1' }, timeoutMs: 5000 });
    t.after(() => client.close());
    if (mode === '--init-error') await assert.rejects(client.connect(), /Unsupported client/);
    else {
      await client.connect();
      client.timeoutMs = 150;
      await assert.rejects(client.request('account/rateLimits/read'), /连接已断开|请求超时/);
    }
    assert.equal(client.requests.size, 0);
    assert.equal(client.ready, false);
  }
});
