const assert = require('node:assert/strict');
const { mkdtemp, rm, readFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { monthWindow, formatMonthlySummary, createMonthlyReporter } = require('../src/services/monthly-summary.service');
const { createMonthlySummaryMonitor } = require('../src/services/monthly-summary-monitor.service');
const { createMonthlySummaryStore } = require('../src/storage/monthly-summary.store');
const { createMemberStore } = require('../src/storage/member.store');

const channelId = '-1001234567890';

test('month boundaries use UTC while delivery is 08:00 Podgorica through DST', () => {
  assert.deepEqual(monthWindow(new Date('2026-11-01T06:59:59.000Z'), -1), {
    date: '2026-10', periodStart: '2026-10-01T00:00:00.000Z', periodEnd: '2026-11-01T00:00:00.000Z',
    sendAt: '2026-11-01T07:00:00.000Z',
  });
  assert.equal(monthWindow(new Date('2026-10-10T00:00:00.000Z'), -1).sendAt, '2026-10-01T06:00:00.000Z');
  assert.equal(monthWindow(new Date('2026-10-10T00:00:00.000Z'), 0).sendAt, '2026-11-01T07:00:00.000Z');
});

test('membership totals group only arrivals in the month and resolved campaigns', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'monthly-members-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createMemberStore(path.join(dir, 'members.json'));
  const user = id => ({ id, name: `User ${id}`, username: null });
  await store.recordMemberEvent({ action: 'joined', occurredAt: '2026-09-30T23:59:59.000Z', user: user(1), source: { type: 'url' } });
  await store.recordMemberEvent({ action: 'joined', occurredAt: '2026-10-01T00:00:00.000Z', user: user(2), source: { type: 'url' } });
  await store.recordMemberEvent({ action: 'joined', occurredAt: '2026-10-02T00:00:00.000Z', user: user(3), source: { type: 'ads' }, adsCampaign: { status: 'pending' } });
  await store.resolveMemberCampaign({ userId: 3, addedAt: '2026-10-02T00:00:00.000Z', status: 'matched', checkedAt: '2026-10-02T01:00:00.000Z',
    campaign: { adId: 1, title: 'Ads A' } });
  await store.recordMemberEvent({ action: 'joined', occurredAt: '2026-10-03T00:00:00.000Z', user: user(5), source: { type: 'ads' }, adsCampaign: { status: 'pending' } });
  await store.resolveMemberCampaign({ userId: 5, addedAt: '2026-10-03T00:00:00.000Z', status: 'matched', checkedAt: '2026-10-03T01:00:00.000Z',
    campaign: { adId: 2, title: 'Ads A' } });
  await store.recordMemberEvent({ action: 'left', occurredAt: '2026-10-31T23:59:59.000Z', user: user(1) });
  await store.recordMemberEvent({ action: 'joined', occurredAt: '2026-11-01T00:00:00.000Z', user: user(4), source: { type: 'ads' } });
  const result = await store.summarizePeriod('2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z');
  assert.deepEqual(result, { joined: 3, left: 1, sources: { url: 1, ads: 2 }, urlCampaigns: [],
    adsCampaigns: [{ title: 'Ads A', count: 1 }, { title: 'Ads A', count: 1 }] });
});

test('monthly formatting picks a separate winner for each metric, escapes titles, and repeats ties deterministically', () => {
  const posts = [
    { messageId: 10, postedAt: '2026-10-10T10:00:00.000Z', preview: 'A < B', views: 100, reactions: 3, forwards: 1, comments: 0 },
    { messageId: 11, postedAt: '2026-10-11T10:00:00.000Z', preview: 'Second', views: 90, reactions: 10, forwards: 2, comments: 2 },
    { messageId: 12, postedAt: '2026-10-12T10:00:00.000Z', preview: 'Third', views: 80, reactions: 5, forwards: 9, comments: 1 },
    { messageId: 13, postedAt: '2026-10-13T10:00:00.000Z', preview: 'Fourth', views: 70, reactions: 1, forwards: 0, comments: 10 },
  ];
  const text = formatMonthlySummary({ date: '2026-10', channelId, posts,
    membership: { joined: 3, left: 2, sources: { ads: 2, url: 1, search: 0 },
      urlCampaigns: [{ title: '<URL>', count: 1 }], adsCampaigns: [{ title: 'Ads A', count: 2 }] } });
  assert.match(text, /Пользователей добавилось на канал: <b>3<\/b>\nПользователей отписалось: <b>2<\/b>/);
  assert.match(text, /<b>Откуда приходили пользователи:<\/b>/);
  assert.match(text, /Ads: <b>2<\/b>/);
  assert.doesNotMatch(text, /Search:/);
  assert.match(text, /&lt;URL&gt;: <b>1<\/b>/);
  assert.deepEqual([...text.matchAll(/<b>Лучший пост по количеству ([^<]+):<\/b>\n<b>Пост:<\/b> [^\n]+\/(\d+)/g)]
    .map(match => [match[1], match[2]]), [
    ['просмотров', '10'], ['реакций', '11'], ['репостов', '12'], ['комментариев', '13'],
  ]);
  assert.match(text, /<b>Пост:<\/b> A &lt; B https:\/\/t\.me\/c\/1234567890\/10/);
  assert.match(text, /Количество комментариев: <b>10<\/b>\nДата публикации: <b>13\.10\.2026<\/b>/);
});

test('monthly delivery waits until the first at 08:00, saves once, and button reuses the previous report', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'monthly-delivery-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'monthly.json');
  const store = createMonthlySummaryStore(channelId, file);
  let instant = new Date('2026-11-01T06:59:59.000Z');
  let reads = 0;
  let drained = 0;
  const sent = [];
  const options = { channelId, summaryStore: store, now: () => instant,
    reader: { fetchMonthlyPosts: async window => {
      reads++;
      assert.equal(window.periodStart, '2026-10-01T00:00:00.000Z');
      return { channelId, fetchedAt: instant.toISOString(), posts: [] };
    } },
    memberStore: { summarizePeriod: async () => {
      assert.equal(drained, reads);
      return { joined: 1, left: 0, sources: { ads: 1 }, urlCampaigns: [], adsCampaigns: [] };
    } },
    beforeReport: async () => { drained++; },
  };
  const monitor = createMonthlySummaryMonitor({ ...options, sendMessage: async text => sent.push(text), logger: { log() {}, error() {} } });
  await monitor.checkPending();
  assert.deepEqual(sent, []);
  instant = new Date('2026-11-01T07:00:00.000Z');
  await Promise.all([monitor.checkPending(), monitor.checkPending()]);
  assert.equal(reads, 1);
  assert.equal(sent.length, 1);
  await monitor.stop();
  const saved = await readFile(file, 'utf8');
  assert.equal(JSON.parse(saved).reports['2026-10'].status, 'sent');
  const reporter = createMonthlyReporter(options);
  assert.equal(await reporter(-1), sent[0]);
  assert.equal(reads, 1);
  await createMonthlySummaryMonitor({ ...options, sendMessage: async text => sent.push(text), logger: { log() {}, error() {} } }).checkPending();
  assert.equal(sent.length, 1);
});

test('failed monthly delivery retries the saved report without another Telegram read', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'monthly-retry-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createMonthlySummaryStore(channelId, path.join(dir, 'monthly.json'));
  let instant = new Date('2026-11-01T06:59:00.000Z');
  let reads = 0;
  const sent = [];
  const options = { channelId, summaryStore: store, now: () => instant,
    reader: { fetchMonthlyPosts: async () => {
      reads++;
      return { channelId, fetchedAt: instant.toISOString(), posts: [] };
    } },
    memberStore: { summarizePeriod: async () => ({ joined: 0, left: 0, sources: {}, urlCampaigns: [], adsCampaigns: [] }) },
    logger: { log() {}, error() {} }, retryMs: 1000,
  };
  const monitor = createMonthlySummaryMonitor({ ...options,
    sendMessage: async () => { throw new Error('Telegram unavailable'); } });
  await monitor.checkPending();
  instant = new Date('2026-11-01T07:00:00.000Z');
  await monitor.checkPending();
  assert.equal(reads, 1);
  assert.equal((await store.getState()).reports['2026-10'].status, 'pending');
  await monitor.stop();
  await createMonthlySummaryMonitor({ ...options, sendMessage: async text => sent.push(text) }).checkPending();
  assert.equal(reads, 1);
  assert.equal(sent.length, 1);
  assert.equal((await store.getState()).reports['2026-10'].status, 'sent');
});
