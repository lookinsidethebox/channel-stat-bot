const { Api } = require('teleproto');
const { fetchLatestPostStatistics } = require('./telegram-post-statistics.service');

const HOUR = 3600000;

function parseGraph(graph) {
  if (!graph) return null;
  if (!Array.isArray(graph.columns) || !graph.types || !graph.names) throw new Error('POST_DAILY_INVALID_GRAPH');
  const columns = graph.columns;
  if (columns.some(column => !Array.isArray(column) || typeof column[0] !== 'string')
    || new Set(columns.map(column => column[0])).size !== columns.length) throw new Error('POST_DAILY_INVALID_GRAPH');
  const axes = columns.filter(column => graph.types[column[0]] === 'x');
  if (axes.length !== 1) throw new Error('POST_DAILY_INVALID_GRAPH');
  const times = axes[0].slice(1);
  if (times.some((time, index) => !Number.isSafeInteger(time) || time < 0 || time % HOUR !== 0
    || (index > 0 && time <= times[index - 1]))) throw new Error('POST_DAILY_INVALID_GRAPH');
  const series = columns.filter(column => column !== axes[0]).map(column => {
    const values = column.slice(1);
    if (values.length !== times.length || values.some(value => !Number.isSafeInteger(value) || value < 0)) {
      throw new Error('POST_DAILY_INVALID_GRAPH');
    }
    return { name: graph.names[column[0]], values };
  });
  // Message statistics normally use hourly buckets. Larger buckets are only
  // usable when they do not cross the requested UTC-day boundaries.
  const step = times.length > 1 ? Math.min(...times.slice(1).map((time, index) => time - times[index])) : HOUR;
  return { times, series, step };
}

function countPeriod(graph, names, start, end, postedAt, total) {
  if (postedAt >= end) return 0;
  if (!graph) return null;
  const series = graph.series.filter(column => names.includes(column.name));
  if (!series.length || !graph.times.length) return total === 0 ? 0 : null;
  const first = graph.times[0];
  // A truncated graph must not turn missing history into zero activity.
  if (first > start && Math.floor(postedAt / graph.step) * graph.step < first) return null;
  let totalForPeriod = 0;
  for (let index = 0; index < graph.times.length; index++) {
    const time = graph.times[index];
    const bucketEnd = time + graph.step;
    if (bucketEnd <= start || time >= end) continue;
    if (time < start || bucketEnd > end) return null;
    for (const column of series) totalForPeriod += column.values[index];
  }
  if (!Number.isSafeInteger(totalForPeriod)) throw new Error('POST_DAILY_INVALID_COUNTER');
  return totalForPeriod;
}

function dailyPostCounters(post, viewsGraph, { periodStart, periodEnd }) {
  const views = parseGraph(viewsGraph);
  const start = Date.parse(periodStart);
  const end = Date.parse(periodEnd);
  const postedAt = Date.parse(post.postedAt);
  if (![start, end, postedAt].every(Number.isFinite) || start >= end) {
    throw new Error('POST_DAILY_INVALID_PERIOD');
  }
  function counters(from, to) {
    return {
      views: countPeriod(views, ['Views'], from, to, postedAt, post.views),
      forwards: countPeriod(views, ['Shares'], from, to, postedAt, post.forwards),
    };
  }
  // Both snapshots are cumulative from publication. Their difference is the
  // growth during the report day, not a comparison of two daily activity counts.
  return { current: counters(0, end), previous: counters(0, start) };
}

async function fetchDailyPostStatistics(client, inputChannel, options, statsDc) {
  const { channelId, periodEnd } = options;
  const history = await fetchLatestPostStatistics(client, inputChannel, { channelId, before: periodEnd });
  async function readGraph(graph) {
    if (graph instanceof Api.StatsGraphAsync) {
      graph = await client.invoke(new Api.stats.LoadAsyncGraph({ token: graph.token }), statsDc);
    }
    if (graph instanceof Api.StatsGraphError) return null;
    if (!(graph instanceof Api.StatsGraph)) throw new Error('POST_DAILY_INVALID_RESPONSE');
    return JSON.parse(graph.json.data);
  }
  const posts = [];
  const previousPosts = [];
  for (const post of history.posts) {
    const stats = await client.invoke(new Api.stats.GetMessageStats({ channel: inputChannel, msgId: post.messageId }), statsDc);
    const views = await readGraph(stats.viewsGraph);
    const { current, previous } = dailyPostCounters(post, views, options);
    // The emotion graph is not the complete message reaction counter. Keep the
    // actual current count separate from historical counters until snapshots
    // at the requested day boundaries are available.
    posts.push({ ...post, ...current, reactions: null, currentReactions: post.reactions });
    previousPosts.push({ messageId: post.messageId, ...previous, reactions: null });
  }
  return { channelId, fetchedAt: new Date().toISOString(), posts, previousPosts };
}

module.exports = { dailyPostCounters, fetchDailyPostStatistics };
