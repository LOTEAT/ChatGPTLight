(function (root, factory) {
  const model = factory();
  if (typeof module === 'object' && module.exports) module.exports = model;
  else root.CodexQuotaModel = model;
})(typeof window === 'undefined' ? globalThis : window, function () {
  function getView(quota) {
    const windows = ['primary', 'secondary'].map(key => ({
      minutes: quota?.[`${key}WindowMinutes`],
      remaining: quota?.[`${key}Remaining`],
      resetText: quota?.[`${key}ResetText`] || ''
    }));
    const fiveHour = windows.find(window => window.minutes === 300);
    const weekly = windows.find(window => window.minutes === 10080);
    const plan = String(quota?.planType || '').toLowerCase();
    const isPro = /^pro(?:$|[_-])/.test(plan);
    const percent = value => Number.isFinite(value) ? `${Math.round(Math.max(0, Math.min(100, value)))}%` : '--';
    const fiveHourText = `5 小时 ${isPro ? '100%' : percent(fiveHour?.remaining)}`;
    const weeklyText = `Weekly ${percent(weekly?.remaining)}`;
    const planLabel = isPro ? 'Pro' : plan === 'plus' ? 'Plus' : plan;
    return {
      fiveHourText,
      weeklyText,
      title: [planLabel, '百分比表示剩余额度',
        isPro ? '5 小时：不限额' : `${fiveHourText}${fiveHour?.resetText ? ` · 重置 ${fiveHour.resetText}` : ''}`,
        `${weeklyText}${weekly?.resetText ? ` · 重置 ${weekly.resetText}` : ''}`].filter(Boolean).join('\n')
    };
  }
  return { getView };
});
