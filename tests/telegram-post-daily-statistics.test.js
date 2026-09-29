const assert = require('node:assert/strict');
const test = require('node:test');
const { Api } = require('teleproto');
const { calendarWindow, formatDailySummary } = require('../src/services/daily-summary.service');
const { dailyPostCounters, fetchDailyPostStatistics } = require('../src/services/telegram-post-daily-statistics.service');

const HOUR = 3600000;
const window = calendarWindow('2026-09-28');
const start = Date.parse(window.periodStart);
const post = { messageId: 1, postedAt: window.previousPeriodStart, views: 9999, reactions: 999, forwards: 99 };
function graph(times, columns) {
  return { columns: [['x', ...times], ...Object.entries(columns).map(([key, values]) => [key, ...values])],
    types: Object.fromEntries([['x', 'x'], ...Object.keys(columns).map(key => [key, 'step'])]),
    names: Object.fromEntries(Object.keys(columns).map(key => [key, key])) };
}

test('aggregates cumulative counters at UTC day boundaries, excluding today', () => {
  const times = Array.from({ length: 49 }, (_, index) => start - 24 * HOUR + index * HOUR);
  const values = times.map(time => time < start ? 2 : time < Date.parse(window.periodEnd) ? 3 : 999);
  const result = dailyPostCounters(post, graph(times, { Views: values, Shares: values }), window);
  assert.deepEqual(result, { current: { views: 120, forwards: 120 },
    previous: { views: 48, forwards: 48 } });
});

test('a new post has zero historical views and shares at the start of the day', () => {
  const recent = { ...post, postedAt: new Date(start + 10 * HOUR).toISOString(), forwards: 0 };
  const result = dailyPostCounters(recent, graph([start + 10 * HOUR, start + 11 * HOUR], { Views: [5, 7] }),
    window);
  assert.deepEqual(result, { current: { views: 12, forwards: 0 },
    previous: { views: 0, forwards: 0 } });
});

test('statistics still cover exactly 24 hours on dates when Podgorica changes its clocks', () => {
  for (const date of ['2026-03-29', '2026-10-25']) {
    const period = calendarWindow(date);
    const times = Array.from({ length: 24 }, (_, i) => Date.parse(period.periodStart) + i * HOUR);
    const data = graph(times, { Views: times.map(() => 1), Shares: times.map(() => 0) });
    const current = dailyPostCounters({ ...post, postedAt: period.periodStart }, data, period).current;
    assert.deepEqual(current, { views: 24, forwards: 0 });
  }
});

test('native daily graph buckets are used directly without redistributing counts across time zones', () => {
  const times = [start - 24 * HOUR, start, start + 24 * HOUR];
  const data = graph(times, { Views: [10, 20, 999], Shares: [1, 2, 99] });
  assert.deepEqual(dailyPostCounters(post, data, window), {
    current: { views: 30, forwards: 3 }, previous: { views: 10, forwards: 1 },
  });
});

test('the reported total includes all prior days and parentheses show growth during the report day', () => {
  for (const olderViews of [0, 40]) {
    const olderPost = { ...post, postedAt: new Date(start - 48 * HOUR).toISOString() };
    const times = [start - 48 * HOUR, start - 24 * HOUR, start, start + 24 * HOUR];
    const result = dailyPostCounters(olderPost,
      graph(times, { Views: [olderViews, 76, 25, 999], Shares: [0, 1, 0, 99] }),
      window);
    assert.deepEqual(result, {
      current: { views: olderViews + 101, forwards: 1 },
      previous: { views: olderViews + 76, forwards: 1 },
    });
    const text = formatDailySummary({ ...window, channelId: '-1001234567890', membership: { joined: 0, left: 0 },
      posts: [{ ...olderPost, ...result.current }], previousPosts: [{ messageId: post.messageId, ...result.previous }] });
    assert.ok(text.includes(`Количество просмотров: <b>${olderViews + 101} (+25)</b>`));
    assert.match(text, /Количество репостов: <b>1 \(0\)<\/b>/);
  }
});

test('a graph that covers yesterday but omits older history cannot provide cumulative totals', () => {
  const olderPost = { ...post, postedAt: new Date(start - 48 * HOUR).toISOString() };
  const data = graph([start - 24 * HOUR, start, start + 24 * HOUR], { Views: [76, 25, 999], Shares: [1, 0, 99] });
  const result = dailyPostCounters(olderPost, data, window);
  const unknown = { views: null, forwards: null };
  assert.deepEqual(result, { current: unknown, previous: unknown });
});

test('unavailable, truncated and coarse graphs do not fabricate historical totals or use current totals', () => {
  assert.deepEqual(dailyPostCounters(post, null, window).current, { views: null, forwards: null });
  const partial = graph([start + HOUR, start + 2 * HOUR], { Views: [5, 2] });
  assert.equal(dailyPostCounters(post, partial, window).current.views, null);
  const coarse = graph([start - 22 * HOUR, start + 2 * HOUR], { Views: [15, 20] });
  assert.equal(dailyPostCounters(post, coarse, window).current.views, null);
  const noShares = graph([start - HOUR, start], { Views: [5, 2] });
  assert.equal(dailyPostCounters(post, noShares, window).current.forwards, null);
});

test('bad counters, mismatched columns and unsorted timestamps are rejected', () => {
  for (const data of [graph([start, start + HOUR], { Views: [1, -1] }),
    graph([start, start + HOUR], { Views: [1] }), graph([start + HOUR, start], { Views: [1, 2] })]) {
    assert.throws(() => dailyPostCounters(post, data, window), /POST_DAILY_INVALID/);
  }
});

test('the Telegram reader uses historical graphs in the statistics DC, resolves async graphs and preserves unavailable data', async () => {
  const input = new Api.InputChannel({ channelId: 1234567890, accessHash: 123 });
  const requests = [];
  const data = graph([start, start + HOUR], { Views: [5, 7] });
  const client = { invoke: async (request, dc) => {
    requests.push({ request, dc });
    if (request instanceof Api.messages.GetHistory) {
      assert.equal(request.offsetDate, Date.parse(window.periodEnd) / 1000);
      return { messages: [new Api.Message({ id: 1, date: start / 1000,
        peerId: new Api.PeerChannel({ channelId: input.channelId }), post: true,
        message: 'Test', views: 9999, forwards: 0, reactions: { results: [
          { reaction: new Api.ReactionEmoji({ emoticon: '✍' }), count: 6 },
          { reaction: new Api.ReactionCustomEmoji({ documentId: 123 }), count: 7 },
          { reaction: new Api.ReactionCustomEmoji({ documentId: 456 }), count: 2 },
        ] } })] };
    }
    assert.equal(dc, 4);
    if (request instanceof Api.stats.GetMessageStats) {
      assert.equal(request.msgId, 1);
      return { viewsGraph: new Api.StatsGraphAsync({ token: 'graph-token' }),
        get reactionsByEmotionGraph() { assert.fail('An emotion graph must not be used as a message reaction counter'); } };
    }
    assert.ok(request instanceof Api.stats.LoadAsyncGraph);
    assert.equal(request.token, 'graph-token');
    return new Api.StatsGraph({ json: new Api.DataJSON({ data: JSON.stringify(data) }) });
  } };
  const result = await fetchDailyPostStatistics(client, input, { ...window, channelId: '-1001234567890' }, 4);
  assert.equal(result.posts[0].views, 12);
  assert.equal(result.posts[0].reactions, null);
  assert.equal(result.posts[0].currentReactions, 15);
  assert.equal(result.posts[0].forwards, 0);
  assert.deepEqual(result.previousPosts, [{ messageId: 1, views: 0, reactions: null, forwards: 0 }]);
  assert.equal(requests.length, 3);
});
