const API_ORIGIN = 'https://promoteapi.telegram.org';

function promotedUsername(value) {
  if (typeof value !== 'string') return null;
  if (/^@[a-z0-9_]+$/i.test(value)) return value.slice(1).toLowerCase();
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || !['t.me', 'telegram.me'].includes(url.hostname)) return null;
    const name = url.pathname.split('/')[1];
    return /^[a-z0-9_]+$/i.test(name) ? name.toLowerCase() : null;
  } catch { return null; }
}

function createTelegramAdsReader({ token, channelId, getChannel, fetchImpl = fetch }) {
  async function request(method, parameters = {}) {
    try {
      const response = await fetchImpl(`${API_ORIGIN}/${method}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(parameters),
      });
      if (response.status === 429) {
        const error = new Error('ADS_RATE_LIMITED');
        const seconds = Number(response.headers.get('retry-after'));
        error.retryAfterSeconds = Number.isFinite(seconds) && seconds > 0 ? seconds : 60;
        throw error;
      }
      if (!response.ok) throw new Error(`ADS_HTTP_${response.status}`);
      const body = await response.json();
      if (body.ok !== true || !body.result) throw new Error('ADS_API_REQUEST_REJECTED');
      return body.result;
    } catch (error) {
      // Never propagate fetch errors, bodies, URLs or headers containing credentials.
      const safe = new Error(/^ADS_(RATE_LIMITED|HTTP_\d{3}|API_REQUEST_REJECTED)$/.test(error.message || '')
        ? error.message : 'ADS_REQUEST_FAILED');
      if (error.retryAfterSeconds) safe.retryAfterSeconds = error.retryAfterSeconds;
      throw safe;
    }
  }
  return {
    async fetch() {
      const channel = await getChannel();
      if (String(channel.id) !== String(channelId) || !channel.username) throw new Error('ADS_CHANNEL_USERNAME_UNAVAILABLE');
      const username = channel.username.toLowerCase();
      const account = await request('getCurrentAccount');
      if (typeof account.account_id !== 'string' || !account.account_id) throw new Error('ADS_INVALID_ACCOUNT');
      const ads = {};
      const seenIds = new Set();
      const offsets = new Set();
      let offset;
      let total;
      do {
        const page = await request('getAdsList', { limit: 100, ...(offset ? { offset } : {}) });
        if (!Array.isArray(page.ads) || !Number.isSafeInteger(page.total_count) || page.total_count < 0
          || (total !== undefined && page.total_count !== total)) throw new Error('ADS_INCOMPLETE_LIST');
        total = page.total_count;
        for (const ad of page.ads) {
          if (!Number.isSafeInteger(ad.ad_id) || ad.ad_id <= 0 || seenIds.has(ad.ad_id)) throw new Error('ADS_INVALID_LIST');
          seenIds.add(ad.ad_id);
          if (ad.action_type !== 'join' || promotedUsername(ad.promote_url) !== username) continue;
          if (!Number.isSafeInteger(ad.actions) || ad.actions < 0 || typeof ad.title !== 'string') throw new Error('ADS_INVALID_COUNTER');
          ads[ad.ad_id] = { adId: ad.ad_id, title: ad.title, actions: ad.actions, promoteUrl: ad.promote_url };
        }
        offset = page.next_offset;
        if (offset && (typeof offset !== 'string' || offsets.has(offset) || offsets.size >= 100)) throw new Error('ADS_INVALID_PAGINATION');
        if (offset) offsets.add(offset);
      } while (offset);
      if (seenIds.size !== total) throw new Error('ADS_INCOMPLETE_LIST');
      return { accountId: account.account_id, channelId, username, fetchedAt: new Date().toISOString(), ads };
    },
    async close() {},
  };
}

module.exports = { createTelegramAdsReader, promotedUsername };
