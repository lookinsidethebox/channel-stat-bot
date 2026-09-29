const { TIME_ZONE, reportWindow, shiftDate, formatDailySummary } = require('./daily-summary.service');

const dateTime = new Intl.DateTimeFormat('ru-RU', {
  timeZone: TIME_ZONE, dateStyle: 'short', timeStyle: 'short',
});
const formatTime = value => dateTime.format(new Date(value));

function createStatsReporter({ channelId, reader, summaryStore, memberStore, beforeReport = async () => {},
  now = () => new Date() }) {
  return async function getStats() {
    const window = reportWindow(now());
    const periodLabel = `Период: ${formatTime(window.periodStart)} — ${formatTime(window.periodEnd)} (Подгорица)`;
    const state = await summaryStore.getState();
    if (state.channelId !== channelId) throw new Error('DAILY_SUMMARY_CHANNEL_MISMATCH');
    const saved = state.reports[window.date];
    if (saved?.periodStart === window.periodStart && saved.periodEnd === window.periodEnd) {
      const previous = state.reports[shiftDate(window.date, -1)];
      return formatDailySummary(saved, previous?.posts || [], { periodLabel });
    }

    // A history cutoff selects the posts, not historical values of their counters.
    const snapshot = await reader.fetch({ before: window.periodEnd });
    if (snapshot.channelId !== channelId) throw new Error('DAILY_SUMMARY_CHANNEL_MISMATCH');
    await beforeReport();
    const membership = await memberStore.countEvents(window.periodStart, window.periodEnd);
    return formatDailySummary({ ...window, channelId, membership, posts: snapshot.posts }, [], {
      periodLabel, compareCounters: false,
      postCountersNote: `Счётчики на ${formatTime(snapshot.fetchedAt)} (Подгорица). Снимка за выбранный период нет; разница за сутки недоступна.`,
    });
  };
}

module.exports = { createStatsReporter };
