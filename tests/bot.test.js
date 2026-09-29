const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createBot } = require('../src/bot');
const { createMemberStore } = require('../src/storage/member.store');
const { createDailySummaryStore } = require('../src/storage/daily-summary.store');

const config = { token: 'test-token', ownerId: '123', channelId: '-100456' };

function createHarness(memberStore, postResponses = []) {
  const sentMessages = [];
  const createdLinks = [];
  const errors = [];
  const postRequests = [];
  const bot = createBot(config, {
    memberStore,
    logger: { log() {}, error: (...args) => errors.push(args) },
  });
  bot.botInfo = { id: 999, username: 'test_bot', first_name: 'Test', is_bot: true };
  bot.context.telegram = {
    callApi: async (method, payload) => {
      if (method === 'getChat') return { personal_chat: { id: Number(config.channelId) } };
      assert.equal(method, 'getUserPersonalChatMessages');
      postRequests.push(payload);
      return postResponses.shift() ?? [];
    },
    sendMessage: async (...args) => sentMessages.push(args),
    createChatInviteLink: async (...args) => {
      createdLinks.push(args);
      return { invite_link: 'https://t.me/+test-invite' };
    },
  };
  bot.telegram.sendMessage = bot.context.telegram.sendMessage;
  return { bot, sentMessages, createdLinks, errors, postRequests };
}

function textUpdate(fromId, text) {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      date: 1780000000,
      from: { id: fromId, is_bot: false, first_name: 'Test' },
      chat: { id: fromId, type: 'private' },
      text,
      entities: text.startsWith('/')
        ? [{ type: 'bot_command', offset: 0, length: text.split(/\s/)[0].length }]
        : [],
    },
  };
}

test('the assembled bot restricts text and link commands to the owner', async () => {
  const { bot, sentMessages, createdLinks, errors } = createHarness();
  await bot.handleUpdate(textUpdate(456, 'Hi'));
  await bot.handleUpdate(textUpdate(456, '/link campaign'));
  assert.equal(sentMessages.length, 0);
  assert.equal(createdLinks.length, 0);

  await bot.handleUpdate(textUpdate(123, '/start'));
  assert.equal(sentMessages[0][1], '✅ Бот работает');
  await bot.handleUpdate(textUpdate(123, '/link@test_bot campaign'));
  assert.deepEqual(createdLinks, [[config.channelId, { name: 'campaign' }]]);
  assert.equal(sentMessages.length, 2);
  assert.match(sentMessages[1][1], /https:\/\/t\.me\/\+test-invite/);
  assert.deepEqual(errors, []);
});

test('fetches existing posts for joins and leaves without receiving channel_post updates', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'channel-stat-bot-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'nested', 'channel-members.json');
  const chat = { id: Number(config.channelId), type: 'channel', title: 'Test' };
  const user = { id: 345, is_bot: false, first_name: 'Subscriber' };
  const post = { chat, message_id: 10, date: 1780000000, text: 'Original post' };
  const { bot, sentMessages, errors, postRequests } = createHarness(createMemberStore(filePath), [
    [post],
    [{ ...post, edit_date: 1780000020, text: 'Edited post' }],
    [post],
  ]);
  const membership = {
    chat,
    from: { id: 456, is_bot: false, first_name: 'Admin' },
    date: 1780000010,
    old_chat_member: { user, status: 'left' },
    new_chat_member: { user, status: 'member' },
  };

  await bot.handleUpdate({ update_id: 0, channel_post: { ...post, chat: { ...chat, id: -100789 } } });
  await bot.handleUpdate({ update_id: 1, chat_member: { ...membership, chat: { ...chat, id: -100789 } } });
  await assert.rejects(readFile(filePath), { code: 'ENOENT' });
  await Promise.all([
    bot.handleUpdate({ update_id: 3, chat_member: membership }),
    bot.handleUpdate({
      update_id: 5,
      chat_member: {
        ...membership,
        date: 1780000030,
        old_chat_member: membership.new_chat_member,
        new_chat_member: membership.old_chat_member,
      },
    }),
  ]);
  // Redelivery must neither reopen the old membership nor notify the owner again.
  await bot.handleUpdate({ update_id: 3, chat_member: membership });

  const { members, latestPost } = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(members.length, 1);
  assert.equal(members[0].postAtAddition.preview, 'Original post');
  assert.equal(members[0].postAtRemoval.preview, 'Edited post');
  assert.equal(latestPost.preview, 'Edited post');
  assert.equal(sentMessages.length, 2);
  assert.equal(postRequests.length, 3);
  assert.ok(sentMessages.every(([recipient]) => recipient === config.ownerId));
  assert.deepEqual(errors, []);
});

test('routes handler failures to the common error logger and keeps processing the queue', async () => {
  const error = new Error('Read failed');
  let attempts = 0;
  const { bot, errors, sentMessages } = createHarness({
    recordMemberEvent: async () => { throw error; },
    saveLatestPost: async () => {
      attempts += 1;
      if (attempts === 1) throw error;
      return true;
    },
  });
  const update = {
    update_id: 1,
    channel_post: {
      chat: { id: Number(config.channelId), type: 'channel' },
      message_id: 1,
      date: 1780000000,
      text: 'Test',
    },
  };
  await Promise.all([bot.handleUpdate(update), bot.handleUpdate({ ...update, update_id: 2 })]);
  assert.equal(attempts, 2);
  assert.equal(errors.length, 1);
  assert.equal(errors[0][1], error);
  assert.deepEqual(sentMessages, []);
});

test('leave notifications use only the latest subscription period after a restart and are not duplicated', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'channel-stat-bot-leave-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'members.json');
  const store = createMemberStore(filePath);
  const user = { id: 345, name: 'Старое имя', username: 'old_username' };
  const firstAddedAt = '2026-09-01T10:00:00.000Z';
  const addedAt = '2026-09-26T10:00:00.000Z';
  const removedAt = '2026-09-29T12:00:00.000Z';
  const chat = { id: Number(config.channelId), type: 'channel', username: 'example_channel' };
  for (const [time, title, messageId] of [[firstAddedAt, 'Старая кампания', 10], [addedAt, 'Новая кампания', 20]]) {
    await store.recordMemberEvent({ action: 'joined', occurredAt: time, user,
      source: { type: 'ads' }, campaignLookup: { status: 'pending' },
    }, { messageId, postedAt: time, preview: `Пост ${messageId}` });
    await store.resolveMemberCampaign({ userId: user.id, addedAt: time, status: 'matched', checkedAt: time,
      campaign: { adId: messageId, title },
    });
    if (time === firstAddedAt) {
      await store.recordMemberEvent({ action: 'left', occurredAt: '2026-09-20T10:00:00.000Z', user });
    }
  }
  const { bot, sentMessages, errors } = createHarness(createMemberStore(filePath), [[{
    chat, message_id: 30, date: Date.parse(removedAt) / 1000, text: 'Пост при отписке',
  }]]);
  const currentUser = { id: user.id, is_bot: false, first_name: 'Анна', last_name: 'Иванова', username: 'anna' };
  const update = { update_id: 1, chat_member: { chat, from: currentUser, date: Date.parse(removedAt) / 1000,
    old_chat_member: { user: currentUser, status: 'member' }, new_chat_member: { user: currentUser, status: 'left' },
  } };
  await bot.handleUpdate(update);
  await bot.handleUpdate(update);
  assert.deepEqual(sentMessages, [[config.ownerId, [
    '👎 Подписчик покинул канал! Да и хуй с ним.', '', 'Имя: Анна Иванова (@anna)',
    'Источник: Ads (Новая кампания)',
    'С какого поста подписался: Пост 20 https://t.me/example_channel/20',
    'Сколько дней провел на канале: 3',
  ].join('\n'), { link_preview_options: { is_disabled: true } }]]);
  const { members } = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(members.length, 2);
  assert.equal(members[1].removedAt, removedAt);
  assert.equal(members[1].postAtRemoval.preview, 'Пост при отписке');
  assert.deepEqual(errors, []);
});

test('an untracked departure has no history lines, even when older closed periods exist', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'channel-stat-bot-orphan-leave-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createMemberStore(path.join(directory, 'members.json'));
  const user = { id: 345, name: 'Анна', username: null };
  await store.recordMemberEvent({ action: 'joined', occurredAt: '2026-09-01T10:00:00.000Z', user, source: { type: 'url' } });
  await store.recordMemberEvent({ action: 'left', occurredAt: '2026-09-02T10:00:00.000Z', user });
  const { bot, sentMessages, errors } = createHarness(store);
  const telegramUser = { id: 345, first_name: 'Анна', is_bot: false };
  await bot.handleUpdate({ update_id: 1, chat_member: {
    chat: { id: Number(config.channelId), type: 'channel' }, from: telegramUser,
    date: Date.parse('2026-09-29T10:00:00.000Z') / 1000,
    old_chat_member: { user: telegramUser, status: 'member' }, new_chat_member: { user: telegramUser, status: 'left' },
  } });
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0][1], '👎 Подписчик покинул канал! Да и хуй с ним.\n\nИмя: Анна');
  assert.deepEqual(errors, []);
});

test('the assembled bot reads post counters through the shared reader and sends an HTML summary only to the owner', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'channel-stat-bot-summary-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const channelId = '-1001234567890';
  const summaryStore = createDailySummaryStore(channelId, path.join(directory, 'summary.json'));
  await summaryStore.initialize('2026-01-01T00:00:00.000Z');
  const sent = [];
  const errors = [];
  let reads = 0;
  let closed = 0;
  const bot = createBot({ ...config, channelId, sourceStatistics: {}, dailySummary: true }, {
    dailySummaryStore: summaryStore,
    memberStore: { countEvents: async () => ({ joined: 3, left: 1 }) },
    statisticsReader: { fetchPosts: async ({ before }) => {
      reads++;
      assert.ok(Date.parse(before) <= Date.now());
      return { channelId, fetchedAt: new Date().toISOString(), posts: [{
        messageId: 42, postedAt: '2025-01-01T00:00:00.000Z', preview: '<Test>', views: 10, reactions: 2, forwards: 1,
      }] };
    }, close: async () => { closed++; } },
    logger: { log() {}, error: (...args) => errors.push(args) },
  });
  bot.telegram.sendMessage = async (...args) => { sent.push(args); };
  await bot.dailySummary.checkPending();
  await bot.dailySummary.checkPending();
  await bot.dailySummary.stop();
  await bot.sourceStatistics.stop();
  assert.equal(reads, 1);
  assert.equal(closed, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], config.ownerId);
  assert.match(sent[0][1], /<b>📈 Статистика за сутки<\/b>/);
  assert.match(sent[0][1], /Пользователей добавилось на канал: 3/);
  assert.match(sent[0][1], /Пост: &lt;Test&gt; https:\/\/t\.me\/c\/1234567890\/42/);
  assert.deepEqual(sent[0][2], { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
  assert.deepEqual(errors, []);
});

test('stats is owner-only, accepts an addressed command and works with scheduled summaries disabled', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'channel-stat-bot-stats-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const channelId = '-1001234567890';
  const filePath = path.join(directory, 'summary.json');
  const replies = [];
  const errors = [];
  let reads = 0;
  const bot = createBot({ ...config, channelId, sourceStatistics: {}, dailySummary: false }, {
    dailySummaryStore: createDailySummaryStore(channelId, filePath),
    memberStore: { countEvents: async () => ({ joined: 3, left: 1 }) },
    statisticsReader: { fetchPosts: async () => {
      reads++;
      return { channelId, fetchedAt: new Date().toISOString(), posts: [] };
    } },
    logger: { log() {}, error: (...args) => errors.push(args) },
  });
  bot.botInfo = { id: 999, username: 'test_bot', first_name: 'Test', is_bot: true };
  bot.context.telegram = { sendMessage: async (...args) => replies.push(args) };
  await bot.handleUpdate(textUpdate(456, '/stats'));
  assert.equal(reads, 0);
  assert.deepEqual(replies, []);
  for (const command of ['/stats', '/stats@test_bot']) {
    await bot.handleUpdate(textUpdate(123, command));
  }
  assert.equal(reads, 2);
  assert.equal(replies.length, 2);
  for (const [recipient, text, extra] of replies) {
    assert.equal(String(recipient), config.ownerId);
    assert.match(text, /<b>📈 Статистика за сутки<\/b>/);
    assert.match(text, /Пользователей добавилось на канал: 3/);
    assert.equal(extra.parse_mode, 'HTML');
    assert.deepEqual(extra.link_preview_options, { is_disabled: true });
  }
  await assert.rejects(readFile(filePath), { code: 'ENOENT' });
  assert.deepEqual(errors, []);
});
