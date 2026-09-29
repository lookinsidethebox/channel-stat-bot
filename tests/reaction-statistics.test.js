const assert = require('node:assert/strict');
const test = require('node:test');
const { mkdtemp, rm, readFile, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createDailySummaryStore } = require('../src/storage/daily-summary.store');
const { createReactionStatistics, applyReactionSnapshots } = require('../src/services/reaction-statistics.service');
const { calendarWindow, formatDailySummary } = require('../src/services/daily-summary.service');

const channelId = '-1001234567890';
const window = calendarWindow('2026-09-28');
const post = { messageId: 128, postedAt: '2026-09-27T08:57:00.000Z', views: 101, forwards: 1,
  reactions: null, currentReactions: 19 };
const report = { channelId, posts: [post], previousPosts: [{ messageId: 128, views: 76, forwards: 1, reactions: null }] };
const snapshot = (boundaryAt, posts) => ({ boundaryAt, capturedAt: boundaryAt, posts });
const render = result => formatDailySummary({ ...window, membership: { joined: 0, left: 0 }, ...result });

test('without historical snapshots real message counts are displayed as current with no invented growth, even for new posts', () => {
  const posts = [15, 13, 19].map((currentReactions, i) => ({ ...post, messageId: 130 - i,
    postedAt: i === 2 ? post.postedAt : '2026-09-28T08:00:00.000Z', currentReactions }));
  const result = applyReactionSnapshots({ ...report, posts }, window, { channelId, reactionSnapshots: {} });
  assert.deepEqual(result.posts.map(post => post.reactions), [15, 13, 19]);
  const text = render(result);
  for (const count of [15, 13, 19]) assert.ok(text.includes(`Количество реакций: <b>${count}</b> (сейчас; нет данных за сутки)`));
  assert.doesNotMatch(text, /Количество реакций: <b>\d+ \(/);
});

test('midnight counters determine the day-end total and net growth; newer live counts and graph baselines are ignored', () => {
  const state = { channelId, reactionSnapshots: {
    [window.periodStart]: snapshot(window.periodStart, [{ ...post, reactions: 15 }]),
    [window.periodEnd]: snapshot(window.periodEnd, [{ ...post, reactions: 17 }]),
  } };
  const result = applyReactionSnapshots({ ...report, previousPosts: [{ ...report.previousPosts[0], reactions: 10 }] }, window, state);
  assert.match(render(result), /Количество реакций: <b>17 \(\+2\)<\/b>/);
  assert.match(render(result), /Количество просмотров: <b>101 \(\+25\)<\/b>/);
  assert.match(render(result), /Количество репостов: <b>1 \(0\)<\/b>/);
  state.reactionSnapshots[window.periodEnd].posts[0].reactions = 12;
  assert.match(render(applyReactionSnapshots(report, window, state)), /Количество реакций: <b>12 \(-3\)<\/b>/);
});

test('a new post starts at zero; an older post missing its baseline keeps growth unavailable', () => {
  const state = { channelId, reactionSnapshots: {
    [window.periodEnd]: snapshot(window.periodEnd, [{ ...post, reactions: 17 }]),
  } };
  assert.match(render(applyReactionSnapshots(report, window, state)), /Количество реакций: <b>17<\/b> \(нет данных за вчера\)/);
  const newPost = { ...post, postedAt: window.periodStart };
  assert.match(render(applyReactionSnapshots({ ...report, posts: [newPost] }, window, state)), /Количество реакций: <b>17 \(\+17\)<\/b>/);
  assert.throws(() => applyReactionSnapshots(report, window, { channelId: 'another', reactionSnapshots: {} }), /CHANNEL_MISMATCH/);
});

async function harness(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'reaction-statistics-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'summary.json');
  const store = createDailySummaryStore(channelId, filePath);
  let instant = new Date('2026-09-28T23:59:59.000Z');
  let posts = [{ ...post, reactions: 19 }];
  let responseChannel = channelId;
  let failure;
  let onFetch = () => {};
  const requests = [];
  const errors = [];
  const monitors = [];
  const create = () => {
    const monitor = createReactionStatistics({ summaryStore: createDailySummaryStore(channelId, filePath),
      now: () => instant, logger: { error: (...args) => errors.push(args) },
      reader: { fetchPosts: async options => {
        requests.push(options);
        onFetch();
        if (failure) throw failure;
        return { channelId: responseChannel, posts };
      } },
    });
    monitors.push(monitor);
    return monitor;
  };
  t.after(async () => { for (const monitor of monitors) await monitor.stop(); });
  return { create, store, requests, errors, filePath, setTime: value => { instant = new Date(value); },
    setPosts: value => { posts = value; }, fail: value => { failure = value; }, onFetch: fn => { onFetch = fn; },
    setChannel: value => { responseChannel = value; } };
}

test('timer captures actual counters at midnight UTC, persists them, and never overwrites them after restart', async t => {
  const h = await harness(t);
  const timers = [];
  const cleared = [];
  t.mock.method(global, 'setTimeout', (callback, delay) => {
    const timer = { callback, delay, unref() {} };
    timers.push(timer);
    return timer;
  });
  t.mock.method(global, 'clearTimeout', timer => cleared.push(timer));
  const monitor = h.create();
  await monitor.start();
  assert.equal(h.requests.length, 0);
  assert.equal(timers[0].delay, 1000);
  h.setTime('2026-09-29T00:00:00.000Z');
  await timers[0].callback();
  await Promise.all([monitor.checkPending(), monitor.checkPending()]);
  assert.deepEqual(h.requests, [{ before: window.periodEnd }]);
  const saved = (await h.store.getState()).reactionSnapshots[window.periodEnd];
  assert.deepEqual(saved.posts, [{ messageId: 128, postedAt: post.postedAt, reactions: 19 }]);
  h.setPosts([{ ...post, reactions: 30 }]);
  await h.create().checkPending();
  assert.equal(h.requests.length, 1);
  assert.deepEqual((await h.store.getState()).reactionSnapshots[window.periodEnd], saved);
  await monitor.stop();
  assert.equal(cleared.at(-1), timers.at(-1));
  const result = await h.create().enrich(report, window);
  assert.match(render(result), /Количество реакций: <b>19<\/b> \(нет данных за вчера\)/);
});

test('late starts and requests that finish outside the midnight window do not backdate current counts', async t => {
  const h = await harness(t);
  h.setTime('2026-09-29T11:00:00.000Z');
  await h.create().checkPending();
  assert.equal(h.requests.length, 0);
  h.setTime('2026-09-30T00:00:00.000Z');
  h.onFetch(() => h.setTime('2026-09-30T00:02:00.000Z'));
  await h.create().checkPending();
  assert.equal(h.requests.length, 1);
  assert.deepEqual((await h.store.getState()).reactionSnapshots, {});
});

test('snapshot retries respect FLOOD_WAIT and a missed day is not turned into zero growth', async t => {
  const h = await harness(t);
  const monitor = h.create();
  h.setTime('2026-09-29T00:00:00.000Z');
  h.fail(Object.assign(new Error('FLOOD_WAIT'), { retryAfterSeconds: 120 }));
  await monitor.checkPending();
  h.setTime('2026-09-29T00:00:30.000Z');
  await monitor.checkPending();
  assert.equal(h.requests.length, 1);
  h.fail(null);
  h.setTime('2026-09-29T00:02:00.000Z');
  await monitor.checkPending();
  assert.equal(h.requests.length, 1);
  assert.deepEqual((await h.store.getState()).reactionSnapshots, {});
  h.setTime('2026-09-30T00:00:00.000Z');
  await monitor.checkPending();
  const result = await monitor.enrich(report, calendarWindow('2026-09-29'));
  assert.equal(result.previousPosts[0].reactions, null);
  assert.equal(result.posts[0].reactions, 19);
});

test('invalid snapshots and foreign channels cannot overwrite stored data', async t => {
  const h = await harness(t);
  await h.store.initialize('2026-09-28T12:00:00.000Z');
  const raw = await readFile(h.filePath, 'utf8');
  for (const entry of [
    snapshot(window.periodEnd, [{ ...post, reactions: -1 }]),
    snapshot(window.periodEnd, [{ ...post, reactions: 1 }, { ...post, reactions: 2 }]),
    { ...snapshot(window.periodEnd, []), capturedAt: '2026-09-29T12:00:00.000Z' },
  ]) await assert.rejects(h.store.saveReactionSnapshot(entry), /REACTION_SNAPSHOT_INVALID/);
  assert.equal(await readFile(h.filePath, 'utf8'), raw);
  h.setTime(window.periodEnd);
  h.setChannel('another');
  await h.create().checkPending();
  assert.equal(await readFile(h.filePath, 'utf8'), raw);
  await writeFile(h.filePath, '{broken');
  await h.create().checkPending();
  assert.equal(await readFile(h.filePath, 'utf8'), '{broken');
});

test('report and reaction-snapshot writes share the storage queue and preserve both records', async t => {
  const h = await harness(t);
  await h.store.initialize('2026-09-28T12:00:00.000Z');
  await Promise.all([
    h.store.saveReactionSnapshot(snapshot(window.periodEnd, [{ ...post, reactions: 19 }])),
    h.store.prepare({ ...window, ...report, text: 'Report' }),
  ]);
  const state = await h.store.getState();
  assert.equal(state.reports[window.date].status, 'pending');
  assert.equal(state.reactionSnapshots[window.periodEnd].posts[0].reactions, 19);
});
