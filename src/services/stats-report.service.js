const { reportWindow, formatDailySummary } = require('./daily-summary.service');

async function buildDailyReport({ channelId, reader, memberStore, getSubscriberCount, reactionStatistics, beforeReport = async () => {}, window }) {
  let snapshot = await reader.fetch(window);
  if (snapshot.channelId !== channelId) throw new Error('DAILY_SUMMARY_CHANNEL_MISMATCH');
  if (reactionStatistics) snapshot = await reactionStatistics.enrich(snapshot, window);
  await beforeReport();
  const membership = await memberStore.countEvents(window.periodStart, window.periodEnd);
  const subscriberCount = await getSubscriberCount();
  return { ...window, kind: 'calendar_totals_reactions', channelId, membership, fetchedAt: snapshot.fetchedAt,
    subscriberCount, posts: snapshot.posts, previousPosts: snapshot.previousPosts };
}

function createStatsReporter({ channelId, reader, summaryStore, memberStore, getSubscriberCount, reactionStatistics, beforeReport = async () => {},
  now = () => new Date() }) {
  return async function getStats() {
    const window = reportWindow(now());
    const state = await summaryStore.getState();
    if (state.channelId !== channelId) throw new Error('DAILY_SUMMARY_CHANNEL_MISMATCH');
    const saved = state.reports[window.date];
    if (saved?.kind === 'calendar_totals_reactions' && saved.periodStart === window.periodStart && saved.periodEnd === window.periodEnd
      && saved.posts.every(post => post.reactionPeriod !== 'current')) {
      return formatDailySummary({ ...saved, subscriberCount: await getSubscriberCount() });
    }

    const report = await buildDailyReport({ channelId, reader, memberStore, getSubscriberCount, reactionStatistics, beforeReport, window });
    return formatDailySummary(report);
  };
}

module.exports = { createStatsReporter, buildDailyReport };
