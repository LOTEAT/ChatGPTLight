const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const path = require('node:path');

function quotaSnapshot(windows, context) {
  const fields = {};
  for (const key of ['primary', 'secondary']) {
    const window = windows[key];
    const used = Number.isFinite(window?.used) ? Math.max(0, Math.min(100, window.used)) : null;
    const reset = Number.isFinite(window?.reset) && window.reset > 0 ? window.reset : null;
    Object.assign(fields, {
      [`${key}Used`]: used, [`${key}Remaining`]: used === null ? null : 100 - used,
      [`${key}WindowMinutes`]: Number.isFinite(window?.minutes) ? window.minutes : null,
      [`${key}ResetsAt`]: reset,
      [`${key}ResetText`]: reset ? new Date(reset * 1000).toLocaleString('zh-CN', {
        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''
    });
  }
  return { ...fields, totalTokens: null, lastTokens: null, ...context,
    updatedAt: new Date(context.timestampMs).toISOString() };
}

function fromAccount(result, planType = null, now = Date.now()) {
  const bucket = result?.rateLimitsByLimitId?.codex ?? result?.rateLimits;
  if (!bucket || typeof bucket !== 'object') return null;
  const window = value => value && ({ used: value.usedPercent, minutes: value.windowDurationMins, reset: value.resetsAt });
  return quotaSnapshot({ primary: window(bucket.primary), secondary: window(bucket.secondary) }, {
    source: 'Codex 账户', sourceKind: 'account', limitId: bucket.limitId || 'codex',
    planType: bucket.planType || planType, timestampMs: now
  });
}

function fromLog(entry, file = '', now = Date.now()) {
  const payload = entry?.payload;
  if (payload?.type !== 'token_count' || !payload.rate_limits) return null;
  const limits = payload.rate_limits;
  const window = value => value && ({ used: value.used_percent, minutes: value.window_minutes, reset: value.resets_at });
  return quotaSnapshot({ primary: window(limits.primary), secondary: window(limits.secondary) }, {
    source: path.basename(file), sourceKind: 'log', limitId: limits.limit_id || null,
    planType: limits.plan_type || limits.planType || null,
    totalTokens: payload.info?.total_token_usage?.total_tokens ?? null,
    lastTokens: payload.info?.last_token_usage?.total_tokens ?? null,
    timestampMs: Date.parse(entry.timestamp) || now
  });
}

// Implements OpenAI's documented app-server JSONL protocol; no SDK or copied client is needed.
class AppServerClient {
  constructor({ command, args = ['app-server', '--listen', 'stdio://'], env = process.env,
    clientInfo, timeoutMs = 12000, onNotification = () => {} }) {
    Object.assign(this, { command, args, env, clientInfo, timeoutMs, onNotification });
    this.requests = new Map();
    this.nextId = 1;
  }

  connect() {
    if (this.ready) return Promise.resolve();
    if (this.connecting) return this.connecting;
    const child = this.child = spawn(this.command, this.args, { env: this.env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.lines.on('line', line => {
      if (this.child !== child) return;
      let message;
      try { message = JSON.parse(line); } catch (_) { return; }
      if (!message || typeof message !== 'object') return;
      const request = this.requests.get(message.id);
      if (request) {
        clearTimeout(request.timer);
        this.requests.delete(message.id);
        if (message.error) request.reject(new Error(message.error.message || '账户请求失败'));
        else request.resolve(message.result);
      } else if (message.method && message.id === undefined) this.onNotification(message);
    });
    child.stderr.resume();
    child.on('error', error => { if (this.child === child) this.close(error); });
    child.stdin.on('error', error => { if (this.child === child) this.close(error); });
    child.once('exit', () => { if (this.child === child) this.close(new Error('账户连接已断开')); });
    this.connecting = this.request('initialize', { clientInfo: this.clientInfo,
      capabilities: { experimentalApi: true } }).then(() => {
      this.notify('initialized');
      this.ready = true;
    }).catch(error => { this.close(error); throw error; }).finally(() => { this.connecting = null; });
    return this.connecting;
  }

  request(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this.child || this.child.exitCode !== null || this.child.killed) { reject(new Error('账户连接不可用')); return; }
      const id = this.nextId++;
      const timer = setTimeout(() => this.close(new Error(`账户请求超时：${method}`)), this.timeoutMs);
      this.requests.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  notify(method, params = {}) { this.child.stdin.write(JSON.stringify({ method, params }) + '\n'); }

  close(error = new Error('账户连接已关闭')) {
    this.ready = false;
    for (const request of this.requests.values()) { clearTimeout(request.timer); request.reject(error); }
    this.requests.clear();
    this.lines?.close();
    this.child?.kill();
  }
}

class AccountQuotaReader {
  constructor({ getCommand, getEnv, clientInfo, onQuota, onError = () => {}, intervalMs = 30000 }) {
    Object.assign(this, { getCommand, getEnv, clientInfo, onQuota, onError, intervalMs });
    this.stopped = true;
    this.planType = null;
  }

  start() {
    this.stopped = false;
    this.timer = setInterval(() => this.refresh(), this.intervalMs);
    return this.refresh();
  }

  refresh() {
    if (this.stopped) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = this.readAccount().catch(error => {
      if (!this.stopped) this.onError(error);
    }).finally(() => { this.pending = null; });
    return this.pending;
  }

  async readAccount() {
    const command = this.getCommand();
    if (!this.client || this.client.command !== command) {
      this.client?.close();
      this.client = new AppServerClient({ command, env: this.getEnv(), clientInfo: this.clientInfo,
        onNotification: message => {
          if (this.stopped) return;
          if (message.method === 'account/updated') {
            this.planType = message.params?.planType || null;
            if (message.params?.authMode === null) this.onQuota(null);
          } else if (message.method === 'account/rateLimits/updated') {
            const quota = fromAccount(message.params, this.planType);
            if (quota) this.onQuota(quota);
          }
        } });
    }
    await this.client.connect();
    if (this.stopped) return;
    const [auth, limits] = await Promise.all([
      this.client.request('account/read', { refreshToken: false }),
      this.client.request('account/rateLimits/read')
    ]);
    if (this.stopped) return;
    this.planType = auth?.account?.planType || null;
    const quota = fromAccount(limits, this.planType);
    if (quota) this.onQuota(quota);
  }

  stop() { this.stopped = true; clearInterval(this.timer); this.client?.close(); }
}

module.exports = { AppServerClient, AccountQuotaReader, fromAccount, fromLog };
