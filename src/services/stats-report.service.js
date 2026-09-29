const { reportWindow, formatDailySummary } = require('./daily-summary.service');

async function buildDailyReport({ channelId, reader, memberStore, beforeReport = async () => {}, window }) {
  const snapshot = await reader.fetch(window);
  if (snapshot.channelId !== channelId) throw new Error('DAILY_SUMMARY_CHANNEL_MISMATCH');
  await beforeReport();
  const membership = await memberStore.countEvents(window.periodStart, window.periodEnd);
  return { ...window, kind: 'calendar_day', channelId, membership, fetchedAt: snapshot.fetchedAt,
    posts: snapshot.posts, previousPosts: snapshot.previousPosts };
}

function createStatsReporter({ channelId, reader, summaryStore, memberStore, beforeReport = async () => {},
  now = () => new Date() }) {
  return async function getStats() {
    const window = reportWindow(now());
    const state = await summaryStore.getState();
    if (state.channelId !== channelId) throw new Error('DAILY_SUMMARY_CHANNEL_MISMATCH');
    const saved = state.reports[window.date];
    if (saved?.kind === 'calendar_day' && saved.periodStart === window.periodStart && saved.periodEnd === window.periodEnd) {
      return formatDailySummary(saved);
    }

    const report = await buildDailyReport({ channelId, reader, memberStore, beforeReport, window });
    return formatDailySummary(report);
  };
}

module.exports = { createStatsReporter, buildDailyReport };
