(function () {
  const meta = {
    permission: {
      light: 'red',
      flash: true,
      text: '等待确认 / 回复',
      shortText: '待确认',
      textClass: 'red-text',
      tagClass: 'red-glow',
      logType: 'error'
    },
    error: {
      light: 'red',
      flash: false,
      text: '错误 / 阻塞',
      shortText: '错误/阻塞',
      textClass: 'red-text',
      tagClass: 'red-glow',
      logType: 'error'
    },
    executing: {
      light: 'red',
      flash: false,
      text: '执行中',
      shortText: '执行中',
      textClass: 'red-text',
      tagClass: 'red-glow',
      logType: 'codex'
    },
    thinking: {
      light: 'orange',
      flash: false,
      text: '思考中',
      shortText: '思考中',
      textClass: 'orange-text',
      tagClass: 'orange-glow',
      logType: 'codex'
    },
    finished: {
      light: 'green',
      flash: false,
      text: '已完成 / 空闲中',
      shortText: '已完成',
      textClass: 'green-text',
      tagClass: 'green-glow',
      logType: ''
    },
    unknown: { light: 'offline', flash: false, text: '状态待确认', shortText: '待确认状态', textClass: 'offline-text', tagClass: '', logType: '' },
    interrupted: { light: 'offline', flash: false, text: '已停止', shortText: '已停止', textClass: 'offline-text', tagClass: '', logType: '' },
    offline: {
      light: 'offline',
      flash: false,
      text: '离线',
      shortText: '离线',
      textClass: 'offline-text',
      tagClass: '',
      logType: 'error'
    }
  };

  function get(state) {
    return meta[state] || meta.unknown;
  }

  function redCount(counts) {
    if (!counts) return 0;
    return (counts.permission || 0) + (counts.error || 0) + (counts.executing || 0);
  }

  window.CodexStatusMeta = { get, redCount };
})();
