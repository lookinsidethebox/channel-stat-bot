const { monthWindow, buildMonthlyReport, formatMonthlySummary } = require('./monthly-summary.service');

function createMonthlySummaryMonitor({ channelId, reader, memberStore, summaryStore, sendMessage,
  beforeReport = async () => {}, logger = console, now = () => new Date(), retryMs = 60000 }) {
  let queue = Promise.resolve();
  let timer;
  let stopping = false;
  let retryAt = 0;
  const delivered = new Set();

  async function check() {
    if (stopping || now().getTime() < retryAt) return;
    try {
      await summaryStore.initialize(now().toISOString());
      let state = await summaryStore.getState();
      for (const report of Object.values(state.reports).sort((a, b) => a.date.localeCompare(b.date))) {
        if (report.status !== 'pending') continue;
        if (!delivered.has(report.date)) {
          await sendMessage(report.text);
          delivered.add(report.date);
        }
        await summaryStore.markSent(report.date, now().toISOString());
        delivered.delete(report.date);
      }
      state = await summaryStore.getState();
      const window = monthWindow(now(), -1);
      if (Date.parse(window.sendAt) > now().getTime() || window.sendAt < state.initializedAt
        || state.reports[window.date]) return;
      const report = await buildMonthlyReport({ channelId, reader, memberStore, beforeReport, window });
      report.text = formatMonthlySummary(report);
      await summaryStore.prepare(report);
      await sendMessage(report.text);
      delivered.add(report.date);
      await summaryStore.markSent(report.date, now().toISOString());
      delivered.delete(report.date);
    } catch (error) {
      const seconds = error.retryAfterSeconds || error.parameters?.retry_after || 0;
      retryAt = now().getTime() + Math.max(retryMs, seconds * 1000);
      logger.error('Monthly summary failed:', /^[A-Z][A-Z0-9_]+$/.test(error.message || '') ? error.message : 'MONTHLY_SUMMARY_FAILED');
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
    const next = monthWindow(instant, 0).sendAt;
    const delay = Math.max(1, Math.min(60000, Date.parse(next) - instant.getTime()));
    timer = setTimeout(async () => { await checkPending(); schedule(); }, delay);
    timer.unref();
  }

  return {
    async start() {
      await summaryStore.initialize(now().toISOString());
      logger.log('Monthly summary scheduled for 08:00 Europe/Podgorica on the 1st.');
      schedule();
    },
    checkPending,
    async stop() { stopping = true; clearTimeout(timer); await queue; },
  };
}

module.exports = { createMonthlySummaryMonitor };
