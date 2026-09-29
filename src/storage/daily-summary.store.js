const { mkdir, readFile, writeFile, rename, rm } = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const path = require('node:path');

function createDailySummaryStore(channelId, filePath = path.join(__dirname, '../../data/daily-summary.json')) {
  let queue = Promise.resolve();
  async function read() {
    try {
      const state = JSON.parse(await readFile(filePath, 'utf8'));
      if (state.version !== 1 || state.channelId !== channelId || !Number.isFinite(Date.parse(state.initializedAt))
        || !state.reports || typeof state.reports !== 'object' || Array.isArray(state.reports)
        || Object.entries(state.reports).some(([date, report]) => !report || report.date !== date
          || !['pending', 'sent'].includes(report.status) || typeof report.text !== 'string'
          || !Array.isArray(report.posts) || !Number.isFinite(Date.parse(report.periodEnd)))) {
        throw new Error('DAILY_SUMMARY_INVALID_STATE');
      }
      return state;
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, channelId, initializedAt: null, reports: {} };
      throw error;
    }
  }
  function update(action) {
    const operation = queue.then(async () => {
      const state = await read();
      if (!action(state)) return;
      await mkdir(path.dirname(filePath), { recursive: true });
      const temporary = `${filePath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
        await rename(temporary, filePath);
      } finally { await rm(temporary, { force: true }); }
    });
    queue = operation.catch(() => {});
    return operation;
  }
  return {
    async getState() { await queue; return read(); },
    initialize(at) { return update(state => {
      if (state.initializedAt) return false;
      state.initializedAt = at;
      return true;
    }); },
    prepare(report) { return update(state => {
      if (state.reports[report.date]) return false;
      state.reports[report.date] = { ...report, status: 'pending' };
      return true;
    }); },
    markSent(date, sentAt) { return update(state => {
      const report = state.reports[date];
      if (!report || report.status === 'sent') return false;
      report.status = 'sent';
      report.sentAt = sentAt;
      return true;
    }); },
  };
}

module.exports = { createDailySummaryStore };
