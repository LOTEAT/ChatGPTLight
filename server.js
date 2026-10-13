const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const { execFile, execFileSync, spawn } = require('child_process');

const os = require('os');
const { detectAppPath, getAppExecutable, getCliPath } = require('./app-target');
const { snapshotSession } = require('./session-state');
const { SessionMonitor } = require('./session-monitor');
const { AccountQuotaReader, fromLog } = require('./account-quota');
const { createTracker } = require('./public/widget-model');
const widgetTracker = createTracker();
const CODEX_HOME = process.env.CODEX_LIGHT_DATA_DIR || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const PORT = Number(process.env.CODEX_LIGHT_PORT || 19001);
const SERVICE_URL = `http://127.0.0.1:${PORT}`;

const CONFIG_FILE = process.env.CODEX_LIGHT_CONFIG_FILE || path.join(os.homedir(), '.traffic-light-service-config.json');
const DEFAULT_NO_PROXY = 'localhost,127.0.0.1,::1';
const DEFAULT_PROXY_HOST = '127.0.0.1';

function canConnectHostPortSync(host, port) {
  if (!host || !port) return false;
  try {
    execFileSync('nc', ['-z', '-G', '1', host, String(port)], { stdio: 'ignore', timeout: 1500 });
    return true;
  } catch (e) {
    return false;
  }
}

function detectProxyDefaults() {
  const host = DEFAULT_PROXY_HOST;
  const httpPorts = ['7890', '7897', '1087', '1080'];
  const port = httpPorts.find(candidate => canConnectHostPortSync(host, candidate)) || '';
  if (!port) {
    return {
      httpProxy: '',
      allProxy: '',
      noProxy: DEFAULT_NO_PROXY,
      proxyHost: host,
      proxyPort: ''
    };
  }

  const socksPort = canConnectHostPortSync(host, String(Number(port) + 1)) ? String(Number(port) + 1) : port;
  return {
    httpProxy: `http://${host}:${port}`,
    allProxy: `socks5h://${host}:${socksPort}`,
    noProxy: DEFAULT_NO_PROXY,
    proxyHost: host,
    proxyPort: port
  };
}

function createDefaultConfig() {
  return {
    syncLaunch: true,
    scale: 1.0,
    quotaDisplay: 'widget',
    completionSoundEnabled: true,
    widgetMode: 'auto',
    widgetPinnedSessionIds: [],
    widgetHiddenSessionIds: [],
    codexLogPath: '',
    codexRolloutDir: path.join(CODEX_HOME, 'sessions'),
    codexDesktopLogDir: path.join(CODEX_HOME, 'logs'),
    launcherPath: '',
    codexAppPath: detectAppPath(),
    launcherLogFile: path.join(os.homedir(), 'Library', 'Logs', 'chatgpt-light-launcher.log'),
    ...detectProxyDefaults(),
    voiceEnabled: false,
    voiceName: '',
    startVoiceText: '正在启动 ChatGPT',
    stopVoiceText: '正在关闭 ChatGPT'
  };
}

// Configuration
let config = createDefaultConfig();

function expandHome(value) {
  if (!value || typeof value !== 'string') return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function loadConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      config = { ...config, ...data };
      sanitizeConfig();
    } catch (e) {
      console.error('Failed to load config:', e.message);
    }
  }
  applyAutomaticConfigDefaults();
}

function sanitizeConfig() {
  delete config.appDisplayName;
  delete config.appLogoPath;
  if (typeof config.completionSoundEnabled !== 'boolean') config.completionSoundEnabled = true;
  if (!['widget', 'hidden', 'both', 'control'].includes(config.quotaDisplay)) config.quotaDisplay = 'widget';
  config.widgetMode = config.widgetMode === 'manual' ? 'manual' : 'auto';
  for (const key of ['widgetPinnedSessionIds', 'widgetHiddenSessionIds']) {
    config[key] = [...new Set(Array.isArray(config[key]) ? config[key].filter(id => typeof id === 'string' && id.length <= 100) : [])].slice(0, 1000);
  }
}

function applyAutomaticConfigDefaults() {
  if (!config.codexAppPath || !fs.existsSync(getAppExecutable(expandHome(config.codexAppPath)))) {
    config.codexAppPath = detectAppPath();
  }

  config.codexRolloutDir = expandHome(config.codexRolloutDir);
  config.codexDesktopLogDir = expandHome(config.codexDesktopLogDir);
  if (!config.codexRolloutDir) {
    config.codexRolloutDir = path.join(CODEX_HOME, 'sessions');
  }

  if (!config.codexDesktopLogDir) {
    config.codexDesktopLogDir = path.join(CODEX_HOME, 'logs');
  }

  if (!config.launcherLogFile) {
    config.launcherLogFile = path.join(os.homedir(), 'Library', 'Logs', 'chatgpt-light-launcher.log');
  }

  if (config.launcherPath && !fs.existsSync(expandHome(config.launcherPath))) {
    config.launcherPath = '';
  }

  if (!config.noProxy) {
    config.noProxy = DEFAULT_NO_PROXY;
  }

  if (!config.proxyHost) {
    config.proxyHost = DEFAULT_PROXY_HOST;
  }
}

function saveConfig() {
  try {
    sanitizeConfig();
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to save config:', e.message);
  }
}

loadConfig();

// System State
const state = {
  codexSessions: {}, // Map of filePath -> { state, detail, lastActive }
  quota: null
};

// Keep completion and stale observations distinct. Logs are a passive data source.
function getAggregateCodexState() {
  const sessions = Object.entries(state.codexSessions)
    .filter(([filePath, session]) => !session.isSubagent && !threadMetadata.get(filePath)?.archived)
    .map(([filePath, session]) => {
      const metadata = threadMetadata.get(filePath) || {};
      return snapshotSession({ ...session, title: metadata.name || metadata.title || session.title,
        project: metadata.cwd ? path.basename(metadata.cwd) : session.project });
    });
  const priority = ['permission', 'error', 'executing', 'thinking', 'unknown', 'interrupted', 'finished'];
  const counts = Object.fromEntries([...priority, 'offline'].map(key => [key, 0]));
  sessions.forEach(session => { if (counts[session.state] !== undefined) counts[session.state]++; });
  const rank = session => Math.min(priority.indexOf(session.state), 5);
  sessions.sort((a, b) => rank(a) - rank(b) || b.lastActive - a.lastActive);
  const selected = sessions[0];
  return { state: selected?.state || 'offline', detail: selected?.detail || '未发现本地 Codex 会话',
    counts, activeSession: selected?.id || '', sessions, widgetSessions: widgetTracker.update(sessions, config), limit: CODEX_WATCH_COUNT,
    source: 'ChatGPT / 本地 Codex 会话日志' };
}

let threadMetadata = new Map();
let metadataRefreshInFlight = false;
async function refreshThreadMetadata() {
  if (metadataRefreshInFlight) return;
  metadataRefreshInFlight = true;
  try {
    const databases = fs.readdirSync(CODEX_HOME).filter(name => /^state_\d+\.sqlite$/.test(name))
      .sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
    if (!databases.length) return;
    const dbPath = path.join(CODEX_HOME, databases[0]);
    const columns = JSON.parse(await execFilePromise('/usr/bin/sqlite3', ['-readonly', '-json', dbPath, 'PRAGMA table_info(threads)'], { timeout: 3000 }));
    const hasName = columns.some(column => column.name === 'name');
    const query = `SELECT rollout_path, title, cwd, archived${hasName ? ', name' : ''} FROM threads ORDER BY updated_at DESC LIMIT 1000`;
    const rows = JSON.parse(await execFilePromise('/usr/bin/sqlite3', ['-readonly', '-json', dbPath, query], { timeout: 3000, maxBuffer: 4 * 1024 * 1024 }) || '[]');
    threadMetadata = new Map(rows.map(row => [row.rollout_path, row]));
    broadcastCodexAggregate();
  } catch (_) {
    // Titles are optional; older versions and locked databases keep the log-derived labels.
  } finally { metadataRefreshInFlight = false; }
}

function readSessionMetadata(filePath) {
  const fallbackId = path.basename(filePath, '.jsonl').slice(-36);
  try {
    const fd = fs.openSync(filePath, 'r');
    let text;
    try {
      const buffer = Buffer.alloc(64 * 1024);
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
      text = buffer.subarray(0, bytes).toString('utf8').split('\n')[0];
    } finally { fs.closeSync(fd); }
    const entry = JSON.parse(text);
    const payload = entry.payload || {};
    return { id: payload.id || fallbackId, title: payload.thread_name || payload.title || `对话 ${String(payload.id || fallbackId).slice(0, 8)}`,
      project: payload.cwd ? path.basename(payload.cwd) : '', isSubagent: !!payload.source?.subagent,
      createdAt: Date.parse(payload.timestamp || entry.timestamp) || null };
  } catch (_) { return { id: fallbackId, title: `对话 ${fallbackId.slice(0, 8)}`, project: '', isSubagent: false }; }
}

const CODEX_WATCH_COUNT = 100;
const CODEX_DISCOVERY_INTERVAL_MS = 1500;
const CODEX_RATE_LIMIT_POLL_MS = 30000;

let lastCodexAggregateSignature = '';

function broadcastCodexAggregate(force = false) {
  const aggregate = getAggregateCodexState();
  const signature = JSON.stringify({
    state: aggregate.state,
    detail: aggregate.detail,
    counts: aggregate.counts,
    activeSession: aggregate.activeSession,
    sessions: aggregate.sessions,
    widgetSessions: aggregate.widgetSessions,
    quota: state.quota
  });

  if (!force && signature === lastCodexAggregateSignature) return;
  lastCodexAggregateSignature = signature;
  broadcast('event', { agent: 'codex', ...aggregate, quota: state.quota });
}

function updateQuotaFromEntry(entry, filePath = '', shouldBroadcast = true) {
  if (state.quota?.sourceKind === 'account') return false;
  const quota = fromLog(entry, filePath);
  if (!quota || (state.quota && quota.timestampMs < state.quota.timestampMs)) return false;
  state.quota = quota;
  if (shouldBroadcast) {
    broadcast('quota', quota);
    broadcastCodexAggregate();
  }
  return true;
}

function getCodexCliPath() {
  const settings = getLauncherSettings();
  return getCliPath(settings.appPath);
}

function getCodexProxyEnv() {
  const settings = getLauncherSettings();
  const env = {
    ...process.env,
    NO_PROXY: settings.noProxy,
    no_proxy: settings.noProxy
  };

  if (isProxyConfigured(settings) && canConnectHostPortSync(settings.proxyHost, settings.proxyPort)) {
    env.HTTP_PROXY = settings.httpProxy;
    env.HTTPS_PROXY = settings.httpProxy;
    env.http_proxy = settings.httpProxy;
    env.https_proxy = settings.httpProxy;
    if (settings.allProxy) {
      env.ALL_PROXY = settings.allProxy;
      env.all_proxy = settings.allProxy;
    }
  }

  return env;
}

const accountQuota = new AccountQuotaReader({
  getCommand: getCodexCliPath,
  getEnv: getCodexProxyEnv,
  clientInfo: { name: 'chatgpt-light', title: 'ChatGPT Light', version: require('./package.json').version },
  intervalMs: CODEX_RATE_LIMIT_POLL_MS,
  onQuota: quota => {
    state.quota = quota;
    broadcast('quota', quota);
    broadcastCodexAggregate();
  },
  onError: error => console.error('[Quota]', error.message)
});
function refreshCodexAccountQuota() { return accountQuota.refresh(); }

// Express Setup
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// WebSocket broadcast helper
function broadcast(type, data) {
  const payload = JSON.stringify({ type, data });
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

// Update Agent State
function updateAgentState(agent, newState, detail = '', filePath = 'default', timestamp = Date.now()) {
  if (agent !== 'codex') return;
  const session = state.codexSessions[filePath] || { ...readSessionMetadata(filePath) };
  Object.assign(session, { state: newState, detail, lastActive: timestamp });
  state.codexSessions[filePath] = session;
  broadcastCodexAggregate();
}

const sessionMonitor = new SessionMonitor({
  directory: config.codexRolloutDir,
  limit: CODEX_WATCH_COUNT,
  discoveryMs: CODEX_DISCOVERY_INTERVAL_MS,
  onSession: (file, session, entry) => {
    state.codexSessions[file] = session;
    if (entry) updateQuotaFromEntry(entry, file, false);
    broadcastCodexAggregate();
  },
  onRemove: file => { delete state.codexSessions[file]; broadcastCodexAggregate(); },
  onError: error => console.error('[Sessions]', error.message)
});
function syncCodexRolloutWatchers() { return sessionMonitor.poll(true).catch(sessionMonitor.onError); }
function initLogWatchers() {
  state.codexSessions = {};
  lastCodexAggregateSignature = '';
  return sessionMonitor.reset(config.codexRolloutDir);
}

const heartbeatTimer = setInterval(() => {
  broadcast('status', { codex: getAggregateCodexState(), quota: state.quota, config });
}, 5000);
const metadataTimer = setInterval(refreshThreadMetadata, 5000);

// Sync Launch Process Daemon
let isCodexRunning = false;

function getLauncherSettings() {
  const appPath = expandHome(config.codexAppPath || detectAppPath());
  return {
    appPath,
    exePath: getAppExecutable(appPath),
    appName: path.basename(appPath, '.app') || 'ChatGPT',
    logFile: expandHome(config.launcherLogFile || path.join(os.homedir(), 'Library', 'Logs', 'chatgpt-light-launcher.log')),
    httpProxy: config.httpProxy || '',
    allProxy: config.allProxy || '',
    noProxy: config.noProxy || 'localhost,127.0.0.1,::1',
    proxyHost: config.proxyHost || '127.0.0.1',
    proxyPort: String(config.proxyPort || '')
  };
}

function isProxyConfigured(settings) {
  return Boolean(settings.httpProxy && settings.proxyHost && settings.proxyPort);
}

function appendLauncherLog(message) {
  const settings = getLauncherSettings();
  const line = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${message}\n`;
  try {
    fs.mkdirSync(path.dirname(settings.logFile), { recursive: true });
    fs.appendFileSync(settings.logFile, line, 'utf8');
  } catch (e) {
    console.error('[Launcher] Failed to write log:', e.message);
  }
  return line.trim();
}

function execFilePromise(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      const output = [stdout, stderr].filter(Boolean).join('\n').trim();
      if (error) {
        error.output = output || error.message;
        reject(error);
        return;
      }
      resolve(output);
    });
  });
}

async function isCodexProcessRunning() {
  const settings = getLauncherSettings();
  try {
    await execFilePromise('pgrep', ['-f', settings.exePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')], { timeout: 5000 });
    return true;
  } catch (e) {
    return false;
  }
}

function speakIfEnabled(text) {
  const phrase = (text || '').trim();
  if (!config.voiceEnabled || !phrase) return;
  const args = config.voiceName ? ['-v', config.voiceName, phrase] : [phrase];
  const child = spawn('say', args, { detached: true, stdio: 'ignore' });
  child.unref();
}

async function checkProxy() {
  const settings = getLauncherSettings();
  if (!isProxyConfigured(settings)) {
    appendLauncherLog('未配置代理，使用系统默认网络');
    return false;
  }

  appendLauncherLog('正在检查代理端口');
  try {
    await execFilePromise('nc', ['-z', settings.proxyHost, settings.proxyPort], { timeout: 5000 });
    appendLauncherLog('代理端口可用');
    return true;
  } catch (e) {
    appendLauncherLog('代理端口不可用，使用系统默认网络');
    return false;
  }
}

async function stopCodex(options = {}) {
  const settings = getLauncherSettings();
  const shouldSpeak = options.speak !== false;
  if (shouldSpeak) speakIfEnabled(config.stopVoiceText);

  if (!(await isCodexProcessRunning())) {
    return appendLauncherLog(`${settings.appName} 没有运行`);
  }

  appendLauncherLog(`正在关闭 ${settings.appName}`);
  try {
    await execFilePromise('osascript', ['-e', `tell application ${JSON.stringify(settings.appPath)} to quit`], { timeout: 10000 });
  } catch (e) {
    appendLauncherLog(`关闭请求失败: ${e.output || e.message}`);
  }
  await new Promise(resolve => setTimeout(resolve, 2000));
  return appendLauncherLog(`${settings.appName} 关闭请求已发送`);
}

async function startCodex() {
  const settings = getLauncherSettings();
  if (await isCodexProcessRunning()) {
    await execFilePromise('open', ['-a', settings.appPath]);
    return appendLauncherLog(`${settings.appName} 已在运行，已切到前台`);
  }
  speakIfEnabled(config.startVoiceText);

  if (!fs.existsSync(settings.exePath)) {
    appendLauncherLog(`没有找到 ChatGPT / Codex 应用: ${settings.exePath}`);
    throw new Error(`没有找到 ChatGPT / Codex 应用：${settings.exePath}`);
  }

  const useProxy = await checkProxy();

  fs.mkdirSync(path.dirname(settings.logFile), { recursive: true });
  fs.writeFileSync(settings.logFile, '', 'utf8');
  appendLauncherLog(`正在启动 ${settings.appName}`);

  const outFd = fs.openSync(settings.logFile, 'a');
  const launchArgs = useProxy
    ? [`--proxy-server=${settings.httpProxy}`, '--proxy-bypass-list=localhost;127.0.0.1;::1']
    : [];
  const launchEnv = {
    ...process.env,
    NO_PROXY: settings.noProxy,
    no_proxy: settings.noProxy
  };

  if (useProxy) {
    Object.assign(launchEnv, {
      HTTP_PROXY: settings.httpProxy,
      HTTPS_PROXY: settings.httpProxy,
      ALL_PROXY: settings.allProxy,
      http_proxy: settings.httpProxy,
      https_proxy: settings.httpProxy,
      all_proxy: settings.allProxy
    });
  }

  const child = spawn(settings.exePath, launchArgs, {
    detached: true,
    stdio: ['ignore', outFd, outFd],
    env: launchEnv
  });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }).finally(() => fs.closeSync(outFd));
  child.unref();

  return appendLauncherLog(`${settings.appName} 已启动，正在等待项目加载`);
}

async function readLauncherLog() {
  const settings = getLauncherSettings();
  if (!fs.existsSync(settings.logFile)) return '启动日志还不存在';
  const content = fs.readFileSync(settings.logFile, 'utf8');
  return content.split(/\r?\n/).slice(-80).join('\n').trim() || '启动日志为空';
}

function scanProcesses() {
  isCodexProcessRunning().then((isNowRunning) => {
    if (isNowRunning && !isCodexRunning) {
      isCodexRunning = true;
      if (config.syncLaunch && module.exports.onCodexDetected) module.exports.onCodexDetected();
      if (sessionMonitor.cursors.size === 0) {
        initLogWatchers(false).catch(sessionMonitor.onError);
      } else {
        syncCodexRolloutWatchers(false);
      }
    } else if (!isNowRunning && isCodexRunning) {
      isCodexRunning = false;
    }
  }).catch(() => {});
}
const processTimer = setInterval(scanProcesses, 3000);

async function runCodexLauncher(action) {
  const allowedActions = new Set(['start', 'stop', 'restart', 'status', 'log']);
  if (!allowedActions.has(action)) {
    return Promise.reject(new Error(`Unsupported action: ${action}`));
  }

  if (action === 'start') {
    return startCodex();
  }
  if (action === 'stop') {
    return stopCodex();
  }
  if (action === 'restart') {
    await stopCodex();
    return startCodex();
  }
  if (action === 'status') {
    return appendLauncherLog(`${getLauncherSettings().appName} ${(await isCodexProcessRunning()) ? '正在运行' : '没有运行'}`);
  }
  if (action === 'log') {
    return readLauncherLog();
  }
}

// API Endpoints
app.post('/api/event', (req, res) => {
  const { tool, state: newState, detail } = req.body;
  if (tool && newState) {
    updateAgentState(tool.toLowerCase(), newState, detail);
    res.json({ success: true });
  } else {
    res.status(400).json({ error: 'Missing params' });
  }
});

app.post('/api/refresh-status', (req, res) => {
  syncCodexRolloutWatchers(false);
  refreshCodexAccountQuota();
  broadcastCodexAggregate(true);
  res.json({ success: true });
});

app.post('/api/codex/:action', async (req, res) => {
  try {
    const output = await runCodexLauncher(req.params.action);
    if (req.params.action === 'start' || req.params.action === 'restart') {
      setTimeout(() => {
        syncCodexRolloutWatchers(false);
        broadcastCodexAggregate(true);
      }, 1500);
    }
    res.json({ success: true, output });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.output || error.message || '执行失败'
    });
  }
});

app.get('/api/codex/log', async (req, res) => {
  try {
    const output = await runCodexLauncher('log');
    res.type('text/plain').send(output);
  } catch (error) {
    res.status(500).type('text/plain').send(error.output || error.message || '读取日志失败');
  }
});

app.get('/api/status', (req, res) => res.json({ codex: getAggregateCodexState(), quota: state.quota }));

app.get('/api/config', (req, res) => res.json(config));
app.post('/api/config', (req, res) => {
  Object.assign(config, req.body);
  sanitizeConfig();
  applyAutomaticConfigDefaults();
  saveConfig();
  if ('codexRolloutDir' in req.body) initLogWatchers(true).catch(sessionMonitor.onError);
  if (module.exports.onConfigUpdated) module.exports.onConfigUpdated(config);
  broadcast('config', config);
  broadcastCodexAggregate(true);
  res.json({ success: true, config });
});

app.post('/api/widget-layout', (req, res) => {
  const count = req.body.count;
  if (!Number.isInteger(count) || count < 0 || count > 1000) return res.status(400).json({ error: 'Invalid conversation count' });
  if (module.exports.onWidgetLayout) module.exports.onWidgetLayout(count);
  res.json({ success: true });
});

app.post('/api/show-control', (req, res) => {
  if (module.exports.onShowControl) { module.exports.onShowControl(); res.json({ success: true }); }
  else res.json({ success: false });
});

app.post('/api/quit', (req, res) => {
  res.json({ success: true });
  if (module.exports.onQuitRequested) {
    module.exports.onQuitRequested();
  } else {
    process.exit(0);
  }
});

wss.on('connection', (ws) => {
  const aggregate = getAggregateCodexState();
  ws.send(JSON.stringify({ 
    type: 'status', 
    data: { codex: aggregate, quota: state.quota }, 
    config: config 
  }));
});

const ready = new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(PORT, '127.0.0.1', async () => {
    try {
      await initLogWatchers();
      refreshThreadMetadata();
      accountQuota.start();
      scanProcesses();
      console.log(`Monitor Service Live on ${SERVICE_URL}`);
      resolve();
    } catch (error) { reject(error); }
  });
});
function close() {
  sessionMonitor.stop();
  accountQuota.stop();
  [heartbeatTimer, metadataTimer, processTimer].forEach(clearInterval);
  wss.clients.forEach(client => client.terminate());
  wss.close();
  server.close();
}
if (require.main === module) {
  ready.catch(error => { console.error(error.message); close(); process.exit(1); });
  process.once('SIGTERM', () => { close(); process.exit(0); });
}

module.exports = {
  ready, url: SERVICE_URL, close,
  onCodexDetected: null,
  onConfigUpdated: null,
  getConfig: () => config,
  broadcastConfig: (newConfig) => {
    config = { ...config, ...newConfig };
    broadcast('config', config);
  }
};
