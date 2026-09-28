const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createMemberStore } = require('../src/storage/member.store');
const { createSourceStatisticsStore } = require('../src/storage/source-statistics.store');
const { createSourceStatisticsMonitor } = require('../src/services/source-statistics-monitor.service');
const { emptyCounts, parseSourceGraph, membershipKey } = require('../src/services/source-statistics.service');

const channelId = '-100123';
const day = '2026-09-28';
const counts = values => ({ ...emptyCounts(), ...values });
const snapshot = (values, time = '12:00:00', date = day) => ({
  channelId, fetchedAt: `${date}T${time}.000Z`, days: { [date]: counts(values) },
});
const join = (id, time, date = day, source = { type: 'unknown', name: null }) => ({
  channelId, action: 'joined', occurredAt: `${date}T${time}.000Z`,
  user: { id, name: `User ${id}`, username: null }, source, sourceLookup: { status: 'pending' },
});

async function harness(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'source-statistics-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const memberPath = path.join(dir, 'channel-members.json');
  const statsPath = path.join(dir, 'source-statistics.json');
  const memberStore = createMemberStore(memberPath);
  let statisticsStore = createSourceStatisticsStore(channelId, statsPath);
  let next = snapshot({}, '00:00:00');
  let requests = 0;
  const notifications = [];
  function monitor(store = memberStore) {
    statisticsStore = createSourceStatisticsStore(channelId, statsPath);
    return createSourceStatisticsMonitor({
      reader: { fetch: async () => { requests += 1; if (next instanceof Error) throw next; return next; }, close: async () => {} },
      memberStore: store, statisticsStore,
      onResolved: async member => notifications.push(member),
      logger: { error() {} },
    });
  }
  const instance = monitor();
  t.after(() => instance.stop());
  await instance.start();
  return { dir, memberPath, statsPath, memberStore, instance, monitor, notifications,
    setSnapshot: value => { next = value; }, requests: () => requests,
    state: () => statisticsStore.getState(),
  };
}

test('successive daily totals attribute Ads, URL, Ads and persist separately across restarts', async t => {
  const h = await harness(t);
  for (const [id, values, expected] of [[1, { ads: 1 }, 'ads'], [2, { ads: 1, url: 1 }, 'url'], [3, { ads: 2, url: 1 }, 'ads']]) {
    const event = join(id, `0${id}:00:00`);
    await h.memberStore.recordMemberEvent(event);
    h.setSnapshot(snapshot(values, `0${id}:00:01`));
    const current = h.monitor();
    const member = await current.checkJoin(event);
    await current.stop();
    assert.equal(member.source.type, expected);
    assert.equal(member.source.attribution, 'statistics_delta');
    assert.equal(member.sourceLookup.status, 'matched');
  }
  const members = JSON.parse(await fs.readFile(h.memberPath, 'utf8'));
  assert.deepEqual(Object.keys(members).sort(), ['latestPost', 'members']);
  assert.deepEqual((await h.state()).days[day].counts, counts({ ads: 2, url: 1 }));
  assert.equal(h.requests(), 4);
  assert.equal(h.notifications.length, 0);
});

test('unchanged statistics remain pending and a later refresh resolves the same member', async t => {
  const h = await harness(t);
  const event = join(1, '01:00:00');
  await h.memberStore.recordMemberEvent(event);
  h.setSnapshot(snapshot({}, '01:00:01'));
  const pending = await h.instance.checkJoin(event);
  assert.equal(pending.sourceLookup.status, 'pending');
  h.setSnapshot(snapshot({ ads: 1 }, '01:01:00'));
  await h.instance.checkPending();
  assert.equal((await h.memberStore.getMember(1, event.occurredAt)).source.type, 'ads');
  assert.equal(h.notifications.length, 1);
  await h.instance.checkPending();
  assert.equal(h.notifications.length, 1);
  assert.equal(h.requests(), 3);
});

test('partial and mixed increases do not consume counters for the wrong waiting user', async t => {
  const h = await harness(t);
  const one = join(1, '01:00:00');
  const two = join(2, '02:00:00');
  await h.memberStore.recordMemberEvent(one);
  await h.memberStore.recordMemberEvent(two);
  h.setSnapshot(snapshot({ ads: 1 }, '02:00:01'));
  await h.instance.checkPending();
  assert.deepEqual((await h.state()).days[day].counts, emptyCounts());
  assert.equal((await h.memberStore.getPendingSourceLookups()).length, 2);
  h.setSnapshot(snapshot({ ads: 1, url: 1 }, '02:01:00'));
  await h.instance.checkPending();
  for (const event of [one, two]) {
    const member = await h.memberStore.getMember(event.user.id, event.occurredAt);
    assert.equal(member.source.type, 'unknown');
    assert.equal(member.sourceLookup.reason, 'ambiguous_delta');
  }
});

test('a new UTC day starts from zero without borrowing yesterday counters', async t => {
  const h = await harness(t);
  const event = join(1, '00:00:01', '2026-09-29');
  await h.memberStore.recordMemberEvent(event);
  h.setSnapshot(snapshot({ search: 1 }, '00:00:02', '2026-09-29'));
  const member = await h.instance.checkJoin(event);
  assert.equal(member.source.type, 'search');
  assert.deepEqual((await h.state()).days[day].counts, emptyCounts());
});

test('manual and direct sources are preserved while their joins consume statistics deltas', async t => {
  const h = await harness(t);
  const source = { type: 'ads', name: null, attribution: 'manual', confirmedBy: 'owner' };
  const event = join(1, '01:00:00', day, source);
  await h.memberStore.recordMemberEvent(event);
  h.setSnapshot(snapshot({ url: 1 }, '01:00:01'));
  const member = await h.instance.checkJoin(event);
  assert.deepEqual(member.source, source);
  assert.equal(member.sourceLookup.statisticsSource, 'url');
  assert.deepEqual((await h.state()).days[day].counts, counts({ url: 1 }));
});

test('restart replays a committed statistics decision after the membership write failed', async t => {
  const h = await harness(t);
  const event = join(1, '01:00:00');
  await h.memberStore.recordMemberEvent(event);
  h.setSnapshot(snapshot({ ads: 1 }, '01:00:01'));
  const broken = h.monitor({ ...h.memberStore, resolveMemberSource: async () => { throw new Error('Disk full'); } });
  await broken.checkJoin(event);
  await broken.stop();
  assert.equal((await h.state()).decisions[membershipKey(1, event.occurredAt)].source.type, 'ads');
  assert.equal((await h.memberStore.getPendingSourceLookups()).length, 1);
  const restarted = h.monitor();
  t.after(() => restarted.stop());
  const previousRequests = h.requests();
  await restarted.start();
  assert.equal(h.requests(), previousRequests);
  assert.equal((await h.memberStore.getMember(1, event.occurredAt)).source.type, 'ads');
});

test('counter corrections do not fabricate a source and allow later deltas', async t => {
  const h = await harness(t);
  const one = join(1, '01:00:00');
  await h.memberStore.recordMemberEvent(one);
  h.setSnapshot(snapshot({ ads: 1 }, '01:00:01'));
  await h.instance.checkJoin(one);
  const two = join(2, '02:00:00');
  await h.memberStore.recordMemberEvent(two);
  h.setSnapshot(snapshot({ ads: 0, url: 1 }, '02:00:01'));
  const unresolved = await h.instance.checkJoin(two);
  assert.equal(unresolved.source.type, 'unknown');
  assert.equal(unresolved.sourceLookup.reason, 'counters_corrected');
  const three = join(3, '03:00:00');
  await h.memberStore.recordMemberEvent(three);
  h.setSnapshot(snapshot({ ads: 1, url: 1 }, '03:00:01'));
  assert.equal((await h.instance.checkJoin(three)).source.type, 'ads');
});

test('a corrupt statistics file is preserved and does not replace membership data', async t => {
  const h = await harness(t);
  await fs.writeFile(h.statsPath, '{broken');
  const event = join(1, '01:00:00');
  await h.memberStore.recordMemberEvent(event);
  await assert.rejects(h.instance.checkJoin(event));
  assert.equal(await fs.readFile(h.statsPath, 'utf8'), '{broken');
  assert.equal((await h.memberStore.getMember(1, event.occurredAt)).sourceLookup.status, 'pending');
});

test('graph parser maps all requested categories and rejects incomplete or invalid columns', () => {
  const x = Date.parse(day + 'T00:00:00.000Z');
  const graph = { columns: [['x', x], ['y0', 2], ['y1', 1]], types: { x: 'x', y0: 'bar', y1: 'bar' }, names: { y0: 'Ads', y1: 'URL' } };
  assert.deepEqual(parseSourceGraph(graph), { [day]: counts({ ads: 2, url: 1 }) });
  assert.throws(() => parseSourceGraph({ ...graph, columns: [['x', x], ['y0']] }));
  assert.throws(() => parseSourceGraph({ ...graph, columns: [['x', x], ['y0', -1]] }));
  assert.throws(() => parseSourceGraph({ ...graph, columns: [['x', x + 1000], ['y0', 1]] }));
});
