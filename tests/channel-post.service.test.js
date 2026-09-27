const assert = require('node:assert/strict');
const test = require('node:test');
const { fetchChannelPostAt } = require('../src/services/channel-post.service');

const config = { ownerId: '123', channelId: '-100456', occurredAt: '2026-09-27T12:00:00.000Z' };
const eventTime = Date.parse(config.occurredAt) / 1000;

function post(messageId, offset = -100, extra = {}) {
  return { message_id: messageId, date: eventTime + offset, chat: { id: -100456 }, text: 'Existing post', ...extra };
}

function telegramWith(posts, personalChannelId = -100456) {
  const calls = [];
  return {
    calls,
    callApi: async (method, params, { signal }) => {
      assert.ok(signal instanceof AbortSignal);
      calls.push([method, params]);
      if (method === 'getChat') return { personal_chat: { id: personalChannelId } };
      assert.equal(method, 'getUserPersonalChatMessages');
      return posts;
    },
  };
}

test('requests existing channel posts and picks the latest publication before the event', async () => {
  const telegram = telegramWith([post(1), post(3, 10), post(2, -50, { caption: '😀'.repeat(101), text: undefined })]);
  const snapshot = await fetchChannelPostAt(telegram, config);
  assert.deepEqual(snapshot, {
    messageId: 2,
    postedAt: new Date((eventTime - 50) * 1000).toISOString(),
    preview: '😀'.repeat(100),
  });
  assert.deepEqual(telegram.calls, [
    ['getChat', { chat_id: '123' }],
    ['getUserPersonalChatMessages', { user_id: 123, limit: 20 }],
  ]);
});

test('does not use a different channel from the owner profile', async () => {
  const telegram = telegramWith([post(1)], -100789);
  await assert.rejects(fetchChannelPostAt(telegram, config), /профиле Telegram/);
  assert.equal(telegram.calls.length, 1);
});

test('rejects an unexpected response instead of attaching the wrong post', async () => {
  for (const posts of [null, {}, [post(1, -100, { chat: { id: -100789 } })], [post(0)]]) {
    await assert.rejects(fetchChannelPostAt(telegramWith(posts), config), /неожиданные данные/);
  }
});

test('returns null for an empty channel and a null preview for a post without text', async () => {
  assert.equal(await fetchChannelPostAt(telegramWith([]), config), null);
  assert.equal((await fetchChannelPostAt(telegramWith([post(1, -100, { text: undefined })]), config)).preview, null);
});

test('does not attach future publications or text edited after the event', async () => {
  await assert.rejects(fetchChannelPostAt(telegramWith([post(2, 10)]), config), /на момент события/);
  await assert.rejects(fetchChannelPostAt(telegramWith([post(1, -100, { edit_date: eventTime + 1 })]), config), /изменён после события/);
});

test('does not expose a token from an HTTP error in the saved error message', async () => {
  const telegram = { callApi: async () => { throw new Error('Failed https://api.telegram.org/botSECRET_TOKEN/getChat'); } };
  await assert.rejects(fetchChannelPostAt(telegram, config), { message: 'Не удалось запросить посты у Telegram.' });
});
