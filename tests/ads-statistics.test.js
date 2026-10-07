const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createMemberStore } = require('../src/storage/member.store');
const { createAdsStatisticsStore } = require('../src/storage/ads-statistics.store');
const { createAdsStatisticsMonitor } = require('../src/services/ads-statistics-monitor.service');
const { createTelegramAdsReader } = require('../src/services/telegram-ads.service');
const { membershipKey } = require('../src/services/source-statistics.service');

const channelId = '-100123';
const instant = hour => `2026-09-29T${String(hour).padStart(2, '0')}:00:00.000Z`;
const snapshot = (counts, time = instant(12)) => ({ channelId, accountId: 'account-a', username: 'example', fetchedAt: time,
  ads: Object.fromEntries(Object.entries(counts).map(([id, actions]) => [id,
    { adId: Number(id), title: `Ad ${id}`, actions, promoteUrl: 'https://t.me/example' }])),
});
const join = (id, source = { type: 'ads', attribution: 'statistics_delta' }) => ({
  action: 'joined', channelId, occurredAt: instant(id), user: { id, name: `User ${id}`, username: null },
  source, sourceLookup: { status: source.type === 'unknown' ? 'pending' : 'matched' }, adsCampaign: { status: 'pending' },
});

async function harness(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ads-statistics-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const memberPath = path.join(dir, 'channel-members.json');
  const statsPath = path.join(dir, 'ads-statistics.json');
  const members = createMemberStore(memberPath);
  let next = snapshot({ 1: 10, 2: 20 }, instant(0));
  let requests = 0;
  const notifications = [];
  const errors = [];
  function monitor(memberStore = members) {
    const instance = createAdsStatisticsMonitor({
      reader: { fetch: async () => { requests++; if (next instanceof Error) throw next; return next; }, close: async () => {} },
      statisticsStore: createAdsStatisticsStore(channelId, statsPath), memberStore,
      onResolved: async member => notifications.push(member), logger: { error: (...args) => errors.push(args.join(' ')) },
      retryMs: 5,
    });
    t.after(() => instance.stop());
    return instance;
  }
  const instance = monitor();
  // Initialize without a background timer; tests trigger each subsequent check explicitly.
  await instance.checkPending();
  return { dir, memberPath, statsPath, members, instance, monitor, notifications, errors,
    setSnapshot: value => { next = value; }, requests: () => requests,
    state: () => createAdsStatisticsStore(channelId, statsPath).getState(),
    member: event => members.getMember(event.user.id, event.occurredAt),
  };
}

test('successive campaign increments are attributed, persisted separately and survive restart', async t => {
  const h = await harness(t);
  for (const [id, values, adId] of [[1, { 1: 11, 2: 20 }, 1], [2, { 1: 11, 2: 21 }, 2], [3, { 1: 12, 2: 21 }, 1]]) {
    const event = join(id);
    await h.members.recordMemberEvent(event);
    h.setSnapshot(snapshot(values));
    const monitor = h.monitor();
    const result = await monitor.checkJoin(event);
    assert.equal(result.adsCampaign.adId, adId);
    assert.equal(result.adsCampaign.attribution, 'statistics_delta');
    assert.equal(result.adsCampaign.status, 'matched');
  }
  assert.equal(h.notifications.length, 0);
  assert.equal((await h.state()).baseline['1'].actions, 12);
  const data = JSON.parse(await fs.readFile(h.memberPath, 'utf8'));
  assert.deepEqual(Object.keys(data).sort(), ['latestPost', 'members']);
  assert.deepEqual(data.members.map(member => [member.adsCampaign.status, member.adsCampaign.adId]),
    [['matched', 1], ['matched', 2], ['matched', 1]]);
  assert.ok(data.members.every(member => !Object.hasOwn(member, 'campaign')
    && !Object.hasOwn(member, 'campaignLookup') && !Object.hasOwn(member, 'urlCampaign')));
  await h.instance.checkPending();
  assert.equal(h.requests(), 4);
});

test('holds counters until the source and Ads counters update, then notifies once', async t => {
  const h = await harness(t);
  const event = join(1, { type: 'unknown' });
  await h.members.recordMemberEvent(event);
  h.setSnapshot(snapshot({ 1: 11, 2: 20 }));
  await h.instance.checkJoin(event);
  assert.equal((await h.member(event)).adsCampaign.status, 'pending');
  assert.equal((await h.state()).baseline['1'].actions, 10);
  await h.members.resolveMemberSource({ userId: 1, addedAt: event.occurredAt, status: 'matched', source: { type: 'ads' } });
  await h.instance.checkPending();
  assert.equal((await h.member(event)).adsCampaign.adId, 1);
  await h.instance.checkPending();
  assert.equal(h.notifications.length, 1);
});

test('unchanged counters stay pending across UTC midnight', async t => {
  const h = await harness(t);
  const event = join(1);
  await h.members.recordMemberEvent(event);
  h.setSnapshot(snapshot({ 1: 10, 2: 20 }));
  assert.equal((await h.instance.checkJoin(event)).adsCampaign.status, 'pending');
  h.setSnapshot(snapshot({ 1: 10, 2: 21 }, '2026-09-30T00:00:01.000Z'));
  await h.instance.checkPending();
  assert.equal((await h.member(event)).adsCampaign.adId, 2);
  assert.equal(Object.keys((await h.state()).days).length, 2);
});

test('a new campaign with the sole join increment identifies a pending Ads member', async t => {
  const h = await harness(t);
  const event = join(1);
  await h.members.recordMemberEvent(event);
  h.setSnapshot(snapshot({ 1: 10, 2: 20, 3: 0, 4: 1, 5: 0 }));
  assert.equal((await h.instance.checkJoin(event)).adsCampaign.adId, 4);
  assert.equal((await h.state()).baseline['4'].actions, 1);
});

test('new campaigns remain eligible while Ads and source statistics update later', async t => {
  const h = await harness(t);
  const event = join(1, { type: 'unknown' });
  await h.members.recordMemberEvent(event);
  h.setSnapshot(snapshot({ 1: 10, 2: 20, 3: 0, 4: 0, 5: 0 }));
  await h.instance.checkJoin(event);
  assert.equal((await h.member(event)).adsCampaign.status, 'pending');
  h.setSnapshot(snapshot({ 1: 10, 2: 20, 3: 0, 4: 1, 5: 0 }));
  await h.instance.checkPending();
  assert.equal((await h.member(event)).adsCampaign.status, 'pending');
  await h.members.resolveMemberSource({ userId: 1, addedAt: event.occurredAt,
    status: 'matched', source: { type: 'ads' } });
  await h.instance.checkPending();
  assert.equal((await h.member(event)).adsCampaign.adId, 4);
});

test('removing a zero-action ad does not hide an increment while source statistics lag', async t => {
  const h = await harness(t);
  h.setSnapshot(snapshot({ 1: 10, 2: 20, 3: 0 }));
  await h.instance.checkPending();
  const event = join(1, { type: 'unknown' });
  await h.members.recordMemberEvent(event);
  h.setSnapshot(snapshot({ 1: 11, 2: 20, 4: 0 }));
  await h.instance.checkJoin(event);
  assert.equal((await h.member(event)).adsCampaign.status, 'pending');
  assert.equal((await h.state()).baseline['1'].actions, 10);
  await h.members.resolveMemberSource({ userId: 1, addedAt: event.occurredAt,
    status: 'matched', source: { type: 'ads' } });
  await h.instance.checkPending();
  assert.equal((await h.member(event)).adsCampaign.adId, 1);
});

test('a new campaign with more joins than pending members stays ambiguous', async t => {
  const h = await harness(t);
  const event = join(1);
  await h.members.recordMemberEvent(event);
  h.setSnapshot(snapshot({ 1: 10, 2: 20, 3: 2 }));
  assert.equal((await h.instance.checkJoin(event)).adsCampaign.reason, 'ambiguous_delta');
});

test('multiple pending Ads members can match one campaign, but a partial update is not consumed', async t => {
  const h = await harness(t);
  const events = [join(1), join(2)];
  for (const e of events) await h.members.recordMemberEvent(e);
  h.setSnapshot(snapshot({ 1: 11, 2: 20 }));
  await h.instance.checkPending();
  assert.equal((await h.state()).baseline['1'].actions, 10);
  h.setSnapshot(snapshot({ 1: 12, 2: 20 }));
  await h.instance.checkPending();
  for (const e of events) assert.equal((await h.member(e)).adsCampaign.adId, 1);
});

test('mixed campaigns and excess conversions remain unresolved', async t => {
  const h = await harness(t);
  for (const e of [join(1), join(2)]) await h.members.recordMemberEvent(e);
  h.setSnapshot(snapshot({ 1: 11, 2: 21 }));
  await h.instance.checkPending();
  for (const e of [join(1), join(2)]) {
    assert.equal((await h.member(e)).adsCampaign.reason, 'ambiguous_delta');
    assert.equal((await h.member(e)).adsCampaign.adId, undefined);
  }
  const third = join(3);
  await h.members.recordMemberEvent(third);
  h.setSnapshot(snapshot({ 1: 13, 2: 21 }));
  assert.equal((await h.instance.checkJoin(third)).adsCampaign.reason, 'ambiguous_delta');
});

test('deleted campaigns and corrected counters do not create false attributions', async t => {
  for (const [values, reason] of [[{ 1: 11, 2: 19 }, 'counters_corrected'], [{ 1: 11 }, 'campaign_set_changed']]) {
    const h = await harness(t);
    const e = join(1);
    await h.members.recordMemberEvent(e);
    h.setSnapshot(snapshot(values));
    assert.equal((await h.instance.checkJoin(e)).adsCampaign.reason, reason);
  }
});

test('does not change manual sources or assign an ad to a URL arrival', async t => {
  const h = await harness(t);
  const source = { type: 'url', attribution: 'manual', confirmedBy: 'owner' };
  const e = join(1, source);
  await h.members.recordMemberEvent(e);
  h.setSnapshot(snapshot({ 1: 11, 2: 20 }));
  const result = await h.instance.checkJoin(e);
  assert.deepEqual(result.source, source);
  assert.equal(result.adsCampaign, undefined);
});

test('no initial baseline means existing arrivals stay unresolved', async t => {
  const h = await harness(t);
  await fs.rm(h.statsPath);
  const e = join(1);
  await h.members.recordMemberEvent(e);
  h.setSnapshot(snapshot({ 1: 11, 2: 20 }));
  assert.equal((await h.instance.checkJoin(e)).adsCampaign.reason, 'no_prior_snapshot');
});

test('replays durable decisions after a failure between statistics and member writes', async t => {
  const h = await harness(t);
  const e = join(1);
  await h.members.recordMemberEvent(e);
  h.setSnapshot(snapshot({ 1: 11, 2: 20 }));
  const broken = h.monitor({ ...h.members, resolveMemberCampaign: async () => { throw new Error('disk error'); } });
  await broken.checkPending();
  assert.equal((await h.member(e)).adsCampaign.status, 'pending');
  assert.equal((await h.state()).decisions[membershipKey(1, e.occurredAt)].status, 'matched');
  const previousRequests = h.requests();
  h.setSnapshot(new Error('network unavailable'));
  await h.monitor().checkPending();
  assert.equal((await h.member(e)).adsCampaign.adId, 1);
  assert.equal(h.requests(), previousRequests);
});

test('rejects a different account and corrupted files without replacing state', async t => {
  const h = await harness(t);
  const store = createAdsStatisticsStore(channelId, h.statsPath);
  const previous = await fs.readFile(h.statsPath, 'utf8');
  await assert.rejects(store.applySnapshot({ ...snapshot({ 1: 11, 2: 20 }), accountId: 'another' }, []), /ADS_ACCOUNT_OR_CHANNEL_CHANGED/);
  assert.equal(await fs.readFile(h.statsPath, 'utf8'), previous);
  await fs.writeFile(h.statsPath, '{broken');
  await assert.rejects(store.applySnapshot(snapshot({ 1: 11, 2: 20 }), []));
  assert.equal(await fs.readFile(h.statsPath, 'utf8'), '{broken');
});

const ad = (id, overrides = {}) => ({ ad_id: id, title: `Ad ${id}`, actions: 4, action_type: 'join', promote_url: 'https://t.me/Example', ...overrides });
function fakeReader(responses, seen = []) {
  return createTelegramAdsReader({ token: 'fake-private-token', channelId,
    getChannel: async () => ({ id: channelId, username: 'Example' }),
    fetchImpl: async (url, options) => {
      seen.push({ url, options });
      const value = responses.shift();
      if (value instanceof Error) throw value;
      return { ok: true, status: 200, json: async () => value, headers: new Headers() };
    },
  });
}

test('Ads reader authenticates only to the official API, paginates and selects join ads for this channel', async () => {
  const seen = [];
  const reader = fakeReader([
    { ok: true, result: { account_id: 'a' } },
    { ok: true, result: { total_count: 4, ads: [ad(1, { status: 'stopped' }), ad(2, { action_type: 'page_view' })], next_offset: 'page2' } },
    { ok: true, result: { total_count: 4, ads: [ad(3, { promote_url: 'https://t.me/other' }), ad(4, { promote_url: 'https://t.me/example/123' })] } },
  ], seen);
  assert.deepEqual(Object.keys((await reader.fetch()).ads), ['1', '4']);
  assert.equal(JSON.parse(seen[2].options.body).offset, 'page2');
  for (const request of seen) {
    assert.equal(new URL(request.url).origin, 'https://promoteapi.telegram.org');
    assert.equal(request.options.headers.Authorization, 'Bearer fake-private-token');
    assert.equal(request.options.redirect, 'error');
    assert.ok(!request.url.includes('fake-private-token'));
  }
});

test('Ads reader rejects incomplete pagination and invalid counters', async () => {
  for (const result of [{ total_count: 2, ads: [ad(1)] }, { total_count: 1, ads: [ad(1, { actions: -1 })] }]) {
    await assert.rejects(fakeReader([{ ok: true, result: { account_id: 'a' } }, { ok: true, result }]).fetch(), /ADS_/);
  }
});

test('Ads reader does not leak credentials from HTTP errors or API error bodies', async () => {
  for (const response of [new Error('Authorization: Bearer fake-private-token'), { ok: false, error: 'fake-private-token' }]) {
    await assert.rejects(fakeReader([response]).fetch(), error => /^ADS_/.test(error.message) && !error.message.includes('fake-private-token'));
  }
});
