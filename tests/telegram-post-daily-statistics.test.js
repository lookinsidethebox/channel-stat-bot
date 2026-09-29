const assert = require('node:assert/strict');
const test = require('node:test');
const { Api } = require('teleproto');
const { calendarWindow } = require('../src/services/daily-summary.service');
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

test('aggregates hourly views, all reaction categories and shares for UTC calendar days, excluding today', () => {
  const times = Array.from({ length: 49 }, (_, index) => start - 24 * HOUR + index * HOUR);
  const values = times.map(time => time < start ? 2 : time < Date.parse(window.periodEnd) ? 3 : 999);
  const result = dailyPostCounters(post, graph(times, { Views: values, Shares: values }),
    graph(times, { Positive: values, Other: values }), window);
  assert.deepEqual(result, { current: { views: 72, reactions: 144, forwards: 72 },
    previous: { views: 48, reactions: 96, forwards: 48 } });
});

test('a new post has zero prior-day activity; sparse reaction history can start after publication', () => {
  const recent = { ...post, postedAt: new Date(start + 10 * HOUR).toISOString(), forwards: 0 };
  const result = dailyPostCounters(recent, graph([start + 10 * HOUR, start + 11 * HOUR], { Views: [5, 7] }),
    graph([start + 11 * HOUR], { Positive: [3], Other: [2] }), window);
  assert.deepEqual(result, { current: { views: 12, reactions: 5, forwards: 0 },
    previous: { views: 0, reactions: 0, forwards: 0 } });
});

test('statistics still cover exactly 24 hours on dates when Podgorica changes its clocks', () => {
  for (const date of ['2026-03-29', '2026-10-25']) {
    const period = calendarWindow(date);
    const times = Array.from({ length: 24 }, (_, i) => Date.parse(period.periodStart) + i * HOUR);
    const data = graph(times, { Views: times.map(() => 1), Shares: times.map(() => 0) });
    const current = dailyPostCounters({ ...post, postedAt: period.periodStart }, data,
      graph(times, { Positive: times.map(() => 1) }), period).current;
    assert.deepEqual(current, { views: 24, reactions: 24, forwards: 0 });
  }
});

test('native daily graph buckets are used directly without redistributing counts across time zones', () => {
  const times = [start - 24 * HOUR, start, start + 24 * HOUR];
  const data = graph(times, { Views: [10, 20, 999], Shares: [1, 2, 99] });
  const reactions = graph(times, { Positive: [3, 5, 77] });
  assert.deepEqual(dailyPostCounters(post, data, reactions, window), {
    current: { views: 20, reactions: 5, forwards: 2 }, previous: { views: 10, reactions: 3, forwards: 1 },
  });
});

test('unavailable, truncated and coarse graphs do not fabricate daily counters or use current totals', () => {
  assert.deepEqual(dailyPostCounters(post, null, null, window).current, { views: null, reactions: null, forwards: null });
  const partial = graph([start + HOUR, start + 2 * HOUR], { Views: [5, 2] });
  assert.equal(dailyPostCounters(post, partial, null, window).current.views, null);
  const coarse = graph([start - 22 * HOUR, start + 2 * HOUR], { Views: [15, 20] });
  assert.equal(dailyPostCounters(post, coarse, null, window).current.views, null);
  const noShares = graph([start - HOUR, start], { Views: [5, 2] });
  assert.equal(dailyPostCounters(post, noShares, null, window).current.forwards, null);
});

test('bad counters, mismatched columns and unsorted timestamps are rejected', () => {
  for (const data of [graph([start, start + HOUR], { Views: [1, -1] }),
    graph([start, start + HOUR], { Views: [1] }), graph([start + HOUR, start], { Views: [1, 2] })]) {
    assert.throws(() => dailyPostCounters(post, data, null, window), /POST_DAILY_INVALID/);
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
        message: 'Test', views: 9999, forwards: 0, reactions: { results: [{ count: 999 }] } })] };
    }
    assert.equal(dc, 4);
    if (request instanceof Api.stats.GetMessageStats) {
      assert.equal(request.msgId, 1);
      return { viewsGraph: new Api.StatsGraphAsync({ token: 'graph-token' }),
        reactionsByEmotionGraph: new Api.StatsGraphError({ error: 'Not enough data' }) };
    }
    assert.ok(request instanceof Api.stats.LoadAsyncGraph);
    assert.equal(request.token, 'graph-token');
    return new Api.StatsGraph({ json: new Api.DataJSON({ data: JSON.stringify(data) }) });
  } };
  const result = await fetchDailyPostStatistics(client, input, { ...window, channelId: '-1001234567890' }, 4);
  assert.equal(result.posts[0].views, 12);
  assert.equal(result.posts[0].reactions, null);
  assert.equal(result.posts[0].forwards, 0);
  assert.deepEqual(result.previousPosts, [{ messageId: 1, views: 0, reactions: 0, forwards: 0 }]);
  assert.equal(requests.length, 3);
});
