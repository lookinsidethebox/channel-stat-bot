const assert = require('node:assert/strict');
const test = require('node:test');
const { mkdtemp, rm, readFile, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createStatsReporter } = require('../src/services/stats-report.service');
const { createDailySummaryStore } = require('../src/storage/daily-summary.store');
const { createMemberStore } = require('../src/storage/member.store');
const { reportWindow, formatDailySummary } = require('../src/services/daily-summary.service');
const { createReactionStatistics } = require('../src/services/reaction-statistics.service');

const channelId = '-1001234567890';
const posts = [{ messageId: 30, preview: '<Пост>', postedAt: '2026-09-27T08:00:00.000Z',
  views: 100, reactions: 5, forwards: 2 }];
const previousPosts = [{ messageId: 30, views: 70, reactions: 6, forwards: 0 }];

async function setup(t, instant = '2026-09-29T12:00:00.000Z') {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'stats-report-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'summary.json');
  const summaryStore = createDailySummaryStore(channelId, filePath);
  const memberStore = createMemberStore(path.join(directory, 'members.json'));
  const requests = [];
  let subscriberCount = 1234;
  const options = { channelId, summaryStore, memberStore, now: () => new Date(instant),
    getSubscriberCount: async () => subscriberCount,
    reader: { fetch: async query => {
      requests.push(query);
      return { channelId, posts, previousPosts, fetchedAt: instant };
    } },
  };
  return { options, summaryStore, memberStore, filePath, requests,
    setSubscriberCount: value => { subscriberCount = value; } };
}

test('stats queries historical cumulative counts even before the first report without displaying current counters or writing an outbox', async t => {
  const h = await setup(t);
  const user = { id: 1, name: 'Test', username: null };
  await h.memberStore.recordMemberEvent({ action: 'joined', occurredAt: '2026-09-28T00:00:00.000Z', user });
  await h.memberStore.recordMemberEvent({ action: 'left', occurredAt: '2026-09-28T23:59:59.000Z', user });
  await h.memberStore.recordMemberEvent({ action: 'joined', occurredAt: '2026-09-29T00:00:00.000Z', user });
  const getStats = createStatsReporter(h.options);
  const text = await getStats();
  assert.match(text, /<b>📈 Статистика за 28\.09\.2026<\/b>/);
  assert.match(text, /Пользователей добавилось на канал: <b>1<\/b>\nПользователей отписалось: <b>1<\/b>\nОбщее число подписчиков: <b>1234<\/b>/);
  assert.doesNotMatch(text, /Период:|Счётчики на|Подгорица|11:00/);
  assert.match(text, /<b>Пост:<\/b> &lt;Пост&gt; https:\/\/t\.me\/c\/1234567890\/30/);
  assert.match(text, /Количество просмотров: <b>100 \(\+30\)<\/b>/);
  assert.deepEqual(h.requests, [reportWindow(h.options.now())]);
  assert.equal(await getStats(), text);
  await assert.rejects(readFile(h.filePath), { code: 'ENOENT' });
});

test('stats reuses an existing pending or sent report and its original daily deltas without changing delivery state', async t => {
  const h = await setup(t);
  await h.summaryStore.initialize('2026-09-27T12:00:00.000Z');
  const yesterday = { ...reportWindow(new Date('2026-09-28T12:00:00.000Z')), channelId, kind: 'calendar_totals_reactions',
    membership: { joined: 0, left: 0 }, posts: [{ ...posts[0], views: 9999, reactions: 999, forwards: 99 }] };
  const today = { ...reportWindow(h.options.now()), channelId, kind: 'calendar_totals_reactions', membership: { joined: 7, left: 2 }, posts, previousPosts };
  for (const report of [yesterday, today]) {
    await h.summaryStore.prepare({ ...report, text: formatDailySummary(report) });
  }
  const getStats = createStatsReporter({ ...h.options,
    memberStore: { countEvents: () => assert.fail('A stored report must not be rebuilt') },
  });
  for (const [status, subscriberCount] of [['pending', 1234], ['sent', 1240]]) {
    if (status === 'sent') await h.summaryStore.markSent(today.date, h.options.now().toISOString());
    h.setSubscriberCount(subscriberCount);
    const before = await readFile(h.filePath, 'utf8');
    const text = await getStats();
    assert.match(text, new RegExp(`Пользователей добавилось на канал: <b>7</b>\\nПользователей отписалось: <b>2</b>\\nОбщее число подписчиков: <b>${subscriberCount}</b>`));
    assert.match(text, /Количество просмотров: <b>100 \(\+30\)<\/b>/);
    assert.match(text, /Количество реакций: <b>5 \(-1\)<\/b>/);
    assert.match(text, /Количество репостов: <b>2 \(\+2\)<\/b>/);
    assert.doesNotMatch(text, /Счётчики на/);
    assert.equal(await readFile(h.filePath, 'utf8'), before);
  }
  assert.deepEqual(h.requests, []);
});

for (const version of [2, 3]) test(`stats rebuilds a version ${version} report without changing its delivery history`, async t => {
  const h = await setup(t);
  const report = { ...reportWindow(h.options.now()), kind: version === 2 ? 'calendar_day' : 'calendar_totals', channelId, posts,
    status: 'sent', text: 'Old daily activity comparison' };
  const raw = JSON.stringify({ version, channelId, initializedAt: '2026-09-27T12:00:00.000Z',
    reports: { [report.date]: report } });
  await writeFile(h.filePath, raw);
  const text = await createStatsReporter(h.options)();
  assert.match(text, /Количество просмотров: <b>100 \(\+30\)<\/b>/);
  assert.doesNotMatch(text, /Old daily activity/);
  assert.equal(h.requests.length, 1);
  assert.equal(await readFile(h.filePath, 'utf8'), raw);
});

test('stats refreshes a fallback current reaction count without using a saved graph baseline or changing the outbox', async t => {
  const h = await setup(t);
  const window = reportWindow(h.options.now());
  await h.summaryStore.initialize('2026-09-27T12:00:00.000Z');
  await h.summaryStore.prepare({ ...window, channelId, kind: 'calendar_totals_reactions', membership: { joined: 0, left: 0 },
    posts: [{ ...posts[0], reactions: 15, reactionPeriod: 'current' }], previousPosts, text: 'Previously sent fallback' });
  await h.summaryStore.markSent(window.date, h.options.now().toISOString());
  const raw = await readFile(h.filePath, 'utf8');
  const reactionStatistics = createReactionStatistics({ summaryStore: h.summaryStore });
  const getStats = createStatsReporter({ ...h.options, reactionStatistics,
    reader: { fetch: async () => ({ channelId, posts: [{ ...posts[0], reactions: null, currentReactions: 19 }], previousPosts }) },
  });
  assert.match(await getStats(), /Количество реакций: <b>19<\/b> \(сейчас; нет данных за сутки\)/);
  assert.equal(await readFile(h.filePath, 'utf8'), raw);
});

test('stats uses stored midnight counts instead of the newer current count', async t => {
  const h = await setup(t);
  const window = reportWindow(h.options.now());
  for (const [boundaryAt, reactions] of [[window.periodStart, 15], [window.periodEnd, 17]]) {
    await h.summaryStore.saveReactionSnapshot({ boundaryAt, capturedAt: boundaryAt, posts: [{ ...posts[0], reactions }] });
  }
  const getStats = createStatsReporter({ ...h.options,
    reactionStatistics: createReactionStatistics({ summaryStore: h.summaryStore }),
    reader: { fetch: async () => ({ channelId, posts: [{ ...posts[0], reactions: null, currentReactions: 19 }], previousPosts }) },
  });
  assert.match(await getStats(), /Количество реакций: <b>17 \(\+2\)<\/b>/);
});

test('stats before 11:00 already selects yesterday, including a daylight-saving transition', async t => {
  const h = await setup(t, '2026-10-26T09:59:59.000Z');
  let counted;
  let drained = false;
  const getStats = createStatsReporter({ ...h.options,
    beforeReport: async () => { drained = true; },
    memberStore: { countEvents: async (from, to) => {
      assert.equal(drained, true);
      counted = [from, to];
      return { joined: 0, left: 0 };
    } },
  });
  const text = await getStats();
  assert.deepEqual(counted, ['2026-10-25T00:00:00.000Z', '2026-10-26T00:00:00.000Z']);
  assert.match(text, /Статистика за 25\.10\.2026/);
});

test('stats rejects a foreign-channel snapshot or unreadable report storage instead of fabricating a summary', async t => {
  const h = await setup(t);
  await assert.rejects(createStatsReporter({ ...h.options,
    reader: { fetch: async () => ({ channelId: 'another', posts: [], fetchedAt: h.options.now().toISOString() }) },
  })(), /DAILY_SUMMARY_CHANNEL_MISMATCH/);
  await assert.rejects(createStatsReporter({ ...h.options,
    summaryStore: { getState: async () => { throw new Error('Read failed'); } },
  })(), /Read failed/);
  assert.deepEqual(h.requests, []);
});
