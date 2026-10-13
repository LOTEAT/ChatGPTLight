document.addEventListener('DOMContentLoaded', () => {
  const byId = id => document.getElementById(id);
  const mode = byId('widget-mode');
  const scale = byId('scale-slider');
  const quota = byId('show-quota');
  const sound = byId('play-completion-sound');
  const search = byId('session-search');
  const filter = byId('session-filter');
  const list = byId('session-list');
  const feedback = byId('save-feedback');
  const connection = byId('codex-ws-status');
  const paths = { codexRolloutDir: byId('codex-log-path'), codexAppPath: byId('codex-app-path') };
  let config = {};
  let sessions = [];
  let widgetSessions = [];
  let loaded = false;
  let saveQueue = Promise.resolve();
  let pendingCount = 0;
  let closing = false;
  let saveFailed = false;
  let revision = 0;
  const pending = new Map();

  function notify(text, error = false) {
    feedback.textContent = text;
    feedback.classList.toggle('error', error);
  }

  function relativeTime(timestamp) {
    if (!timestamp) return '等待活动';
    const seconds = Math.max(0, (Date.now() - timestamp) / 1000);
    if (seconds < 60) return '刚刚更新';
    if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
    return `${Math.floor(seconds / 86400)} 天前`;
  }

  function renderSessions() {
    const pins = config.widgetPinnedSessionIds || [];
    const hidden = new Set(config.widgetHiddenSessionIds || []);
    const chosen = new Set((config.widgetMode === 'manual' ? pins : [...widgetSessions.map(session => session.id), ...pins]).filter(id => !hidden.has(id)));
    const query = search.value.trim().toLocaleLowerCase();
    const visible = sessions.filter(session =>
      (filter.value === 'all' || Date.now() - session.lastActive < 300000 || pins.includes(session.id)) &&
      `${session.title} ${session.project} ${session.id}`.toLocaleLowerCase().includes(query)).sort(window.CodexWidgetModel.compareQuestionTime);
    byId('sessions-count').textContent = `${widgetSessions.length} 个灯`;
    const fragment = document.createDocumentFragment();
    if (!visible.length) {
      const empty = document.createElement('p');
      empty.className = 'session-empty';
      empty.textContent = query ? '没有匹配的对话' : filter.value === 'recent' ? '最近 5 分钟没有活动对话。新活动出现时会自动显示。' : '尚未发现本地对话，请在 ChatGPT 中启动一个 Codex 任务。';
      fragment.append(empty);
    }
    visible.forEach(session => {
      const row = document.createElement('article');
      row.className = `session-row session-${session.state}`;
      const label = document.createElement('label');
      label.className = 'session-widget-choice';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.dataset.sessionId = session.id;
      checkbox.checked = chosen.has(session.id);
      checkbox.disabled = !loaded;
      checkbox.setAttribute('aria-label', `在悬浮灯显示 ${session.title || session.id}`);
      checkbox.addEventListener('change', () => {
        const pins = new Set(config.widgetPinnedSessionIds || []);
        const hidden = new Set(config.widgetHiddenSessionIds || []);
        if (checkbox.checked) { pins.add(session.id); hidden.delete(session.id); }
        else { pins.delete(session.id); hidden.add(session.id); }
        save({ widgetPinnedSessionIds: [...pins], widgetHiddenSessionIds: [...hidden] });
      });
      const dot = document.createElement('span');
      dot.className = 'session-dot';
      dot.setAttribute('aria-hidden', 'true');
      const content = document.createElement('div');
      content.className = 'session-content';
      const title = document.createElement('h3');
      title.textContent = session.title || `对话 ${session.id.slice(0, 8)}`;
      title.title = `${title.textContent}\n${session.id}`;
      const info = document.createElement('div');
      info.className = 'session-info';
      info.textContent = `${session.project || '本地对话'} · ${relativeTime(session.lastActive)}`;
      const badge = document.createElement('span');
      badge.className = 'session-badge';
      badge.textContent = window.CodexStatusMeta.get(session.state).shortText;
      content.append(title, info);
      label.append(checkbox, dot, content, badge);
      row.append(label);
      fragment.append(row);
    });
    const scroll = list.scrollTop;
    list.replaceChildren(fragment);
    list.scrollTop = scroll;
  }

  function applyConfig(incoming) {
    config = { ...config, ...incoming, ...Object.fromEntries([...pending].map(([key, entry]) => [key, entry.value])) };
    mode.value = config.widgetMode || 'auto';
    scale.value = config.scale || 1;
    byId('scale-value-display').textContent = `${Math.round(Number(scale.value) * 100)}%`;
    quota.checked = ['both', 'widget'].includes(config.quotaDisplay || 'widget');
    sound.checked = config.completionSoundEnabled !== false;
    Object.entries(paths).forEach(([key, input]) => { if (document.activeElement !== input) input.value = config[key] || ''; });
    [mode, scale, quota, sound, ...Object.values(paths)].forEach(input => { input.disabled = !loaded; });
    renderSessions();
  }

  function save(patch) {
    const id = ++revision;
    Object.entries(patch).forEach(([key, value]) => pending.set(key, { value, id }));
    pendingCount++;
    saveFailed = false;
    applyConfig(patch);
    notify('保存中…');
    saveQueue = saveQueue.then(async () => {
      try {
        const response = await fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
        if (!response.ok) throw new Error('保存失败，请再试一次。');
        const saved = await response.json();
        Object.keys(patch).forEach(key => { if (pending.get(key)?.id === id) pending.delete(key); });
        applyConfig(saved.config || saved);
      } catch (error) {
        saveFailed = true;
        notify(error.message || '保存失败，请再试一次。', true);
      } finally {
        pendingCount--;
        if (!pendingCount && !saveFailed) notify('已保存');
      }
    });
    return saveQueue;
  }

  mode.addEventListener('change', () => {
    save({ widgetMode: mode.value });
    if (mode.value === 'manual') byId('conversation-settings').open = true;
  });
  scale.addEventListener('input', () => save({ scale: Number(scale.value) }));
  quota.addEventListener('change', () => save({ quotaDisplay: quota.checked ? 'widget' : 'hidden' }));
  sound.addEventListener('change', () => save({ completionSoundEnabled: sound.checked }));
  Object.entries(paths).forEach(([key, input]) => input.addEventListener('change', () => save({ [key]: input.value.trim() })));
  search.addEventListener('input', renderSessions);
  filter.addEventListener('change', renderSessions);
  byId('btn-close-settings').addEventListener('click', async () => {
    document.activeElement?.blur();
    await saveQueue;
    if (!saveFailed) window.close();
  });
  window.addEventListener('beforeunload', event => {
    if (!pendingCount) return;
    event.preventDefault();
    event.returnValue = false;
    if (closing) return;
    closing = true;
    saveQueue.then(() => { closing = false; if (!saveFailed) window.close(); });
  });

  function updateSessions(data) {
    if (!data?.sessions) return;
    sessions = data.sessions;
    widgetSessions = data.widgetSessions || [];
    renderSessions();
  }
  function connect() {
    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`);
    socket.onopen = () => { connection.textContent = '正在监测'; connection.classList.add('online'); };
    socket.onmessage = event => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'config') applyConfig(message.data);
        else if (message.type === 'status') {
          const incoming = message.config || message.data.config;
          if (incoming) applyConfig(incoming);
          updateSessions(message.data.codex);
        } else if (message.type === 'event' && message.data.agent === 'codex') updateSessions(message.data);
      } catch { notify('状态更新失败，正在等待下一次更新。', true); }
    };
    socket.onclose = () => {
      connection.textContent = '连接断开，正在重连…';
      connection.classList.remove('online');
      setTimeout(connect, 3000);
    };
    socket.onerror = () => socket.close();
  }
  fetch('/api/config').then(response => {
    if (!response.ok) throw new Error('设置读取失败，请重新打开设置。');
    return response.json();
  }).then(incoming => { loaded = true; applyConfig(incoming); }).catch(error => notify(error.message, true));
  connect();
});
