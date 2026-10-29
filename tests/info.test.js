const assert = require('node:assert/strict');
const test = require('node:test');
const { mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createBot } = require('../src/bot');
const { createMemberStore } = require('../src/storage/member.store');
const { formatInfo } = require('../src/controllers/info.controller');

const channelId = '-1001234567890';
const config = { token: 'test-token', ownerId: '123', channelId, sourceStatistics: {} };

function update(id, text, updateId) {
  return { update_id: updateId, message: { message_id: updateId, date: 1,
    from: { id, first_name: 'Test', is_bot: false }, chat: { id, type: 'private' }, text,
    entities: text.startsWith('/') ? [{ type: 'bot_command', offset: 0, length: text.split(/\s/)[0].length }] : [],
  } };
}

function harness(memberStore, resolveUsername = async () => 456) {
  const replies = [];
  const bot = createBot(config, { memberStore, statisticsReader: { resolveUsername },
    logger: { log() {}, error() {} } });
  bot.botInfo = { id: 999, username: 'test_bot', first_name: 'Test', is_bot: true };
  bot.context.telegram = { sendMessage: async (_id, text) => { replies.push(text); return { message_id: replies.length }; } };
  return { bot, replies };
}

test('/info finds the latest membership by ID or resolved username and handles absent data', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'channel-info-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createMemberStore(path.join(directory, 'members.json'));
  const user = { id: 456, name: 'Тест', username: 'test_user' };
  await store.recordMemberEvent({ action: 'joined', occurredAt: '2026-10-01T00:00:00.000Z', user,
    source: { type: 'url' } }, { messageId: 11, postedAt: '2026-09-30T00:00:00.000Z', preview: 'Старый пост' });
  await store.recordMemberEvent({ action: 'left', occurredAt: '2026-10-02T00:00:00.000Z', user });
  await store.recordMemberEvent({ action: 'joined', occurredAt: '2026-10-03T00:00:00.000Z', user,
    source: { type: 'ads' }, adsCampaign: { title: 'Новая кампания' } },
  { messageId: 12, postedAt: '2026-10-02T00:00:00.000Z', preview: 'Новый пост' });
  const h = harness(store);
  await h.bot.handleUpdate(update(456, '/info 456', 1));
  assert.deepEqual(h.replies, []);
  await h.bot.handleUpdate(update(123, '/info 456', 2));
  assert.match(h.replies.at(-1), /Добавился: 03\.10\.2026 02:00/);
  assert.match(h.replies.at(-1), /Новый пост https:\/\/t\.me\/c\/1234567890\/12/);
  assert.match(h.replies.at(-1), /Источник: Ads\nКампания: Новая кампания/);
  assert.doesNotMatch(h.replies.at(-1), /Старый пост/);
  await h.bot.handleUpdate(update(123, '/info', 3));
  await h.bot.handleUpdate(update(123, '@test_user', 4));
  assert.match(h.replies.at(-1), /ID: 456/);
  await h.bot.handleUpdate(update(123, '999', 5));
  assert.equal(h.replies.at(-1), 'Информации о вступлении этого пользователя на канал нет.');
  await h.bot.handleUpdate(update(123, '/cancel', 6));
  assert.equal(h.replies.at(-1), 'Поиск отменён.');
  await h.bot.handleUpdate(update(123, '/check', 7));
  await h.bot.handleUpdate(update(123, '/info', 8));
  await h.bot.handleUpdate(update(123, '456', 9));
  assert.match(h.replies.at(-1), /Источник: Ads/);
  await h.bot.handleUpdate(update(123, '/info', 10));
  await h.bot.handleUpdate(update(123, '/check', 11));
  await h.bot.handleUpdate(update(123, '456', 12));
  assert.equal(h.replies.at(-1), 'Не удалось проверить подписку. Попробуй ещё раз позже.');
});

test('/info formats completed periods and missing fields honestly', () => {
  const member = { userId: 456, name: null, username: null, addedAt: '2026-10-01T00:00:00.000Z',
    removedAt: '2026-10-03T00:00:00.000Z', source: { type: 'undefined', name: null }, postAtAddition: null };
  const result = formatInfo(member, channelId, Date.parse('2026-10-29T00:00:00.000Z'));
  assert.match(result, /Провёл на канале: 2 дня/);
  assert.match(result, /Пост при вступлении: нет данных\nИсточник: undefined\nКампания: нет данных/);
  assert.match(result, /Покинул канал: 03\.10\.2026 02:00/);
  assert.doesNotMatch(result, /На канале: 28/);
});
