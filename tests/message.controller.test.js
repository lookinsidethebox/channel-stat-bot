const assert = require('node:assert/strict');
const test = require('node:test');
const registerMessageController = require('../src/controllers/message.controller');

test('replies with the bot status and monthly buttons to messages', async () => {
  let registeredType;
  let messageHandler;
  const actions = {};

  registerMessageController({
    action(name, handler) { actions[name] = handler; },
    on(type, handler) {
      registeredType = type;
      messageHandler = handler;
    },
  });

  assert.equal(registeredType, 'message');

  for (const text of ['Hi there', '/start']) {
    const replies = [];
    await messageHandler({
      message: { text },
      reply: async (...args) => replies.push(args),
    });

    assert.deepEqual(replies, [['✅ Бот работает', { reply_markup: { inline_keyboard: [
      [{ text: 'Показать статистику за этот месяц', callback_data: 'stats_month_current' }],
      [{ text: 'Показать статистику за прошлый месяц', callback_data: 'stats_month_previous' }],
    ] } }]]);
  }
  const offsets = [];
  registerMessageController({ action(name, handler) { actions[name] = handler; }, on() {} }, {
    getMonthlyStats: async offset => { offsets.push(offset); return 'report'; },
  });
  for (const name of ['stats_month_current', 'stats_month_previous']) {
    const replies = [];
    await actions[name]({ answerCbQuery: async () => {}, reply: async (...args) => replies.push(args) });
    assert.equal(replies[0][0], 'report');
    assert.equal(replies[0][1].parse_mode, 'HTML');
  }
  assert.deepEqual(offsets, [0, -1]);
});
