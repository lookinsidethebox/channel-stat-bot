const assert = require('node:assert/strict');
const test = require('node:test');
const { mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createBot } = require('../src/bot');
const { createMemberStore } = require('../src/storage/member.store');
const { createSourceStatisticsStore } = require('../src/storage/source-statistics.store');
const { createAdsStatisticsStore } = require('../src/storage/ads-statistics.store');
const { createUrlPromosStore } = require('../src/storage/url-promos.store');
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
  let notificationTime = Date.parse(at(1));
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
      notificationNow: () => notificationTime,
      urlPromosStore: createUrlPromosStore(path.join(directory, 'url-promos.json')),
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
    setNotificationTime: value => { notificationTime = value; },
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

function sourceReply(text, messageId = 1, fromId = Number(config.ownerId)) {
  return { update_id: 900 + messageId, message: {
    message_id: 200 + messageId, date: Date.parse(at(1)) / 1000 + 301,
    from: { id: fromId, is_bot: false, first_name: 'Owner' },
    chat: { id: fromId, type: 'private' }, text, reply_to_message: { message_id: messageId },
  } };
}

test('join format includes campaigns for Ads and URL only', () => {
  const member = { name: 'Анна Иванова', username: 'anna', source: { type: 'ads' }, adsCampaign: { title: 'Новая кампания' } };
  assert.equal(formatJoinNotification(member), `${headline}\nИмя: Анна Иванова (@anna)\nИсточник: Ads (Новая кампания)`);
  for (const [type, label] of Object.entries({ url: 'URL', search: 'Search', pm: 'PM',
    chat_folder: 'Shareable Chat Folders', invite_link: 'Пригласительная ссылка', join_request: 'Заявка на вступление', unknown: 'Неизвестно' })) {
    assert.equal(formatJoinNotification({ ...member, username: null, source: { type },
      ...(type === 'url' ? { urlCampaign: { title: 'Новая кампания' } } : {}) }),
      `${headline}\nИмя: Анна Иванова\nИсточник: ${label}${type === 'url' ? ' (Новая кампания)' : ''}`);
  }
  assert.equal(formatJoinNotification({ name: null, source: { type: 'ads' } }),
    `${headline}\nИмя: Без имени\nИсточник: Ads (кампания неизвестна)`);
});

const immediate = '🎉 На канале новый пользователь – Анна Иванова (@anna)';
const sourceUpdate = source => `Обновилась информация о том, откуда пришел пользователь Анна Иванова (@anna): ${source}`;

test('a quick departure keeps the immediate join notification', async t => {
  const h = await harness(t);
  await h.bot.handleUpdate(joinUpdate());
  assert.deepEqual(h.messages.map(item => item[1]), [immediate]);
  const update = joinUpdate();
  update.update_id = 900;
  update.chat_member.date += 60;
  update.chat_member.old_chat_member.status = 'member';
  update.chat_member.new_chat_member.status = 'left';
  await h.bot.handleUpdate(update);
  assert.equal(h.messages.length, 2);
  assert.match(h.messages[1][1], /Подписчик покинул канал/);
  h.setCounts({ url: 1 });
  await h.bot.sourceStatistics.checkPending();
  assert.equal(h.messages[2][1], sourceUpdate('URL'));
});

test('delayed URL attribution sends a separate update with its promo', async t => {
  const h = await harness(t);
  await h.bot.urlPromos.add({ title: 'Фикбук: диалоги', startDate: day, days: 1 });
  await h.bot.handleUpdate(joinUpdate());
  assert.deepEqual(h.messages.map(item => item[1]), [immediate]);
  h.setCounts({ url: 1 });
  await h.bot.sourceStatistics.checkPending();
  assert.deepEqual(h.messages.map(item => item[1]), [immediate, sourceUpdate('URL (Фикбук: диалоги)')]);
  await h.bot.sourceStatistics.checkPending();
  assert.equal(h.messages.length, 2);
});

test('Ads source is reported as soon as known and a late campaign gets its own update', async t => {
  const h = await harness(t);
  await h.bot.handleUpdate(joinUpdate());
  h.setCounts({ ads: 1 });
  await h.bot.sourceStatistics.checkPending();
  assert.deepEqual(h.messages.map(item => item[1]), [immediate, sourceUpdate('Ads')]);
  h.setActions({ 1: 11, 2: 20 });
  await h.bot.adsStatistics.checkPending();
  assert.equal(h.messages[2][1], sourceUpdate('Ads (Кампания 1)'));
  await h.bot.adsStatistics.checkPending();
  assert.equal(h.messages.length, 3);
});

test('campaign already known to Ads statistics is reported after its source is identified', async t => {
  const h = await harness(t);
  h.setCounts({ ads: 1 });
  h.setActions({ 1: 11, 2: 20 });
  await h.bot.handleUpdate(joinUpdate());
  assert.deepEqual(h.messages.map(item => item[1]), [immediate,
    sourceUpdate('Ads'), sourceUpdate('Ads (Кампания 1)')]);
  await Promise.all([h.bot.sourceStatistics.checkPending(), h.bot.adsStatistics.checkPending()]);
  assert.equal(h.messages.length, 3);
});

test('unknown source prompts only after 30 minutes and a later source still updates', async t => {
  const h = await harness(t);
  await h.bot.handleUpdate(joinUpdate());
  h.setNotificationTime(Date.parse(at(1)) + 29 * 60000 + 59000);
  await h.bot.memberNotifications.sendPending();
  assert.equal(h.messages.length, 1);
  h.setNotificationTime(Date.parse(at(1)) + 30 * 60000);
  await h.bot.memberNotifications.sendPending();
  assert.equal(h.messages.length, 2);
  assert.match(h.messages[1][1], /Источник не удалось определить/);
  assert.equal((await h.memberStore.getMember(345, at(1))).sourceNotification.status, 'unknown_sent');
  h.setCounts({ url: 1 });
  await h.bot.sourceStatistics.checkPending();
  assert.equal(h.messages[2][1], sourceUpdate('URL'));
  assert.equal((await h.memberStore.getMember(345, at(1))).sourceNotification.status, 'sent');
});

test('the owner can label an unknown source by replying after the timeout', async t => {
  const h = await harness(t);
  await h.bot.urlPromos.add({ title: 'Статья', startDate: day, days: 1 });
  await h.bot.handleUpdate(joinUpdate());
  h.setNotificationTime(Date.parse(at(1)) + 30 * 60000);
  await h.bot.memberNotifications.sendPending();
  const restarted = await h.restart();
  await restarted.bot.handleUpdate(sourceReply('URL', 2));
  assert.equal((await h.memberStore.getMember(345, at(1))).source.type, 'url');
  assert.ok(h.messages.some(item => item[1] === sourceUpdate('URL (Статья)')));
});

test('pending source update survives restart without replaying the join', async t => {
  const h = await harness(t);
  await h.bot.handleUpdate(joinUpdate());
  const restarted = await h.restart();
  h.setCounts({ url: 1 });
  await restarted.bot.sourceStatistics.checkPending();
  assert.deepEqual(h.messages.map(item => item[1]), [immediate, sourceUpdate('URL')]);
  const again = await h.restart();
  await again.bot.memberNotifications.sendPending();
  assert.equal(h.messages.length, 2);
});

test('a failed immediate send retries without losing later attribution', async t => {
  const h = await harness(t);
  h.failSends(1);
  await h.bot.handleUpdate(joinUpdate());
  assert.equal(h.messages[0][1], immediate);
  h.setCounts({ url: 1 });
  await h.bot.sourceStatistics.checkPending();
  assert.equal(h.messages[1][1], sourceUpdate('URL'));
});

test('a failed source acknowledgement retries persistence without duplicate delivery', async t => {
  const h = await harness(t);
  await h.bot.handleUpdate(joinUpdate());
  const original = h.memberStore.markSourceNotified;
  h.memberStore.markSourceNotified = async () => { throw new Error('Disk full'); };
  h.setCounts({ url: 1 });
  await h.bot.sourceStatistics.checkPending();
  assert.equal(h.messages.length, 2);
  h.memberStore.markSourceNotified = original;
  await h.bot.sourceStatistics.checkPending();
  assert.equal(h.messages.length, 2);
  assert.equal((await h.memberStore.getMember(345, at(1))).sourceNotification.status, 'sent');
});

test('without statistics, Telegram metadata is reported separately', async t => {
  const h = await harness(t, { sources: false, ads: false });
  const update = joinUpdate();
  delete update.chat_member.new_chat_member.user.username;
  update.chat_member.via_chat_folder_invite_link = true;
  await h.bot.handleUpdate(update);
  assert.deepEqual(h.messages.map(item => item[1]), [
    '🎉 На канале новый пользователь – Анна Иванова',
    'Обновилась информация о том, откуда пришел пользователь Анна Иванова: Shareable Chat Folders',
  ]);
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

test('a returning member gets the saved history immediately and the campaign later', async t => {
  const h = await harness(t);
  const user = { id: 345, name: 'Прежнее имя', username: 'old_username' };
  await h.memberStore.recordMemberEvent({ action: 'joined', user, occurredAt: '2026-09-01T08:00:00.000Z',
    source: { type: 'url' },
  }, { messageId: 10, postedAt: '2026-09-01T07:00:00.000Z', preview: 'Пост при старом входе' });
  await h.memberStore.recordMemberEvent({ action: 'left', user, occurredAt: '2026-09-03T10:00:00.000Z' },
    { messageId: 12, postedAt: '2026-09-03T09:00:00.000Z', preview: 'Пост при старом выходе' });
  await h.bot.handleUpdate(joinUpdate());
  assert.equal(h.messages.length, 1);
  h.setCounts({ ads: 1 });
  await h.bot.sourceStatistics.checkPending();
  assert.equal(h.messages.length, 2);
  h.setActions({ 1: 11, 2: 20 });
  await h.bot.adsStatistics.checkPending();
  assert.equal(h.messages.length, 3);
  const message = h.messages[0][1];
  assert.ok(message.startsWith('🎉 На канале пользователь-возвращенец – Анна Иванова (@anna)'));
  assert.ok(message.includes('Добавился: 01.09.2026 10:00\nИсточник: URL'));
  assert.ok(message.includes('Пришел из-за поста: Пост при старом входе'));
  assert.ok(message.includes('Удалился из-за поста: Пост при старом выходе'));
  assert.ok(message.endsWith('Сколько дней провел на канале: 2'));
  await h.bot.handleUpdate(joinUpdate());
  await h.bot.adsStatistics.checkPending();
  assert.equal(h.messages.length, 3);
  assert.deepEqual(h.errors, []);
});
