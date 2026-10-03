const assert = require('node:assert/strict');
const test = require('node:test');
const { mkdtemp, rm, writeFile, readFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { reportWindow, dueReportWindow, calendarWindow, scheduledAt, formatDailySummary } = require('../src/services/daily-summary.service');
const { createDailySummaryMonitor } = require('../src/services/daily-summary-monitor.service');
const { createDailySummaryStore } = require('../src/storage/daily-summary.store');
const { createMemberStore } = require('../src/storage/member.store');

const channelId = '-1001234567890';
const summary = { channelId, ...calendarWindow('2026-09-28'),
  membership: { joined: 7, left: 2 }, subscriberCount: 1234, posts: [
    { messageId: 30, preview: 'Текст <поста> & ссылка', postedAt: '2026-09-28T08:00:00Z', views: 100, reactions: 5, forwards: 2 },
    { messageId: 20, preview: 'Вчерашний пост', postedAt: '2026-09-27T08:00:00Z', views: 350, reactions: 9, forwards: 5 },
    { messageId: 10, preview: null, postedAt: '2026-09-26T08:00:00Z', views: null, reactions: 0, forwards: 0 },
  ] };

test('statistics days stay in UTC while delivery stays at 06:00 Podgorica across daylight-saving transitions', () => {
  assert.equal(scheduledAt('2026-09-29'), '2026-09-29T04:00:00.000Z');
  assert.equal(scheduledAt('2026-12-29'), '2026-12-29T05:00:00.000Z');
  for (const date of ['2026-03-29', '2026-10-25']) {
    const window = calendarWindow(date);
    assert.equal(window.date, date);
    assert.equal((Date.parse(window.periodEnd) - Date.parse(window.periodStart)) / 3600000, 24);
    assert.equal(window.periodStart, `${date}T00:00:00.000Z`);
  }
  assert.equal(reportWindow(new Date('2026-09-29T03:59:59Z')).date, '2026-09-28');
  assert.equal(reportWindow(new Date('2026-09-29T04:00:00Z')).date, '2026-09-28');
  assert.equal(reportWindow(new Date('2026-09-28T22:00:00Z')).date, '2026-09-27');
  assert.equal(reportWindow(new Date('2026-09-29T00:00:00Z')).date, '2026-09-28');
  assert.equal(reportWindow(new Date('2026-09-28T22:00:00Z')).nextAt, '2026-09-29T04:00:00.000Z');
  assert.equal(dueReportWindow(new Date('2026-09-29T03:59:59Z')).date, '2026-09-27');
  assert.equal(dueReportWindow(new Date('2026-09-29T04:00:00Z')).date, '2026-09-28');
});

test('the summary uses bold headings, escaped previews and honest positive, negative and missing deltas', () => {
  const text = formatDailySummary({ ...summary, previousPosts: [{ messageId: 20, views: 300, reactions: 11, forwards: 5 }] });
  assert.equal(text, [
    '<b>📈 Статистика за 28.09.2026</b>', '', 'Пользователей добавилось на канал: <b>7</b>', 'Пользователей отписалось: <b>2</b>',
    'Общее число подписчиков: <b>1234</b>', '',
    '<b>Информация по пяти последним постам</b>', '',
    '<b>Пост:</b> Текст &lt;поста&gt; &amp; ссылка https://t.me/c/1234567890/30',
    'Количество просмотров: <b>100 (+100)</b>', 'Количество реакций: <b>5 (+5)</b>', 'Количество репостов: <b>2 (+2)</b>', '',
    '<b>Пост:</b> Вчерашний пост https://t.me/c/1234567890/20',
    'Количество просмотров: <b>350 (+50)</b>', 'Количество реакций: <b>9 (-2)</b>', 'Количество репостов: <b>5 (0)</b>', '',
    '<b>Пост:</b> Пост без текста https://t.me/c/1234567890/10',
    'Количество просмотров: нет данных', 'Количество реакций: <b>0</b> (нет данных за вчера)', 'Количество репостов: <b>0</b> (нет данных за вчера)',
  ].join('\n'));
  assert.ok(formatDailySummary({ ...summary, posts: [] }).endsWith('На канале пока нет постов.'));
});

async function harness(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'daily-summary-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'daily-summary.json');
  const store = createDailySummaryStore(channelId, filePath);
  const members = createMemberStore(path.join(directory, 'members.json'));
  let instant = new Date('2026-09-28T10:00:00Z');
  let posts = summary.posts;
  let previousPosts = [];
  let readFailure;
  let sendFailure = false;
  let requests = 0;
  let subscriberCount = 1234;
  const messages = [];
  const errors = [];
  let beforeReport = async () => {};
  function monitor(summaryStore = store) {
    return createDailySummaryMonitor({ summaryStore, memberStore: members, now: () => instant,
      getSubscriberCount: async () => subscriberCount,
      reader: { fetch: async ({ periodStart, periodEnd }) => {
        requests++;
        assert.ok(Date.parse(periodEnd) <= instant.getTime());
        assert.ok(Date.parse(periodStart) < Date.parse(periodEnd));
        if (readFailure) throw readFailure;
        return { channelId, posts, previousPosts, fetchedAt: instant.toISOString() };
      } },
      beforeReport: () => beforeReport(),
      sendMessage: async text => { if (sendFailure) throw new Error('Network failure'); messages.push(text); },
      logger: { log() {}, error: (...args) => errors.push(args) },
    });
  }
  await store.initialize(instant.toISOString());
  return { filePath, store, members, monitor, messages, errors, requests: () => requests,
    setSubscriberCount: value => { subscriberCount = value; },
    setTime: time => { instant = new Date(time); }, setPosts: value => { previousPosts = posts; posts = value; },
    failRead: error => { readFailure = error; }, failSend: value => { sendFailure = value; },
    beforeReport: action => { beforeReport = action; },
  };
}

test('counts joins and leaves in the exact report window, including re-joins and unknown arrivals', async t => {
  const h = await harness(t);
  const user = { id: 1, name: 'Test', username: null };
  const record = (action, occurredAt, id = 1) => h.members.recordMemberEvent({ action, occurredAt, user: { ...user, id }, source: { type: 'url' } });
  await record('joined', '2026-09-27T23:59:59.000Z');
  await record('left', '2026-09-28T00:00:00.000Z');
  await record('joined', '2026-09-28T10:00:00.000Z');
  await record('left', '2026-09-28T23:59:59.000Z');
  await record('left', '2026-09-28T12:00:00.000Z', 2);
  await record('joined', '2026-09-29T00:00:00.000Z');
  assert.deepEqual(await h.members.countEvents(summary.periodStart, summary.periodEnd), { joined: 1, left: 3 });
});

test('first activation does not send a stale report and each later day sends once despite concurrent checks and restarts', async t => {
  const h = await harness(t);
  const monitor = h.monitor();
  await monitor.checkPending();
  h.setTime('2026-09-29T03:59:59Z');
  await monitor.checkPending();
  assert.equal(h.requests(), 0);
  h.setTime('2026-09-29T04:00:00Z');
  await Promise.all([monitor.checkPending(), monitor.checkPending()]);
  assert.equal(h.messages.length, 1);
  assert.match(h.messages[0], /Общее число подписчиков: <b>1234<\/b>/);
  assert.equal(h.requests(), 1);
  await h.monitor(createDailySummaryStore(channelId, h.filePath)).checkPending();
  assert.equal(h.messages.length, 1);
  h.setTime('2026-09-30T04:00:00Z');
  h.setPosts(summary.posts.map(post => ({ ...post, views: 450, reactions: 10, forwards: 7 })));
  h.setSubscriberCount(1250);
  await monitor.checkPending();
  assert.equal(h.messages.length, 2);
  assert.match(h.messages[1], /Общее число подписчиков: <b>1250<\/b>/);
  assert.ok(h.messages[1].includes('Количество просмотров: <b>450 (+350)</b>'));
});

test('waits for queued channel updates before counting membership events', async t => {
  const h = await harness(t);
  h.beforeReport(() => h.members.recordMemberEvent({ action: 'joined', occurredAt: '2026-09-28T21:59:00.000Z',
    user: { id: 1, name: 'Test', username: null }, source: { type: 'url' } }));
  h.setTime('2026-09-29T04:00:00Z');
  await h.monitor().checkPending();
  assert.ok(h.messages[0].includes('Пользователей добавилось на канал: <b>1</b>'));
});

test('the running timer fires at 06:00, schedules the next check and stops without further sends', async t => {
  const h = await harness(t);
  const timers = [];
  let cleared;
  t.mock.method(global, 'setTimeout', (callback, delay) => {
    const timer = { callback, delay, unref() {} };
    timers.push(timer);
    return timer;
  });
  t.mock.method(global, 'clearTimeout', timer => { cleared = timer; });
  h.setTime('2026-09-29T03:59:59Z');
  const monitor = h.monitor();
  await monitor.start();
  assert.equal(timers[0].delay, 1000);
  assert.equal(h.messages.length, 0);
  h.setTime('2026-09-29T04:00:00Z');
  await timers[0].callback();
  assert.equal(h.messages.length, 1);
  assert.equal(timers[1].delay, 60000);
  await monitor.stop();
  assert.equal(cleared, timers[1]);
  h.setTime('2026-09-30T04:00:00Z');
  await timers[1].callback();
  assert.equal(h.messages.length, 1);
  assert.equal(timers.length, 2);
});

test('a failed send replays the persisted report after restart without fetching newer counters', async t => {
  const h = await harness(t);
  h.setTime('2026-09-29T04:00:00Z');
  h.failSend(true);
  await h.monitor().checkPending();
  const pending = (await h.store.getState()).reports['2026-09-28'];
  assert.equal(pending.status, 'pending');
  assert.equal(h.messages.length, 0);
  h.failSend(false);
  h.failRead(new Error('Should not fetch'));
  await h.monitor(createDailySummaryStore(channelId, h.filePath)).checkPending();
  assert.deepEqual(h.messages, [pending.text]);
  assert.equal(h.requests(), 1);
});

test('a failed acknowledgement retries saving without sending a duplicate in the same process', async t => {
  const h = await harness(t);
  const save = h.store.markSent;
  h.store.markSent = async () => { throw new Error('Disk full'); };
  h.setTime('2026-09-29T04:00:00Z');
  const monitor = h.monitor();
  await monitor.checkPending();
  assert.equal(h.messages.length, 1);
  h.store.markSent = save;
  h.setTime('2026-09-29T04:01:00Z');
  await monitor.checkPending();
  assert.equal(h.messages.length, 1);
  assert.equal((await h.store.getState()).reports['2026-09-28'].status, 'sent');
});

test('request failures respect FLOOD_WAIT and do not persist fabricated zero counters', async t => {
  const h = await harness(t);
  h.setTime('2026-09-29T04:00:00Z');
  h.failRead(Object.assign(new Error('FLOOD_WAIT'), { retryAfterSeconds: 120 }));
  const monitor = h.monitor();
  await monitor.checkPending();
  assert.equal(h.messages.length, 0);
  assert.deepEqual((await h.store.getState()).reports, {});
  h.setTime('2026-09-29T04:01:00Z');
  await monitor.checkPending();
  assert.equal(h.requests(), 1);
  h.setTime('2026-09-29T04:02:00Z');
  h.failRead(null);
  await monitor.checkPending();
  assert.equal(h.messages.length, 1);
});

test('after missed deliveries the latest calendar day uses historical API totals at both day boundaries', async t => {
  const h = await harness(t);
  const monitor = h.monitor();
  h.setTime('2026-09-29T04:00:00Z');
  await monitor.checkPending();
  h.setTime('2026-10-02T04:00:00Z');
  h.setPosts(summary.posts.map(post => ({ ...post, views: 150 })));
  await monitor.checkPending();
  assert.equal(h.messages.length, 2);
  assert.ok(h.messages[1].includes('150 (+50)'));
  assert.deepEqual(Object.keys((await h.store.getState()).reports), ['2026-09-28', '2026-10-01']);
});

test('a corrupt state file or another channel is preserved and cannot reset delivery history', async t => {
  const h = await harness(t);
  await assert.rejects(createDailySummaryStore('-1009876543210', h.filePath).getState(), /INVALID_STATE/);
  await writeFile(h.filePath, '{broken');
  h.setTime('2026-09-29T04:00:00Z');
  await h.monitor().checkPending();
  assert.equal(await readFile(h.filePath, 'utf8'), '{broken');
  assert.equal(h.messages.length, 0);
});

test('legacy 11:00 reports are preserved separately and never replayed or reused as calendar-day statistics', async t => {
  const h = await harness(t);
  const legacy = { date: '2026-09-28', periodStart: '2026-09-27T09:00:00.000Z',
    periodEnd: '2026-09-28T09:00:00.000Z', posts: summary.posts, text: 'Old 11:00 report', status: 'pending' };
  await writeFile(h.filePath, JSON.stringify({ version: 1, channelId, initializedAt: '2026-09-28T10:00:00.000Z',
    reports: { '2026-09-28': legacy } }));
  const raw = await readFile(h.filePath, 'utf8');
  const migrated = await h.store.getState();
  assert.equal(migrated.version, 4);
  assert.deepEqual(migrated.reports, {});
  assert.equal(await readFile(h.filePath, 'utf8'), raw);
  h.setTime('2026-09-29T04:00:00.000Z');
  await h.monitor().checkPending();
  assert.equal(h.messages.length, 1);
  assert.match(h.messages[0], /Статистика за 28\.09\.2026/);
  const saved = JSON.parse(await readFile(h.filePath, 'utf8'));
  assert.deepEqual(saved.legacyReports['2026-09-28'], legacy);
  assert.equal(saved.reports['2026-09-28'].kind, 'calendar_totals_reactions');
  assert.equal(saved.reports['2026-09-28'].periodEnd, '2026-09-29T00:00:00.000Z');
});

for (const version of [2, 3]) for (const status of ['pending', 'sent']) {
  test(`version ${version} reports are archived; ${status === 'sent' ? 'sent reports are not delivered twice' : 'pending reports are rebuilt'}`, async t => {
    const h = await harness(t);
    const legacy = { ...calendarWindow('2026-09-28'), kind: version === 2 ? 'calendar_day' : 'calendar_totals',
      posts: summary.posts, text: 'Old daily activity comparison', status };
    const legacyReports = { '2026-09-27': { text: 'Older 11:00 report' } };
    await writeFile(h.filePath, JSON.stringify({ version, channelId, initializedAt: '2026-09-28T10:00:00.000Z',
      legacyReports, reports: { [legacy.date]: legacy } }));
    h.setTime('2026-09-29T04:00:00.000Z');
    await h.monitor().checkPending();
    assert.equal(h.messages.length, status === 'sent' ? 0 : 1);
    assert.equal(h.requests(), status === 'sent' ? 0 : 1);
    assert.ok(h.messages.every(text => !text.includes('Old daily activity')));
    if (status === 'pending') {
      assert.match(h.messages[0], /Количество просмотров: <b>100 \(\+100\)<\/b>/);
      assert.equal((await h.store.getState()).reports[legacy.date].kind, 'calendar_totals_reactions');
    }
    h.setTime('2026-09-30T04:00:00.000Z');
    await h.monitor().checkPending();
    const saved = JSON.parse(await readFile(h.filePath, 'utf8'));
    assert.equal(saved.version, 4);
    assert.deepEqual(saved.legacyReports, legacyReports);
    assert.deepEqual(saved[version === 2 ? 'legacyActivityReports' : 'legacyReactionReports'][legacy.date], legacy);
    assert.equal(saved.reports['2026-09-29'].kind, 'calendar_totals_reactions');
    assert.equal(saved.reports['2026-09-29'].status, 'sent');
    assert.equal(h.messages.length, status === 'sent' ? 1 : 2);
  });
}
