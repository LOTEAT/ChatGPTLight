const STALE_MS = 120000;
const permissionTypes = new Set(['exec_approval_request', 'apply_patch_approval_request', 'request_user_input', 'tool_request_user_input', 'elicitation_request', 'ask_user', 'user_intervention']);
const toolTypes = new Set(['custom_tool_call', 'function_call', 'web_search_call', 'tool_call', 'patch_apply_start']);
const outputTypes = new Set(['custom_tool_call_output', 'function_call_output', 'tool_call_output', 'web_search_end', 'patch_apply_end', 'mcp_tool_call_end']);

function getUserQuestionTime(entry) {
  // Canonical user events distinguish real messages from injected/replayed context.
  // task_started also occurs for automatic continuations, so it must not move a lamp.
  if (entry?.type !== 'event_msg' || entry.payload?.type !== 'user_message') return null;
  const timestamp = Date.parse(entry.timestamp);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
}

function classifyEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const payload = entry.payload || entry;
  if (entry.type === 'compacted') return { state: 'thinking', detail: '正在压缩上下文' };
  if (!['response_item', 'event_msg', 'tool_call'].includes(entry.type)) return null;
  if (permissionTypes.has(payload.type) || payload.status === 'requires_action' ||
      (toolTypes.has(payload.type) && /(?:^|[._])(?:request_user_input(?:_async)?|ask_user)$/.test(payload.name || ''))) {
    return { state: 'permission', detail: '等待你的确认或回复' };
  }
  if (payload.type === 'turn_aborted' || payload.status === 'interrupted') return { state: 'interrupted', detail: '本轮已停止' };
  if (payload.type === 'error' || ['failed', 'error'].includes(payload.status)) return { state: 'error', detail: `错误：${String(payload.message || '执行失败').slice(0, 160)}` };
  if (['task_complete', 'task_completed'].includes(payload.type) || (['agent_message', 'message'].includes(payload.type) && payload.phase === 'final_answer')) {
    return { state: 'finished', detail: '本轮已完成' };
  }
  if (['reasoning', 'task_started', 'user_message', 'thread_goal_updated'].includes(payload.type)) return { state: 'thinking', detail: '正在思考' };
  if (toolTypes.has(payload.type)) return { state: 'executing', detail: `正在执行：${String(payload.name || payload.tool || '工具').slice(0, 100)}` };
  if (outputTypes.has(payload.type)) return { state: 'executing', detail: '正在处理工具结果' };
  if (['agent_message', 'message'].includes(payload.type) && payload.role !== 'user') return { state: 'executing', detail: '正在输出回复' };
  return null;
}

function snapshotSession(session, now = Date.now()) {
  const stale = ['thinking', 'executing'].includes(session.state) && now - session.lastActive > STALE_MS;
  return { ...session, state: stale ? 'unknown' : session.state, lastKnownState: session.state,
    detail: stale ? `暂未收到新事件 · 最近状态：${session.state === 'thinking' ? '思考中' : '执行中'}` : session.detail,
    stale };
}

module.exports = { classifyEntry, snapshotSession, getUserQuestionTime, STALE_MS };
