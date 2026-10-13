document.addEventListener('DOMContentLoaded', () => {
  const strip = document.getElementById('widget-sessions');
  const root = document.getElementById('desktop-widget');
  const count = document.getElementById('widget-count');
  const note = document.getElementById('widget-note');
  const quotaTag = document.getElementById('widget-quota');
  const previous = document.getElementById('widget-prev');
  const next = document.getElementById('widget-next');
  let config = {};
  let widgetSessions = [];
  let displayed = [];
  let columns = 2;
  let page = 0;
  let connected = false;
  let quota = null;
  let lastLayoutCount = -1;
  let zoomTimer;
  const completionTracker = window.CodexCompletionSound.createTracker();
  const completionPlayer = window.CodexCompletionSound.createPlayer();
  // Browser-only use can unlock audio with a gesture; Electron permits it at startup.
  const unlockSound = () => completionPlayer.unlock().catch(error => console.error('无法启用提示音', error));
  window.addEventListener('pointerdown', unlockSound, { once: true });
  window.addEventListener('keydown', unlockSound, { once: true });

  function updateSessions(sessions) {
    widgetSessions = sessions;
    const completed = completionTracker.update(sessions);
    if (config.completionSoundEnabled === false) return;
    completed.forEach(() => {
      completionPlayer.play().catch(error => console.error('无法播放完成提示音', error));
    });
  }

  function applyConfig(value) {
    config = { ...config, ...value };
    if (config.completionSoundEnabled === false) completionPlayer.stop();
    const scale = Math.max(0.4, Math.min(2, Number(config.scale) || 1));
    root.style.transform = `scale(${scale})`;
    root.style.width = `${window.innerWidth / scale}px`;
  }

  function render() {
    displayed = widgetSessions;
    const pages = Math.max(1, Math.ceil(displayed.length / columns));
    page = Math.min(page, pages - 1);
    count.textContent = connected ? `${displayed.length} 个对话` : '连接已断开';
    note.textContent = config.widgetMode === 'manual' ? '手动选择 · 5 分钟无更新移除' : '5 分钟无更新自动移除';
    note.title = '按住 ⌘ 或 Ctrl 并滚动鼠标可缩放';
    const fragment = document.createDocumentFragment();
    const visible = displayed.slice(page * columns, (page + 1) * columns);
    visible.forEach(session => {
      const state = connected ? session.state : 'offline';
      const meta = window.CodexStatusMeta.get(state);
      const tile = document.createElement('article');
      tile.className = `conversation-tile state-${state}`;
      tile.dataset.sessionId = session.id;
      tile.dataset.state = state;
      const questionTime = session.lastUserMessageAt ? new Date(session.lastUserMessageAt).toLocaleString('zh-CN', { hour12: false }) : '未记录';
      tile.title = `${session.title}\n${session.project || '本地对话'}\n${session.detail}\n最后提问：${questionTime}\n对话 ID：${session.id}`;
      const lamp = document.createElement('span');
      lamp.className = 'conversation-lamp';
      lamp.setAttribute('aria-hidden', 'true');
      const title = document.createElement('h2');
      title.className = 'conversation-title';
      title.textContent = session.title || `对话 ${session.id.slice(0, 8)}`;
      const text = document.createElement('span');
      text.className = 'conversation-status';
      text.textContent = meta.shortText;
      const identity = document.createElement('span');
      identity.className = 'conversation-identity';
      identity.textContent = `${session.project || '对话'} · ${session.id.slice(-4)}`;
      tile.append(lamp, title, text, identity);
      fragment.appendChild(tile);
    });
    if (!visible.length) {
      const empty = document.createElement('p');
      empty.className = 'strip-empty';
      empty.textContent = !connected ? '状态服务连接已断开，正在重连…' :
        config.widgetMode === 'manual' ? '点击“设置”，勾选要显示的灯。' : '运行中的对话会自动加入，也可点击“设置”。';
      fragment.appendChild(empty);
    }
    strip.replaceChildren(fragment);
    strip.style.gridTemplateColumns = `repeat(${columns}, 128px)`;
    document.getElementById('widget-page').textContent = `${page + 1} / ${pages}`;
    previous.disabled = page === 0;
    next.disabled = page >= pages - 1;
    const showQuota = ['both', 'widget'].includes(config.quotaDisplay || 'widget');
    quotaTag.classList.toggle('hidden', !showQuota);
    note.classList.toggle('hidden', showQuota);
    const quotaView = window.CodexQuotaModel.getView(quota);
    document.getElementById('widget-quota-five-hour').textContent = quotaView.fiveHourText;
    document.getElementById('widget-quota-weekly').textContent = quotaView.weeklyText;
    quotaTag.title = quotaView.title;
    if (displayed.length !== lastLayoutCount) {
      lastLayoutCount = displayed.length;
      fetch('/api/widget-layout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ count: displayed.length }) }).catch(() => {});
    }
  }

  function resize() {
    applyConfig(config);
    const scale = Math.max(0.4, Math.min(2, Number(config.scale) || 1));
    columns = window.CodexWidgetModel.getColumns(window.innerWidth, scale);
    render();
  }
  previous.addEventListener('click', () => { page = Math.max(0, page - 1); render(); });
  next.addEventListener('click', () => { page++; render(); });
  document.getElementById('btn-open-control').addEventListener('click', async () => {
    try {
      const result = await fetch('/api/show-control', { method: 'POST' }).then(response => response.json());
      if (!result.success) window.open('/index.html', '_blank');
    } catch (_) {}
  });
  document.getElementById('btn-close-app').addEventListener('click', () => {
    fetch('/api/quit', { method: 'POST' }).catch(() => {});
  });
  window.addEventListener('resize', resize);
  window.addEventListener('wheel', event => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    const scale = Math.round(Math.max(0.4, Math.min(2, (Number(config.scale) || 1) + (event.deltaY > 0 ? -0.1 : 0.1))) * 10) / 10;
    applyConfig({ scale });
    clearTimeout(zoomTimer);
    zoomTimer = setTimeout(() => fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scale }) }).catch(() => {}), 150);
  }, { passive: false });

  function connect() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${location.host}`);
    ws.onopen = () => { connected = true; render(); };
    ws.onmessage = event => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'status') {
          applyConfig(message.config || message.data.config || {});
          updateSessions(message.data.codex.widgetSessions || []);
          quota = message.data.quota ?? null;
        } else if (message.type === 'event' && message.data.agent === 'codex') {
          updateSessions(message.data.widgetSessions || []);
          quota = message.data.quota ?? null;
        } else if (message.type === 'config') applyConfig(message.data);
        else if (message.type === 'quota') quota = message.data;
        resize();
      } catch (error) { console.error(error); }
    };
    ws.onclose = () => { connected = false; completionTracker.reset(); render(); setTimeout(connect, 3000); };
  }
  resize();
  connect();
});
