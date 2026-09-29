const assert = require('node:assert/strict');
const test = require('node:test');
const { mkdtemp, rm, writeFile, readFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { reportWindow, scheduledAt, formatDailySummary } = require('../src/services/daily-summary.service');
const { createDailySummaryMonitor } = require('../src/services/daily-summary-monitor.service');
const { createDailySummaryStore } = require('../src/storage/daily-summary.store');
const { createMemberStore } = require('../src/storage/member.store');

const channelId = '-1001234567890';
const summary = { channelId, periodStart: '2026-09-28T09:00:00.000Z',
  membership: { joined: 7, left: 2 }, posts: [
    { messageId: 30, preview: 'Текст <поста> & ссылка', postedAt: '2026-09-29T08:00:00Z', views: 100, reactions: 5, forwards: 2 },
    { messageId: 20, preview: 'Вчерашний пост', postedAt: '2026-09-27T08:00:00Z', views: 350, reactions: 9, forwards: 5 },
    { messageId: 10, preview: null, postedAt: '2026-09-26T08:00:00Z', views: null, reactions: 0, forwards: 0 },
  ] };

test('daily boundaries stay at 11:00 in Podgorica across both daylight-saving transitions', () => {
  assert.equal(scheduledAt('2026-09-29'), '2026-09-29T09:00:00.000Z');
  assert.equal(scheduledAt('2026-12-29'), '2026-12-29T10:00:00.000Z');
  for (const [date, hours, utcHour] of [['2026-03-29', 23, '09'], ['2026-10-25', 25, '10']]) {
    const window = reportWindow(new Date(`${date}T${utcHour}:00:00.000Z`));
    assert.equal(window.date, date);
    assert.equal((Date.parse(window.periodEnd) - Date.parse(window.periodStart)) / 3600000, hours);
  }
  assert.equal(reportWindow(new Date('2026-09-29T08:59:59Z')).date, '2026-09-28');
  assert.equal(reportWindow(new Date('2026-09-29T09:00:00Z')).date, '2026-09-29');
});

test('the summary uses bold headings, escaped previews and honest positive, negative and missing deltas', () => {
  const text = formatDailySummary(summary, [{ messageId: 20, views: 300, reactions: 11, forwards: 5 }]);
  assert.equal(text, [
    '<b>📈 Статистика за сутки</b>', '', 'Пользователей добавилось на канал: 7', 'Пользователей отписалось: 2', '',
    '<b>Информация по трем последним постам</b>', '',
    'Пост: Текст &lt;поста&gt; &amp; ссылка https://t.me/c/1234567890/30',
    'Количество просмотров: 100 (+100)', 'Количество реакций: 5 (+5)', 'Количество репостов: 2 (+2)', '',
    'Пост: Вчерашний пост https://t.me/c/1234567890/20',
    'Количество просмотров: 350 (+50)', 'Количество реакций: 9 (-2)', 'Количество репостов: 5 (0)', '',
    'Пост: Пост без текста https://t.me/c/1234567890/10',
    'Количество просмотров: нет данных', 'Количество реакций: 0 (нет данных за вчера)', 'Количество репостов: 0 (нет данных за вчера)',
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
  let readFailure;
  let sendFailure = false;
  let requests = 0;
  const messages = [];
  const errors = [];
  let beforeReport = async () => {};
  function monitor(summaryStore = store) {
    return createDailySummaryMonitor({ summaryStore, memberStore: members, now: () => instant,
      reader: { fetch: async ({ before }) => {
        requests++;
        assert.ok(Date.parse(before) <= instant.getTime());
        if (readFailure) throw readFailure;
        return { channelId, posts, fetchedAt: instant.toISOString() };
      } },
      beforeReport: () => beforeReport(),
      sendMessage: async text => { if (sendFailure) throw new Error('Network failure'); messages.push(text); },
      logger: { log() {}, error: (...args) => errors.push(args) },
    });
  }
  await store.initialize(instant.toISOString());
  return { filePath, store, members, monitor, messages, errors, requests: () => requests,
    setTime: time => { instant = new Date(time); }, setPosts: value => { posts = value; },
    failRead: error => { readFailure = error; }, failSend: value => { sendFailure = value; },
    beforeReport: action => { beforeReport = action; },
  };
}

test('counts joins and leaves in the exact report window, including re-joins and unknown arrivals', async t => {
  const h = await harness(t);
  const user = { id: 1, name: 'Test', username: null };
  const record = (action, occurredAt, id = 1) => h.members.recordMemberEvent({ action, occurredAt, user: { ...user, id }, source: { type: 'url' } });
  await record('joined', '2026-09-28T08:59:59.000Z');
  await record('left', '2026-09-28T09:00:00.000Z');
  await record('joined', '2026-09-28T10:00:00.000Z');
  await record('left', '2026-09-29T08:59:59.000Z');
  await record('left', '2026-09-28T12:00:00.000Z', 2);
  await record('joined', '2026-09-29T09:00:00.000Z');
  assert.deepEqual(await h.members.countEvents(summary.periodStart, '2026-09-29T09:00:00.000Z'), { joined: 1, left: 3 });
});

test('first activation does not send a stale report and each later day sends once despite concurrent checks and restarts', async t => {
  const h = await harness(t);
  const monitor = h.monitor();
  await monitor.checkPending();
  h.setTime('2026-09-29T08:59:59Z');
  await monitor.checkPending();
  assert.equal(h.requests(), 0);
  h.setTime('2026-09-29T09:00:00Z');
  await Promise.all([monitor.checkPending(), monitor.checkPending()]);
  assert.equal(h.messages.length, 1);
  assert.equal(h.requests(), 1);
  await h.monitor(createDailySummaryStore(channelId, h.filePath)).checkPending();
  assert.equal(h.messages.length, 1);
  h.setTime('2026-09-30T09:00:00Z');
  h.setPosts(summary.posts.map(post => ({ ...post, views: 450, reactions: 10, forwards: 7 })));
  await monitor.checkPending();
  assert.equal(h.messages.length, 2);
  assert.ok(h.messages[1].includes('Количество просмотров: 450 (+350)'));
});

test('waits for queued channel updates before counting membership events', async t => {
  const h = await harness(t);
  h.beforeReport(() => h.members.recordMemberEvent({ action: 'joined', occurredAt: '2026-09-29T08:59:00.000Z',
    user: { id: 1, name: 'Test', username: null }, source: { type: 'url' } }));
  h.setTime('2026-09-29T09:00:00Z');
  await h.monitor().checkPending();
  assert.ok(h.messages[0].includes('Пользователей добавилось на канал: 1'));
});

test('the running timer fires at 11:00, schedules the next check and stops without further sends', async t => {
  const h = await harness(t);
  const timers = [];
  let cleared;
  t.mock.method(global, 'setTimeout', (callback, delay) => {
    const timer = { callback, delay, unref() {} };
    timers.push(timer);
    return timer;
  });
  t.mock.method(global, 'clearTimeout', timer => { cleared = timer; });
  h.setTime('2026-09-29T08:59:59Z');
  const monitor = h.monitor();
  await monitor.start();
  assert.equal(timers[0].delay, 1000);
  assert.equal(h.messages.length, 0);
  h.setTime('2026-09-29T09:00:00Z');
  await timers[0].callback();
  assert.equal(h.messages.length, 1);
  assert.equal(timers[1].delay, 60000);
  await monitor.stop();
  assert.equal(cleared, timers[1]);
  h.setTime('2026-09-30T09:00:00Z');
  await timers[1].callback();
  assert.equal(h.messages.length, 1);
  assert.equal(timers.length, 2);
});

test('a failed send replays the persisted report after restart without fetching newer counters', async t => {
  const h = await harness(t);
  h.setTime('2026-09-29T09:00:00Z');
  h.failSend(true);
  await h.monitor().checkPending();
  const pending = (await h.store.getState()).reports['2026-09-29'];
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
  h.setTime('2026-09-29T09:00:00Z');
  const monitor = h.monitor();
  await monitor.checkPending();
  assert.equal(h.messages.length, 1);
  h.store.markSent = save;
  h.setTime('2026-09-29T09:01:00Z');
  await monitor.checkPending();
  assert.equal(h.messages.length, 1);
  assert.equal((await h.store.getState()).reports['2026-09-29'].status, 'sent');
});

test('request failures respect FLOOD_WAIT and do not persist fabricated zero counters', async t => {
  const h = await harness(t);
  h.setTime('2026-09-29T09:00:00Z');
  h.failRead(Object.assign(new Error('FLOOD_WAIT'), { retryAfterSeconds: 120 }));
  const monitor = h.monitor();
  await monitor.checkPending();
  assert.equal(h.messages.length, 0);
  assert.deepEqual((await h.store.getState()).reports, {});
  h.setTime('2026-09-29T09:01:00Z');
  await monitor.checkPending();
  assert.equal(h.requests(), 1);
  h.setTime('2026-09-29T09:02:00Z');
  h.failRead(null);
  await monitor.checkPending();
  assert.equal(h.messages.length, 1);
});

test('after several missed days only the latest report is prepared and older snapshots are not called yesterday', async t => {
  const h = await harness(t);
  const monitor = h.monitor();
  h.setTime('2026-09-29T09:00:00Z');
  await monitor.checkPending();
  h.setTime('2026-10-02T11:00:00Z');
  await monitor.checkPending();
  assert.equal(h.messages.length, 2);
  assert.ok(h.messages[1].includes('100 (нет данных за вчера)'));
  assert.deepEqual(Object.keys((await h.store.getState()).reports), ['2026-09-29', '2026-10-02']);
});

test('a corrupt state file or another channel is preserved and cannot reset delivery history', async t => {
  const h = await harness(t);
  await assert.rejects(createDailySummaryStore('-1009876543210', h.filePath).getState(), /INVALID_STATE/);
  await writeFile(h.filePath, '{broken');
  h.setTime('2026-09-29T09:00:00Z');
  await h.monitor().checkPending();
  assert.equal(await readFile(h.filePath, 'utf8'), '{broken');
  assert.equal(h.messages.length, 0);
});
