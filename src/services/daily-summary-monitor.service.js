const { reportWindow, shiftDate, formatDailySummary } = require('./daily-summary.service');

function createDailySummaryMonitor({ reader, summaryStore, memberStore, sendMessage, beforeReport = async () => {},
  logger = console, now = () => new Date(), retryMs = 60000 }) {
  let queue = Promise.resolve();
  let timer;
  let stopping = false;
  let retryAt = 0;
  const delivered = new Set();

  async function sendPending() {
    const state = await summaryStore.getState();
    for (const report of Object.values(state.reports).sort((a, b) => a.date.localeCompare(b.date))) {
      if (report.status !== 'pending') continue;
      if (!delivered.has(report.date)) {
        await sendMessage(report.text);
        delivered.add(report.date);
      }
      await summaryStore.markSent(report.date, now().toISOString());
      delivered.delete(report.date);
      logger.log(`Daily summary sent for ${report.date}.`);
    }
  }

  async function check() {
    if (stopping || now().getTime() < retryAt) return;
    try {
      await summaryStore.initialize(now().toISOString());
      await sendPending();
      const state = await summaryStore.getState();
      const window = reportWindow(now());
      if (window.periodEnd < state.initializedAt || state.reports[window.date]) return;
      const snapshot = await reader.fetch({ before: window.periodEnd });
      if (snapshot.channelId !== state.channelId) throw new Error('DAILY_SUMMARY_CHANNEL_MISMATCH');
      await beforeReport();
      const membership = await memberStore.countEvents(window.periodStart, window.periodEnd);
      const report = { ...window, channelId: state.channelId, fetchedAt: snapshot.fetchedAt, membership, posts: snapshot.posts };
      const previous = state.reports[shiftDate(window.date, -1)];
      report.text = formatDailySummary(report, previous?.posts || []);
      await summaryStore.prepare(report);
      await sendPending();
    } catch (error) {
      const seconds = error.retryAfterSeconds || error.parameters?.retry_after || 0;
      retryAt = now().getTime() + Math.max(retryMs, seconds * 1000);
      logger.error('Daily summary failed:', /^[A-Z][A-Z0-9_]+$/.test(error.message || '') ? error.message : 'DAILY_SUMMARY_FAILED');
    }
  }

  function checkPending() {
    const operation = queue.then(check);
    queue = operation.catch(() => {});
    return operation;
  }

  function schedule() {
    if (stopping) return;
    const instant = now();
    const nextAt = Date.parse(reportWindow(instant).nextAt);
    const delay = Math.max(1, Math.min(60000, nextAt - instant.getTime()));
    timer = setTimeout(async () => { await checkPending(); schedule(); }, delay);
    timer.unref();
  }

  return {
    async start() {
      await summaryStore.initialize(now().toISOString());
      logger.log('Daily summary scheduled for 11:00 Europe/Podgorica.');
      schedule();
    },
    checkPending,
    async stop() { stopping = true; clearTimeout(timer); await queue; },
  };
}

module.exports = { createDailySummaryMonitor };
