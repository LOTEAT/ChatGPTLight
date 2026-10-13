const test = require('node:test');
const assert = require('node:assert/strict');
const { getView } = require('../public/quota-model');

test('Pro with only a weekly primary window shows unlimited five-hour usage and real weekly remaining', () => {
  const view = getView({ planType: 'pro', primaryWindowMinutes: 10080, primaryRemaining: 98, primaryResetText: '10/20 13:01' });
  assert.equal(view.fiveHourText, '5 小时 100%');
  assert.equal(view.weeklyText, 'Weekly 98%');
  assert.match(view.title, /Pro\n/);
  assert.match(view.title, /5 小时：不限额/);
  assert.match(view.title, /重置 10\/20 13:01/);
});

test('Plus shows both real windows and identifies them by duration regardless of ordering', () => {
  for (const reversed of [false, true]) {
    const view = getView({ planType: 'plus',
      primaryWindowMinutes: reversed ? 10080 : 300, primaryRemaining: reversed ? 46 : 82,
      secondaryWindowMinutes: reversed ? 300 : 10080, secondaryRemaining: reversed ? 82 : 46 });
    assert.equal(view.fiveHourText, '5 小时 82%');
    assert.equal(view.weeklyText, 'Weekly 46%');
  }
});

test('missing or unrecognized windows are unknown instead of fabricated remaining quota', () => {
  for (const quota of [null, {}, { planType: 'plus', primaryRemaining: 98 },
    { primaryWindowMinutes: 60, primaryRemaining: 98 }]) {
    const view = getView(quota);
    assert.equal(view.fiveHourText, '5 小时 --');
    assert.equal(view.weeklyText, 'Weekly --');
  }
  assert.equal(getView({ planType: 'pro' }).weeklyText, 'Weekly --');
});

test('Pro five-hour display stays at 100% while weekly changes', () => {
  const quota = { planType: 'pro', primaryWindowMinutes: 300, primaryRemaining: 20, secondaryWindowMinutes: 10080, secondaryRemaining: 60 };
  assert.equal(getView(quota).fiveHourText, '5 小时 100%');
  assert.equal(getView(quota).weeklyText, 'Weekly 60%');
  assert.equal(getView({ ...quota, secondaryRemaining: 59 }).weeklyText, 'Weekly 59%');
});
