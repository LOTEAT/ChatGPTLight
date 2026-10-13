const fs = require('node:fs/promises');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
const { classifyEntry, getUserQuestionTime } = require('./session-state');

async function findRollouts(directory, limit) {
  const candidates = [];
  async function visit(folder, depth) {
    let entries;
    try { entries = await fs.readdir(folder, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory() && depth < 3 && /^\d+$/.test(entry.name)) await visit(file, depth + 1);
      else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) {
        try { candidates.push({ file, stats: await fs.stat(file) }); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
  }
  await visit(directory, 0);
  return candidates.sort((a, b) => b.stats.mtimeMs - a.stats.mtimeMs || a.file.localeCompare(b.file)).slice(0, limit);
}

function newCursor(file, stats) {
  const id = path.basename(file, '.jsonl').slice(-36);
  return { file, inode: stats.ino, mtime: stats.mtimeMs, offset: 0, fragment: '', decoder: new StringDecoder('utf8'),
    session: { id, title: `对话 ${id.slice(0, 8)}`, project: '', isSubagent: false,
      createdAt: null, lastUserMessageAt: null, state: 'unknown', detail: '日志中尚无可识别状态', lastActive: stats.mtimeMs },
    quotaEntry: null };
}

function applyEntry(cursor, entry, historical) {
  const payload = entry.payload || {};
  const session = cursor.session;
  if (entry.type === 'session_meta') {
    session.id = payload.id || session.id;
    session.title = payload.thread_name || payload.title || `对话 ${String(session.id).slice(0, 8)}`;
    session.project = payload.cwd ? path.basename(payload.cwd) : '';
    session.isSubagent = !!payload.source?.subagent;
    session.createdAt = Date.parse(payload.timestamp || entry.timestamp) || null;
  }
  const question = getUserQuestionTime(entry);
  if (question !== null) session.lastUserMessageAt = Math.max(session.lastUserMessageAt || 0, question);
  const transition = classifyEntry(entry);
  if (transition) Object.assign(session, transition);
  if (!historical) session.lastActive = Date.parse(entry.timestamp) || Date.now();
  if (payload.type === 'token_count' && payload.rate_limits) cursor.quotaEntry = entry;
}

// One scheduler reads only appended bytes. UTF-8 and partial JSON lines survive across reads.
class SessionMonitor {
  constructor({ directory, limit = 100, pollMs = 250, discoveryMs = 1500,
    onSession = () => {}, onRemove = () => {}, onError = () => {} }) {
    Object.assign(this, { directory, limit, pollMs, discoveryMs, onSession, onRemove, onError });
    this.cursors = new Map();
    this.generation = 0;
    this.stopped = true;
  }

  async start() { await this.reset(this.directory); }

  async reset(directory) {
    this.stop();
    if (this.pending) await this.pending.catch(() => {});
    for (const file of this.cursors.keys()) this.onRemove(file);
    this.cursors.clear();
    this.directory = directory;
    this.lastDiscovery = 0;
    this.stopped = false;
    await this.poll(true);
    if (!this.stopped) this.timer = setInterval(() => this.poll().catch(this.onError), this.pollMs);
  }

  poll(forceDiscovery = false) {
    if (this.stopped) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = this.readChanges(forceDiscovery).finally(() => { this.pending = null; });
    return this.pending;
  }

  async readChanges(forceDiscovery) {
    const generation = this.generation;
    const current = () => !this.stopped && generation === this.generation;
    if (forceDiscovery || Date.now() - this.lastDiscovery >= this.discoveryMs) {
      const files = await findRollouts(this.directory, this.limit);
      if (!current()) return;
      this.lastDiscovery = Date.now();
      const available = new Set(files.map(value => value.file));
      for (const file of this.cursors.keys()) {
        if (!available.has(file)) { this.cursors.delete(file); this.onRemove(file); }
      }
      for (const { file, stats } of files) {
        if (!current()) return;
        if (!this.cursors.has(file)) {
          try { await this.seed(file, stats, current); }
          catch (error) { if (error.code !== 'ENOENT') this.onError(error); }
        }
      }
    }
    for (const [file, cursor] of this.cursors) {
      if (!current()) return;
      try {
        const stats = await fs.stat(file);
        if (!current()) return;
        if (stats.ino !== cursor.inode || stats.size < cursor.offset ||
            (stats.size === cursor.offset && stats.mtimeMs !== cursor.mtime)) {
          await this.seed(file, stats, current);
        } else if (stats.size > cursor.offset) {
          await this.readTo(cursor, stats.size, false, current);
          cursor.mtime = stats.mtimeMs;
        }
      } catch (error) {
        if (!current()) return;
        if (error.code === 'ENOENT') { this.cursors.delete(file); this.onRemove(file); }
        else this.onError(error);
      }
    }
  }

  async seed(file, stats, current) {
    const cursor = newCursor(file, stats);
    await this.readTo(cursor, stats.size, true, current);
    if (!current()) return;
    this.cursors.set(file, cursor);
    this.onSession(file, { ...cursor.session }, cursor.quotaEntry, true);
  }

  async readTo(cursor, end, historical, current) {
    const handle = await fs.open(cursor.file, 'r');
    try {
      const chunk = Buffer.alloc(64 * 1024);
      while (current() && cursor.offset < end) {
        const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, end - cursor.offset), cursor.offset);
        if (!bytesRead || !current()) break;
        cursor.offset += bytesRead;
        const lines = (cursor.fragment + cursor.decoder.write(chunk.subarray(0, bytesRead))).split('\n');
        cursor.fragment = lines.pop();
        for (const line of lines) {
          let entry;
          try { entry = JSON.parse(line); } catch (_) { continue; }
          if (!entry || typeof entry !== 'object') continue;
          applyEntry(cursor, entry, historical);
          if (!historical) this.onSession(cursor.file, { ...cursor.session }, entry, false);
        }
      }
    } finally { await handle.close(); }
  }

  stop() {
    this.stopped = true;
    this.generation++;
    clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { SessionMonitor, findRollouts };
