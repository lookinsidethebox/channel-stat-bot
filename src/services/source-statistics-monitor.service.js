const { membershipKey } = require('./source-statistics.service');

function createSourceStatisticsMonitor({ reader, statisticsStore, memberStore, onResolved = async () => {}, onChecked = async () => {}, logger = console, retryMs = 30000 }) {
  let queue = Promise.resolve();
  let timer;
  let retryAt = 0;
  let stopping = false;
  function serialized(action) {
    const operation = queue.then(async () => {
      const result = await action();
      await onChecked();
      return result;
    });
    queue = operation.catch(() => {});
    return operation;
  }
  async function applyDecisions(silentKey) {
    const state = await statisticsStore.getState();
    const pending = await memberStore.getPendingSourceLookups();
    let current;
    for (const member of pending) {
      const key = membershipKey(member.userId, member.addedAt);
      const decision = state.decisions[key];
      if (!decision) continue;
      const updated = await memberStore.resolveMemberSource(decision);
      if (!updated) continue;
      if (key === silentKey) current = updated;
      else if (updated.source.attribution === 'statistics_delta') {
        try { await onResolved(updated); }
        catch { logger.error('Failed to notify owner about a resolved membership source.'); }
      }
    }
    return current;
  }
  async function check(silentKey) {
    if (stopping) return;
    // Replay committed decisions after a crash between the two JSON writes.
    const recovered = await applyDecisions(silentKey);
    const pending = await memberStore.getPendingSourceLookups();
    const state = await statisticsStore.getState();
    if (!pending.length && state.initializedAt) return recovered;
    await statisticsStore.registerPending(pending);
    if (Date.now() < retryAt) return recovered;
    try {
      const snapshot = await reader.fetch();
      await statisticsStore.applySnapshot(snapshot);
      return await applyDecisions(silentKey) || recovered;
    } catch (error) {
      retryAt = Date.now() + Math.max(retryMs, (error.retryAfterSeconds || 0) * 1000);
      logger.error('Source statistics check failed:', error.message);
      return recovered;
    }
  }
  return {
    async start() {
      await serialized(() => check());
      timer = setInterval(() => serialized(() => check()).catch(error => logger.error('Source statistics state error:', error.message)), retryMs);
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

module.exports = { createSourceStatisticsMonitor };
