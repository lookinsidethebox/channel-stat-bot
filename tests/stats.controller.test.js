const assert = require('node:assert/strict');
const test = require('node:test');
const registerStatsController = require('../src/controllers/stats.controller');

function handler(options) {
  let callback;
  registerStatsController({ command: (command, action) => {
    assert.equal(command, 'stats');
    callback = action;
  } }, options);
  return callback;
}

test('stats explains missing access instead of returning the bot status', async () => {
  const replies = [];
  await handler({})({ reply: async text => replies.push(text) });
  assert.deepEqual(replies, ['Статистика недоступна: аккаунт Telegram для чтения счётчиков не подключён.']);
});

test('stats sends one error message when reading fails without exposing request details', async () => {
  const replies = [];
  const errors = [];
  await handler({ getStats: async () => { throw new Error('Request failed: private credentials'); },
    logger: { error: (...args) => errors.push(args) },
  })({ reply: async text => replies.push(text) });
  assert.deepEqual(replies, ['Не удалось получить статистику. Попробуй ещё раз позже.']);
  assert.deepEqual(errors, [['Stats command failed:', 'STATS_FAILED']]);
});

test('stats reply failures propagate without sending a second message', async () => {
  let attempts = 0;
  const error = new Error('Send failed');
  await assert.rejects(handler({ getStats: async () => 'Summary' })({ reply: async () => {
    attempts++;
    throw error;
  } }), actual => actual === error);
  assert.equal(attempts, 1);
});
