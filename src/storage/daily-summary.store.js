const { mkdir, readFile, writeFile, rename, rm } = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const path = require('node:path');

const REACTION_SNAPSHOT_GRACE_MS = 120000;
function validReactionSnapshot(snapshot, boundaryAt) {
  const boundary = Date.parse(boundaryAt);
  const captured = Date.parse(snapshot?.capturedAt);
  return Number.isFinite(boundary) && boundary % 86400000 === 0 && snapshot?.boundaryAt === boundaryAt
    && captured >= boundary && captured < boundary + REACTION_SNAPSHOT_GRACE_MS
    && Array.isArray(snapshot.posts)
    && new Set(snapshot.posts.map(post => post?.messageId)).size === snapshot.posts.length
    && snapshot.posts.every(post => Number.isSafeInteger(post?.messageId) && post.messageId > 0
      && Number.isFinite(Date.parse(post.postedAt)) && Date.parse(post.postedAt) < boundary
      && Number.isSafeInteger(post.reactions) && post.reactions >= 0);
}

function createDailySummaryStore(channelId, filePath = path.join(__dirname, '../../data/daily-summary.json')) {
  let queue = Promise.resolve();
  async function read() {
    try {
      const state = JSON.parse(await readFile(filePath, 'utf8'));
      if (![1, 2, 3, 4].includes(state.version) || state.channelId !== channelId || !Number.isFinite(Date.parse(state.initializedAt))
        || !state.reports || typeof state.reports !== 'object' || Array.isArray(state.reports)
        || Object.entries(state.reports).some(([date, report]) => !report || report.date !== date
          || !['pending', 'sent'].includes(report.status) || typeof report.text !== 'string'
          || !Array.isArray(report.posts) || !Number.isFinite(Date.parse(report.periodEnd)))) {
        throw new Error('DAILY_SUMMARY_INVALID_STATE');
      }
      // Old 11:00–11:00 reports are retained but never used as calendar days.
      if (state.version === 1) return { ...state, version: 4, legacyReports: state.reports, legacyActivityReports: {},
        legacyReactionReports: {}, reactionSnapshots: {}, reports: {} };
      // Version 2 compared daily activity; those values are not cumulative totals.
      if (state.version === 2) return { ...state, version: 4, legacyActivityReports: state.reports,
        legacyReactionReports: {}, reactionSnapshots: {}, reports: {} };
      // Emotion graph values must not become baselines for actual message reactions.
      if (state.version === 3) return { ...state, version: 4, legacyReactionReports: state.reports,
        reactionSnapshots: {}, reports: {} };
      if (!state.reactionSnapshots || typeof state.reactionSnapshots !== 'object' || Array.isArray(state.reactionSnapshots)
        || Object.entries(state.reactionSnapshots).some(([boundaryAt, snapshot]) => !validReactionSnapshot(snapshot, boundaryAt))) {
        throw new Error('DAILY_SUMMARY_INVALID_STATE');
      }
      return state;
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 4, channelId, initializedAt: null, reports: {}, legacyReports: {},
        legacyActivityReports: {}, legacyReactionReports: {}, reactionSnapshots: {} };
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
    saveReactionSnapshot(snapshot) { return update(state => {
      if (!validReactionSnapshot(snapshot, snapshot.boundaryAt)) throw new Error('REACTION_SNAPSHOT_INVALID');
      if (state.reactionSnapshots[snapshot.boundaryAt]) return false;
      state.initializedAt ??= snapshot.capturedAt;
      state.reactionSnapshots[snapshot.boundaryAt] = snapshot;
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

module.exports = { createDailySummaryStore, REACTION_SNAPSHOT_GRACE_MS };
