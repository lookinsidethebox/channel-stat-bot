const { membershipKey } = require('./source-statistics.service');

function createAdsStatisticsMonitor({ reader, statisticsStore, memberStore, onResolved = async () => {}, logger = console, retryMs = 30000 }) {
  let queue = Promise.resolve();
  let timer;
  let retryAt = 0;
  let stopping = false;
  function serialized(action) {
    const operation = queue.then(action);
    queue = operation.catch(() => {});
    return operation;
  }
  async function applyDecisions(silentKey) {
    const state = await statisticsStore.getState();
    for (const member of await memberStore.getPendingCampaignLookups()) {
      const key = membershipKey(member.userId, member.addedAt);
      const decision = state.decisions[key];
      if (!decision) continue;
      const updated = await memberStore.resolveMemberCampaign(decision);
      if (updated?.campaign && key !== silentKey) {
        try { await onResolved(updated); }
        catch { logger.error('Failed to notify owner about a resolved ad campaign.'); }
      }
    }
  }
  async function check(silentKey) {
    if (stopping) return;
    await applyDecisions(silentKey);
    const state = await statisticsStore.getState();
    if (state.initializedAt && !(await memberStore.getPendingCampaignLookups()).length) return;
    if (Date.now() < retryAt) return;
    try {
      const snapshot = await reader.fetch();
      // Include joins saved while the HTTP request was in flight.
      await statisticsStore.applySnapshot(snapshot, await memberStore.getPendingCampaignLookups());
      await applyDecisions(silentKey);
    } catch (error) {
      retryAt = Date.now() + Math.max(retryMs, (error.retryAfterSeconds || 0) * 1000);
      logger.error('Ads statistics check failed:', /^ADS_[A-Z0-9_]+$/.test(error.message || '') ? error.message : 'ADS_CHECK_FAILED');
    }
  }
  return {
    async start() {
      await serialized(() => check());
      timer = setInterval(() => serialized(() => check()).catch(() => logger.error('ADS_STATE_ERROR')), retryMs);
      timer.unref();
    },
    checkJoin(event) {
      return serialized(async () => {
        await check(membershipKey(event.user.id, event.occurredAt));
        return memberStore.getMember(event.user.id, event.occurredAt);
      });
    },
    checkPending() { return serialized(() => check()); },
    async stop() { stopping = true; clearInterval(timer); await queue; await reader.close(); },
  };
}

module.exports = { createAdsStatisticsMonitor };
