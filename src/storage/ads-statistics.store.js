const { mkdir, readFile, writeFile, rename, rm } = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { membershipKey } = require('../services/source-statistics.service');

function validateAds(ads) {
  if (!ads || typeof ads !== 'object' || Array.isArray(ads)) throw new Error('ADS_INVALID_STATE');
  for (const [id, ad] of Object.entries(ads)) {
    if (!ad || String(ad.adId) !== id || !Number.isSafeInteger(ad.adId) || ad.adId <= 0
      || typeof ad.title !== 'string' || typeof ad.promoteUrl !== 'string'
      || !Number.isSafeInteger(ad.actions) || ad.actions < 0) throw new Error('ADS_INVALID_STATE');
  }
}

function applySnapshot(state, snapshot, members) {
  validateAds(snapshot.ads);
  if (snapshot.channelId !== state.channelId || !snapshot.accountId || !snapshot.username
    || !Number.isFinite(Date.parse(snapshot.fetchedAt))) throw new Error('ADS_INVALID_SNAPSHOT');
  if (state.accountId && (state.accountId !== snapshot.accountId || state.username !== snapshot.username)) {
    throw new Error('ADS_ACCOUNT_OR_CHANNEL_CHANGED');
  }
  if (state.lastCheckedAt && snapshot.fetchedAt < state.lastCheckedAt) throw new Error('ADS_STALE_SNAPSHOT');
  const first = !state.initializedAt;
  state.accountId = snapshot.accountId;
  state.username = snapshot.username;
  if (first) {
    state.initializedAt = snapshot.fetchedAt;
    state.baseline = snapshot.ads;
  }
  state.lastCheckedAt = snapshot.fetchedAt;
  state.days[snapshot.fetchedAt.slice(0, 10)] = { checkedAt: snapshot.fetchedAt, ads: snapshot.ads };
  const pending = [];
  function decide(member, status, reason, campaign, delta) {
    const key = membershipKey(member.userId, member.addedAt);
    state.decisions[key] = { userId: member.userId, addedAt: member.addedAt, checkedAt: snapshot.fetchedAt,
      status, ...(reason ? { reason } : {}), ...(campaign ? { campaign } : {}),
      ...(delta ? { delta, before: state.baseline, after: snapshot.ads } : {}),
    };
  }
  for (const member of members) {
    if (state.decisions[membershipKey(member.userId, member.addedAt)]) continue;
    if (member.addedAt <= state.initializedAt) decide(member, 'unresolved', 'no_prior_snapshot');
    else if (member.source?.type === 'ads') pending.push(member);
    else if (member.source?.type === 'unknown' && member.sourceLookup?.status === 'pending') pending.push(member);
    else decide(member, member.source?.type === 'unknown' ? 'unresolved' : 'not_applicable', 'source_is_not_ads');
  }
  const ids = Object.keys(snapshot.ads);
  // A newly created ad has an implicit zero baseline. Its first reported join
  // can still identify a pending member if it is the only matching increment.
  const changedSet = Object.keys(state.baseline).some(id => snapshot.ads[id]
    ? state.baseline[id].promoteUrl !== snapshot.ads[id].promoteUrl
    : state.baseline[id].actions !== 0);
  const delta = Object.fromEntries(ids.map(id => [id, snapshot.ads[id].actions - (state.baseline[id]?.actions || 0)]));
  const corrected = Object.values(delta).some(value => value < 0);
  if (changedSet || corrected) {
    for (const member of pending) decide(member, 'unresolved', changedSet ? 'campaign_set_changed' : 'counters_corrected', null, delta);
    state.baseline = snapshot.ads;
    return;
  }
  // Keep the same baseline while the channel statistics have not identified all arrivals.
  if (pending.some(member => member.source?.type !== 'ads')) return;
  const increased = ids.filter(id => delta[id] > 0);
  const total = Object.values(delta).reduce((sum, value) => sum + value, 0);
  if (pending.length && total < pending.length) return;
  if (pending.length) {
    for (const member of pending) {
      if (increased.length === 1 && total === pending.length) {
        const ad = snapshot.ads[increased[0]];
        decide(member, 'matched', null, { accountId: snapshot.accountId, adId: ad.adId,
          title: ad.title, attribution: 'statistics_delta' }, delta);
      } else decide(member, 'unresolved', 'ambiguous_delta', null, delta);
    }
  }
  state.baseline = snapshot.ads;
}

function createAdsStatisticsStore(channelId, filePath = path.join(__dirname, '../../data/ads-statistics.json')) {
  let queue = Promise.resolve();
  async function read() {
    let state;
    try { state = JSON.parse(await readFile(filePath, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return { version: 1, channelId, accountId: null, username: null,
        initializedAt: null, lastCheckedAt: null, baseline: {}, days: {}, decisions: {} };
      throw error;
    }
    if (state.version !== 1 || state.channelId !== channelId || !state.days || !state.decisions) throw new Error('ADS_INVALID_STATE');
    validateAds(state.baseline);
    return state;
  }
  return {
    async getState() { await queue; return read(); },
    applySnapshot(snapshot, members) {
      const operation = queue.then(async () => {
        const state = await read();
        applySnapshot(state, snapshot, members);
        await mkdir(path.dirname(filePath), { recursive: true });
        const temporary = `${filePath}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
          await rename(temporary, filePath);
        } finally { await rm(temporary, { force: true }); }
      });
      queue = operation.catch(() => {});
      return operation;
    },
  };
}

module.exports = { createAdsStatisticsStore };
