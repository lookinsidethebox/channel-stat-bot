const assert = require('node:assert/strict');
const test = require('node:test');
const { mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createBot } = require('../src/bot');
const { createMemberStore } = require('../src/storage/member.store');
const { createSourceStatisticsStore } = require('../src/storage/source-statistics.store');
const { createAdsStatisticsStore } = require('../src/storage/ads-statistics.store');
const { emptyCounts } = require('../src/services/source-statistics.service');
const { formatJoinNotification } = require('../src/services/member-notification.service');

const day = '2026-09-29';
const at = hour => `${day}T${String(hour).padStart(2, '0')}:00:00.000Z`;
const config = { token: 'test-token', ownerId: '123', channelId: '-100456' };
const headline = '🎉 На канале новый пользователь!';
const messageOptions = { link_preview_options: { is_disabled: true } };

async function harness(t, { sources = true, ads = true } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'member-notifications-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const memberPath = path.join(directory, 'members.json');
  let hour = 0;
  let counts = {};
  let actions = { 1: 10, 2: 20 };
  const messages = [];
  const errors = [];
  let sendFailures = 0;
  let sourceFailure;

  function makeBot() {
    const memberStore = createMemberStore(memberPath);
    const bot = createBot({ ...config, sourceStatistics: sources ? {} : undefined, adsStatistics: ads ? {} : undefined }, {
      memberStore,
      statisticsStore: createSourceStatisticsStore(config.channelId, path.join(directory, 'sources.json')),
      adsStatisticsStore: createAdsStatisticsStore(config.channelId, path.join(directory, 'ads.json')),
      statisticsReader: {
        fetch: async () => {
          if (sourceFailure) throw sourceFailure;
          return { channelId: config.channelId, fetchedAt: at(hour), days: { [day]: { ...emptyCounts(), ...counts } } };
        },
        close: async () => {},
      },
      adsStatisticsReader: {
        fetch: async () => ({ channelId: config.channelId, accountId: 'account', username: 'example', fetchedAt: at(hour),
          ads: Object.fromEntries(Object.entries(actions).map(([id, count]) => [id, {
            adId: Number(id), title: `Кампания ${id}`, actions: count, promoteUrl: 'https://t.me/example',
          }])),
        }),
        close: async () => {},
      },
      logger: { log() {}, error: (...args) => errors.push(args) },
    });
    bot.botInfo = { id: 999, username: 'test_bot', first_name: 'Test', is_bot: true };
    bot.telegram.sendMessage = async (...args) => {
      if (sendFailures > 0) {
        sendFailures--;
        throw new Error('Telegram unavailable');
      }
      messages.push(args);
      return { message_id: messages.length };
    };
    bot.context.telegram = {
      callApi: async method => {
        if (method === 'getChat') return { personal_chat: { id: Number(config.channelId) } };
        assert.equal(method, 'getUserPersonalChatMessages');
        return [];
      },
      sendMessage: bot.telegram.sendMessage,
    };
    t.after(async () => { await bot.sourceStatistics?.stop(); await bot.adsStatistics?.stop(); });
    return { bot, memberStore };
  }
  const current = makeBot();
  await current.bot.adsStatistics?.checkPending();
  await current.bot.sourceStatistics?.checkPending();
  hour = 1;
  return {
    ...current, messages, errors,
    setCounts: value => { counts = value; },
    setActions: value => { actions = value; },
    failSends: count => { sendFailures = count; },
    failSources: error => { sourceFailure = error; },
    restart: async () => {
      await current.bot.sourceStatistics?.stop();
      await current.bot.adsStatistics?.stop();
      return makeBot();
    },
  };
}

function joinUpdate(id = 345, hour = 1) {
  const user = { id, is_bot: false, first_name: 'Анна', last_name: 'Иванова', username: 'anna' };
  return { update_id: id, chat_member: {
    chat: { id: Number(config.channelId), type: 'channel' },
    from: user, date: Date.parse(at(hour)) / 1000,
    old_chat_member: { user, status: 'left' }, new_chat_member: { user, status: 'member' },
  } };
}

test('join format includes the full name and optional username, with only ads showing a campaign', () => {
  const member = { name: 'Анна Иванова', username: 'anna', source: { type: 'ads' }, campaign: { title: 'Новая кампания' } };
  assert.equal(formatJoinNotification(member), `${headline}\nИмя: Анна Иванова (@anna)\nИсточник: Ads (Новая кампания)`);
  for (const [type, label] of Object.entries({ url: 'URL', search: 'Search', pm: 'PM',
    chat_folder: 'Shareable Chat Folders', invite_link: 'Пригласительная ссылка', join_request: 'Заявка на вступление', unknown: 'Неизвестно' })) {
    assert.equal(formatJoinNotification({ ...member, username: null, source: { type } }),
      `${headline}\nИмя: Анна Иванова\nИсточник: ${label}`);
  }
  assert.equal(formatJoinNotification({ name: null, source: { type: 'ads' } }),
    `${headline}\nИмя: Без имени\nИсточник: Ads (кампания неизвестна)`);
});

test('sends one complete notification immediately when source and campaign are available', async t => {
  const h = await harness(t);
  h.setCounts({ ads: 1 });
  h.setActions({ 1: 11, 2: 20 });
  await h.bot.handleUpdate(joinUpdate());
  assert.deepEqual(h.messages, [[config.ownerId, `${headline}\nИмя: Анна Иванова (@anna)\nИсточник: Ads (Кампания 1)`, messageOptions]]);
  await h.bot.handleUpdate(joinUpdate());
  await Promise.all([h.bot.sourceStatistics.checkPending(), h.bot.adsStatistics.checkPending()]);
  assert.equal(h.messages.length, 1);
  assert.equal((await h.memberStore.getMember(345, at(1))).joinNotification.status, 'sent');
  assert.deepEqual(h.errors, []);
});

test('waits through unchanged source statistics, then sends only the final URL message', async t => {
  const h = await harness(t);
  await h.bot.handleUpdate(joinUpdate());
  await h.bot.sourceStatistics.checkPending();
  assert.equal(h.messages.length, 0);
  h.setCounts({ url: 1 });
  await h.bot.sourceStatistics.checkPending();
  assert.deepEqual(h.messages, [[config.ownerId, `${headline}\nИмя: Анна Иванова (@anna)\nИсточник: URL`, messageOptions]]);
  // The unrelated Ads lookup does not hold back a known URL arrival or send a follow-up.
  await h.bot.adsStatistics.checkPending();
  assert.equal(h.messages.length, 1);
  assert.deepEqual(h.errors, []);
});

test('waits for the campaign after the source is resolved, including concurrent monitor checks', async t => {
  const h = await harness(t);
  await h.bot.handleUpdate(joinUpdate());
  h.setCounts({ ads: 1 });
  await h.bot.sourceStatistics.checkPending();
  await h.bot.adsStatistics.checkPending();
  assert.equal(h.messages.length, 0);
  h.setActions({ 1: 10, 2: 21 });
  await Promise.all([h.bot.adsStatistics.checkPending(), h.bot.sourceStatistics.checkPending()]);
  assert.deepEqual(h.messages, [[config.ownerId, `${headline}\nИмя: Анна Иванова (@anna)\nИсточник: Ads (Кампания 2)`, messageOptions]]);
  assert.deepEqual(h.errors, []);
});

test('early Ads counters wait for the source without producing separate notifications', async t => {
  const h = await harness(t);
  h.setActions({ 1: 11, 2: 20 });
  await h.bot.handleUpdate(joinUpdate());
  assert.equal(h.messages.length, 0);
  h.setCounts({ ads: 1 });
  await h.bot.sourceStatistics.checkPending();
  assert.equal(h.messages.length, 0);
  await h.bot.adsStatistics.checkPending();
  assert.equal(h.messages.length, 1);
  assert.match(h.messages[0][1], /Источник: Ads \(Кампания 1\)$/);
});

test('ambiguous sources produce one final unknown notification per member', async t => {
  const h = await harness(t);
  await h.bot.handleUpdate(joinUpdate(1));
  await h.bot.handleUpdate(joinUpdate(2));
  assert.equal(h.messages.length, 0);
  h.setCounts({ url: 1, ads: 1 });
  await h.bot.sourceStatistics.checkPending();
  assert.equal(h.messages.length, 2);
  assert.ok(h.messages.every(([, message]) => message.endsWith('Источник: Неизвестно')));
  await h.bot.adsStatistics.checkPending();
  await h.bot.sourceStatistics.checkPending();
  assert.equal(h.messages.length, 2);
});

test('ambiguous campaigns finish the notification with an explicit unknown campaign', async t => {
  const h = await harness(t);
  h.setCounts({ ads: 1 });
  await h.bot.handleUpdate(joinUpdate());
  assert.equal(h.messages.length, 0);
  h.setActions({ 1: 11, 2: 21 });
  await h.bot.adsStatistics.checkPending();
  assert.equal(h.messages.length, 1);
  assert.match(h.messages[0][1], /Источник: Ads \(кампания неизвестна\)$/);
});

test('pending notifications survive restart and sent ones are not sent again', async t => {
  const h = await harness(t);
  await h.bot.handleUpdate(joinUpdate());
  assert.equal(h.messages.length, 0);
  const restarted = await h.restart();
  h.setCounts({ ads: 1 });
  h.setActions({ 1: 11, 2: 20 });
  await restarted.bot.adsStatistics.checkPending();
  await restarted.bot.sourceStatistics.checkPending();
  assert.equal(h.messages.length, 0);
  await restarted.bot.adsStatistics.checkPending();
  assert.equal(h.messages.length, 1);
  const again = await h.restart();
  await again.bot.memberNotifications.sendPending();
  await again.bot.sourceStatistics.checkPending();
  await again.bot.adsStatistics.checkPending();
  assert.equal(h.messages.length, 1);
});

test('a failed send retries on the next check even after all lookups have finished', async t => {
  const h = await harness(t);
  await h.bot.handleUpdate(joinUpdate());
  h.setCounts({ url: 1 });
  h.failSends(1);
  await h.bot.sourceStatistics.checkPending();
  assert.equal(h.messages.length, 0);
  assert.equal((await h.memberStore.getMember(345, at(1))).joinNotification.status, 'pending');
  await h.bot.sourceStatistics.checkPending();
  assert.equal(h.messages.length, 1);
  assert.equal((await h.memberStore.getMember(345, at(1))).joinNotification.status, 'sent');
});

test('a failed notification state write retries persistence without sending a duplicate', async t => {
  const h = await harness(t);
  await h.bot.handleUpdate(joinUpdate());
  const markJoinNotified = h.memberStore.markJoinNotified;
  h.memberStore.markJoinNotified = async () => { throw new Error('Disk full'); };
  h.setCounts({ url: 1 });
  await h.bot.sourceStatistics.checkPending();
  assert.equal(h.messages.length, 1);
  assert.equal((await h.memberStore.getMember(345, at(1))).joinNotification.status, 'pending');
  h.memberStore.markJoinNotified = markJoinNotified;
  await h.bot.sourceStatistics.checkPending();
  assert.equal(h.messages.length, 1);
  assert.equal((await h.memberStore.getMember(345, at(1))).joinNotification.status, 'sent');
});

test('statistics request failures keep the notification pending without a premature unknown message', async t => {
  const h = await harness(t);
  h.failSources(new Error('Unavailable'));
  await h.bot.handleUpdate(joinUpdate());
  assert.equal(h.messages.length, 0);
  assert.equal((await h.memberStore.getMember(345, at(1))).joinNotification.status, 'pending');
  h.failSources(null);
  h.setCounts({ url: 1 });
  const restarted = await h.restart();
  await restarted.bot.sourceStatistics.checkPending();
  assert.equal(h.messages.length, 1);
});

test('without statistics the available source is sent immediately, with no empty username parentheses', async t => {
  const h = await harness(t, { sources: false, ads: false });
  const update = joinUpdate();
  delete update.chat_member.new_chat_member.user.username;
  update.chat_member.via_chat_folder_invite_link = true;
  await h.bot.handleUpdate(update);
  assert.deepEqual(h.messages, [[config.ownerId, `${headline}\nИмя: Анна Иванова\nИсточник: Shareable Chat Folders`, messageOptions]]);
});

test('historic members without a queued notification are not notified retroactively', async t => {
  const h = await harness(t);
  await h.memberStore.recordMemberEvent({ action: 'joined', occurredAt: at(1),
    user: { id: 1, name: 'Old member', username: null }, source: { type: 'unknown' }, sourceLookup: { status: 'pending' },
  });
  h.setCounts({ url: 1 });
  await h.bot.sourceStatistics.checkPending();
  assert.equal(h.messages.length, 0);
  assert.equal((await h.memberStore.getMember(1, at(1))).source.type, 'url');
});

test('the assembled bot waits for a returning member campaign, then includes the saved history once', async t => {
  const h = await harness(t);
  const user = { id: 345, name: 'Прежнее имя', username: 'old_username' };
  await h.memberStore.recordMemberEvent({ action: 'joined', user, occurredAt: '2026-09-01T08:00:00.000Z',
    source: { type: 'url' },
  }, { messageId: 10, postedAt: '2026-09-01T07:00:00.000Z', preview: 'Пост при старом входе' });
  await h.memberStore.recordMemberEvent({ action: 'left', user, occurredAt: '2026-09-03T10:00:00.000Z' },
    { messageId: 12, postedAt: '2026-09-03T09:00:00.000Z', preview: 'Пост при старом выходе' });
  await h.bot.handleUpdate(joinUpdate());
  assert.equal(h.messages.length, 0);
  h.setCounts({ ads: 1 });
  await h.bot.sourceStatistics.checkPending();
  assert.equal(h.messages.length, 0);
  h.setActions({ 1: 11, 2: 20 });
  await h.bot.adsStatistics.checkPending();
  assert.equal(h.messages.length, 1);
  const message = h.messages[0][1];
  assert.ok(message.startsWith('🎉 На канале пользователь-возвращенец!\nИмя: Анна Иванова (@anna)\nИсточник: Ads (Кампания 1)'));
  assert.ok(message.includes('Добавился: 01.09.2026 10:00\nИсточник: URL'));
  assert.ok(message.includes('Пришел из-за поста: Пост при старом входе'));
  assert.ok(message.includes('Удалился из-за поста: Пост при старом выходе'));
  assert.ok(message.endsWith('Сколько дней провел на канале: 2'));
  await h.bot.handleUpdate(joinUpdate());
  await h.bot.adsStatistics.checkPending();
  assert.equal(h.messages.length, 1);
  assert.deepEqual(h.errors, []);
});
