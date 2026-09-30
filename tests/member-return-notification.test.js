const assert = require('node:assert/strict');
const test = require('node:test');
const { mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createMemberStore } = require('../src/storage/member.store');
const { createMemberNotifier, formatJoinNotification } = require('../src/services/member-notification.service');

const channel = { id: '-1001234567890' };
const user = { id: 345, name: 'Анна Иванова', username: 'anna' };
const returned = { ...user, returned: true, source: { type: 'ads' }, adsCampaign: { title: 'Новая кампания' } };
const post = (id, preview) => ({ messageId: id, preview, postedAt: '2026-09-01T00:00:00.000Z' });
const previous = {
  userId: user.id, addedAt: '2026-09-01T08:15:00.000Z', removedAt: '2026-09-03T10:45:00.000Z',
  source: { type: 'url' }, urlCampaign: { title: 'URL-кампания' },
  postAtAddition: post(10, 'Первый пост'), postAtRemoval: post(12, 'Пост при выходе'),
};
const currentJoin = {
  action: 'joined', occurredAt: '2026-09-29T08:00:00.000Z', user, source: { type: 'search' },
  joinNotification: { status: 'pending' },
};

test('return template includes every previous period with its own dates, source, posts and duration', () => {
  const second = { ...previous, addedAt: '2026-09-10T13:00:00Z', removedAt: '2026-09-10T17:00:00Z',
    source: { type: 'ads' }, adsCampaign: { title: 'Предыдущая кампания' },
    postAtAddition: post(20, 'Второй пост'), postAtRemoval: post(21, 'Ещё один пост'),
  };
  assert.equal(formatJoinNotification(returned, [previous, second], channel), [
    '🎉 На канале пользователь-возвращенец!', 'Имя: Анна Иванова (@anna)', 'Источник: Ads (Новая кампания)',
    '', 'Информация о прошлых добавлениях:', '',
    'Добавился: 01.09.2026 10:15', 'Источник: URL (URL-кампания)',
    'Пришел из-за поста: Первый пост https://t.me/c/1234567890/10',
    'Удалился: 03.09.2026 12:45',
    'Удалился из-за поста: Пост при выходе https://t.me/c/1234567890/12',
    'Сколько дней провел на канале: 2', '',
    'Добавился: 10.09.2026 15:00', 'Источник: Ads (Предыдущая кампания)',
    'Пришел из-за поста: Второй пост https://t.me/c/1234567890/20',
    'Удалился: 10.09.2026 19:00',
    'Удалился из-за поста: Ещё один пост https://t.me/c/1234567890/21',
    'Сколько дней провел на канале: меньше 1',
  ].join('\n'));
});

test('incomplete history keeps known departures and marks missing data explicitly', () => {
  const orphan = { addedAt: null, removedAt: '2026-01-02T08:00:00Z', source: null,
    postAtAddition: null, postAtRemoval: post(1, null),
  };
  const message = formatJoinNotification({ ...returned, username: null }, [orphan], channel);
  assert.ok(message.includes('Имя: Анна Иванова\n'));
  assert.ok(message.endsWith([
    'Добавился: нет данных', 'Источник: Неизвестно', 'Пришел из-за поста: нет данных',
    'Удалился: 02.01.2026 09:00', 'Удалился из-за поста: Пост без текста https://t.me/c/1234567890/1',
    'Сколько дней провел на канале: нет данных',
  ].join('\n')));
});

test('both historical post previews are limited to 100 Unicode characters', () => {
  const message = formatJoinNotification(returned, [{ ...previous,
    postAtAddition: post(10, '😀'.repeat(101)), postAtRemoval: post(11, '🦊'.repeat(101)),
  }], channel);
  assert.equal(message.match(/😀/gu).length, 100);
  assert.equal(message.match(/🦊/gu).length, 100);
  assert.ok(!message.includes('\uFFFD'));
});

async function harness(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'return-notification-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const memberPath = path.join(directory, 'members.json');
  const store = createMemberStore(memberPath);
  const messages = [];
  let failureAfter = Infinity;
  function notifier(memberStore = store) {
    return createMemberNotifier({ memberStore, channelId: channel.id, logger: { error() {} },
      sendMessage: async text => {
        if (messages.length >= failureAfter) throw new Error('Network unavailable');
        assert.ok(text.length <= 4096);
        messages.push(text);
      },
    });
  }
  return { store, memberPath, messages, notifier, failAfter: value => { failureAfter = value; } };
}

async function savePeriod(store, period, id = user.id) {
  if (period.addedAt) {
    await store.recordMemberEvent({ action: 'joined', occurredAt: period.addedAt,
      user: { ...user, id }, source: period.source,
    }, period.postAtAddition);
  }
  await store.recordMemberEvent({ action: 'left', occurredAt: period.removedAt, user: { ...user, id } }, period.postAtRemoval);
}

test('the stored history excludes other users, the current period and later arrivals', async t => {
  const h = await harness(t);
  await savePeriod(h.store, previous);
  await savePeriod(h.store, { ...previous, source: { type: 'pm' } }, 999);
  await h.store.recordMemberEvent(currentJoin);
  await h.store.recordMemberEvent({ action: 'left', user, occurredAt: '2026-09-29T10:00:00.000Z' });
  await h.store.recordMemberEvent({ ...currentJoin, occurredAt: '2026-09-30T10:00:00.000Z', joinNotification: undefined });
  const history = await h.store.getMemberHistory(String(user.id), currentJoin.occurredAt);
  assert.equal(history.length, 1);
  assert.equal(history[0].addedAt, previous.addedAt);
  await h.notifier().sendPending();
  assert.equal(h.messages.length, 1);
  assert.ok(h.messages[0].startsWith('🎉 На канале пользователь-возвращенец!'));
  assert.equal(h.messages[0].split('Добавился:').length - 1, 1);
  assert.ok(!h.messages[0].includes('Источник: PM'));
  assert.ok(!h.messages[0].includes('30.09.2026'));
  assert.ok(!h.messages[0].includes('29.09.2026'));
});

test('a return after an untracked departure includes that incomplete period', async t => {
  const h = await harness(t);
  await savePeriod(h.store, { ...previous, addedAt: null, postAtAddition: null });
  await h.store.recordMemberEvent(currentJoin);
  await h.notifier().sendPending();
  assert.equal(h.messages.length, 1);
  assert.ok(h.messages[0].includes('Добавился: нет данных'));
  assert.ok(h.messages[0].includes('Удалился: 03.09.2026 12:45'));
});

async function saveLongHistory(store, count = 24) {
  for (let index = 0; index < count; index++) {
    const addedAt = new Date(Date.UTC(2026, 7, index + 1, 8)).toISOString();
    const removedAt = new Date(Date.UTC(2026, 7, index + 1, 16)).toISOString();
    await savePeriod(store, { addedAt, removedAt, source: { type: 'url' },
      postAtAddition: post(index * 2 + 1, `Вход ${index}: ${'😀'.repeat(100)}`),
      postAtRemoval: post(index * 2 + 2, `Выход ${index}: ${'🦊'.repeat(100)}`),
    });
  }
  await store.recordMemberEvent(currentJoin);
}

test('long histories split between complete periods and contain all records exactly once', async t => {
  const h = await harness(t);
  await saveLongHistory(h.store);
  await h.notifier().sendPending();
  assert.ok(h.messages.length > 1);
  for (const text of h.messages) {
    assert.equal(text.split('Добавился:').length, text.split('Удалился:').length);
    assert.ok(!text.includes('\uFFFD'));
  }
  for (let index = 0; index < 24; index++) {
    assert.equal(h.messages.join('\n').split(`Вход ${index}:`).length - 1, 1);
    assert.equal(h.messages.join('\n').split(`Выход ${index}:`).length - 1, 1);
  }
  assert.equal((await h.store.getMember(user.id, currentJoin.occurredAt)).joinNotification.status, 'sent');
});

test('a partial send resumes after restart without repeating delivered parts or rebuilding the history', async t => {
  const h = await harness(t);
  await saveLongHistory(h.store);
  h.failAfter(1);
  await h.notifier().sendPending();
  assert.equal(h.messages.length, 1);
  const state = (await h.store.getMember(user.id, currentJoin.occurredAt)).joinNotification;
  assert.equal(state.sentCount, 1);
  assert.equal(state.status, 'pending');
  h.failAfter(Infinity);
  const restarted = createMemberStore(h.memberPath);
  await h.notifier(restarted).sendPending();
  assert.deepEqual(h.messages, state.messages);
  assert.equal((await restarted.getMember(user.id, currentJoin.occurredAt)).joinNotification.status, 'sent');
});

test('a failed part acknowledgement retries the write before sending the next part', async t => {
  const h = await harness(t);
  await saveLongHistory(h.store);
  const markSent = h.store.markJoinNotificationPartSent;
  h.store.markJoinNotificationPartSent = async () => { throw new Error('Disk full'); };
  const notifier = h.notifier();
  await notifier.sendPending();
  assert.equal(h.messages.length, 1);
  await notifier.sendPending();
  assert.equal(h.messages.length, 1);
  const prepared = (await h.store.getMember(user.id, currentJoin.occurredAt)).joinNotification.messages;
  h.store.markJoinNotificationPartSent = markSent;
  await notifier.sendPending();
  assert.deepEqual(h.messages, prepared);
});
