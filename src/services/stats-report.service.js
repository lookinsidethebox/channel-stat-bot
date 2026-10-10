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

module.exports = { buildDailyReport };
