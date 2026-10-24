const assert = require('node:assert/strict');
const test = require('node:test');
const { createBot } = require('../src/bot');

const config = { token: 'test-token', ownerId: '123', channelId: '-100456', sourceStatistics: {} };

function update(id, text, updateId) {
  return { update_id: updateId, message: {
    message_id: updateId, date: 1, from: { id, first_name: 'Test', is_bot: false },
    chat: { id, type: 'private' }, text,
    entities: text.startsWith('/') ? [{ type: 'bot_command', offset: 0, length: text.split(/\s/)[0].length }] : [],
  } };
}

function harness({ members = [], resolveUsername = async () => 456 } = {}) {
  const replies = [];
  const requests = [];
  const errors = [];
  const bot = createBot(config, {
    statisticsReader: { resolveUsername },
    logger: { log() {}, error: (...args) => errors.push(args) },
  });
  bot.botInfo = { id: 999, username: 'test_bot', first_name: 'Test', is_bot: true };
  bot.context.telegram = {
    sendMessage: async (_id, text) => { replies.push(text); return { message_id: replies.length }; },
    callApi: async (method, params) => {
      requests.push([method, params]);
      const member = members.shift();
      if (member instanceof Error) throw member;
      return member;
    },
  };
  return { bot, replies, requests, errors };
}

test('/check resolves usernames and keeps checking until cancelled', async () => {
  let resolved;
  const h = harness({ members: [{ status: 'member' }, { status: 'left' }], resolveUsername: async username => {
    resolved = username;
    return 456;
  } });
  await h.bot.handleUpdate(update(123, '/check', 1));
  await h.bot.handleUpdate(update(123, '@Lisa_948', 2));
  assert.equal(resolved, 'Lisa_948');
  assert.deepEqual(h.requests, [['getChatMember', { chat_id: config.channelId, user_id: 456 }]]);
  assert.equal(h.replies.at(-1), '✅ Пользователь есть на канале');
  await h.bot.handleUpdate(update(123, '456', 3));
  assert.equal(h.replies.at(-1), '🚫 Пользователя нет на канале');
  await h.bot.handleUpdate(update(123, '/cancel', 4));
  assert.equal(h.replies.at(-1), 'Проверка отменена.');
  await h.bot.handleUpdate(update(123, '456', 5));
  assert.equal(h.replies.at(-1), '✅ Бот работает');
});

test('/check accepts a numeric ID and distinguishes absent and restricted members', async () => {
  const h = harness({ members: [
    { status: 'left' }, { status: 'kicked' }, { status: 'restricted', is_member: false },
    { status: 'restricted', is_member: true }, { status: 'administrator' },
  ] });
  for (const [index, expected] of [
    '🚫 Пользователя нет на канале', '🚫 Пользователя нет на канале',
    '🚫 Пользователя нет на канале', '✅ Пользователь есть на канале',
    '✅ Пользователь есть на канале',
  ].entries()) {
    await h.bot.handleUpdate(update(123, '/check 456', index + 1));
    assert.equal(h.replies.at(-1), expected);
  }
  assert.ok(h.requests.every(([, params]) => params.user_id === 456));
});

test('/check rejects invalid input and never claims absence when Telegram fails', async () => {
  const h = harness({ members: [new Error('TELEGRAM_UNAVAILABLE'), { status: 'member' }] });
  await h.bot.handleUpdate(update(123, '/check', 1));
  await h.bot.handleUpdate(update(123, '123 456', 2));
  assert.equal(h.requests.length, 0);
  await h.bot.handleUpdate(update(123, '456', 3));
  assert.equal(h.replies.at(-1), 'Не удалось проверить подписку. Попробуй ещё раз позже.');
  await h.bot.handleUpdate(update(123, '456', 4));
  assert.equal(h.replies.at(-1), '✅ Пользователь есть на канале');
  assert.equal(h.errors.length, 1);
});

test('/check logs the Bot API error that prevented a membership check', async () => {
  const error = new Error('400: Bad Request: user not found');
  error.response = { error_code: 400, description: 'Bad Request: user not found' };
  const h = harness({ members: [error] });
  await h.bot.handleUpdate(update(123, '/check 456', 1));
  assert.equal(h.replies.at(-1), 'Не удалось проверить подписку. Попробуй ещё раз позже.');
  assert.deepEqual(h.errors, [['Channel membership lookup failed:', '400: Bad Request: user not found']]);
});

test('/check treats PARTICIPANT_ID_INVALID as absence for username and numeric ID', async () => {
  const invalidParticipant = () => {
    const error = new Error('400: Bad Request: PARTICIPANT_ID_INVALID');
    error.response = { error_code: 400, description: 'Bad Request: PARTICIPANT_ID_INVALID' };
    return error;
  };
  const h = harness({ members: [invalidParticipant(), invalidParticipant()] });
  await h.bot.handleUpdate(update(123, '/check @Pine_Beach', 1));
  assert.equal(h.replies.at(-1), '🚫 Пользователя нет на канале');
  await h.bot.handleUpdate(update(123, '456', 2));
  assert.equal(h.replies.at(-1), '🚫 Пользователя нет на канале');
  assert.deepEqual(h.requests.map(([, params]) => params.user_id), [456, 456]);
  assert.deepEqual(h.errors, []);
});

test('/check does not claim absence when username resolution is unavailable', async () => {
  const h = harness({ resolveUsername: async () => { throw new Error('AUTH_KEY_UNREGISTERED'); } });
  await h.bot.handleUpdate(update(123, '/check', 1));
  await h.bot.handleUpdate(update(123, '@Lisa_948', 2));
  assert.equal(h.replies.at(-1), 'Не удалось проверить пользователя. Попробуй ещё раз позже.');
  assert.equal(h.requests.length, 0);
});

test('/check handles an unoccupied username, cancels on another command and ignores strangers', async () => {
  const h = harness({ resolveUsername: async () => { throw new Error('USERNAME_NOT_OCCUPIED'); } });
  await h.bot.handleUpdate(update(456, '/check', 1));
  assert.deepEqual(h.replies, []);
  await h.bot.handleUpdate(update(123, '/check', 2));
  await h.bot.handleUpdate(update(123, '@unused_name', 3));
  assert.equal(h.replies.at(-1), '🚫 Пользователя нет на канале');
  assert.equal(h.requests.length, 0);
  await h.bot.handleUpdate(update(123, '/check', 4));
  await h.bot.handleUpdate(update(123, '/start', 5));
  assert.equal(h.replies.at(-1), '✅ Бот работает');
  await h.bot.handleUpdate(update(123, '456', 6));
  assert.equal(h.replies.at(-1), '✅ Бот работает');
});
