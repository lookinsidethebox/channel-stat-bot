const assert = require('node:assert/strict');
const test = require('node:test');
const registerMessageController = require('../src/controllers/message.controller');

test('replies with the bot status to text messages and commands', async () => {
  let registeredType;
  let textHandler;

  registerMessageController({
    on(type, handler) {
      registeredType = type;
      textHandler = handler;
    },
  });

  assert.equal(registeredType, 'text');

  for (const text of ['Hi there', '/start']) {
    const replies = [];
    await textHandler({
      message: { text },
      reply: async (message) => replies.push(message),
    });

    assert.deepEqual(replies, ['✅ Бот работает']);
  }
});
