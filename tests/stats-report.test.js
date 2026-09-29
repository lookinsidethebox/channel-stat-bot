const assert = require('node:assert/strict');
const test = require('node:test');
const { mkdtemp, rm, readFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createStatsReporter } = require('../src/services/stats-report.service');
const { createDailySummaryStore } = require('../src/storage/daily-summary.store');
const { createMemberStore } = require('../src/storage/member.store');
const { reportWindow, formatDailySummary } = require('../src/services/daily-summary.service');

const channelId = '-1001234567890';
const posts = [{ messageId: 30, preview: '<Пост>', postedAt: '2026-09-29T08:00:00.000Z',
  views: 100, reactions: 5, forwards: 2 }];

async function setup(t, instant = '2026-09-29T12:00:00.000Z') {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'stats-report-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'summary.json');
  const summaryStore = createDailySummaryStore(channelId, filePath);
  const memberStore = createMemberStore(path.join(directory, 'members.json'));
  const requests = [];
  const options = { channelId, summaryStore, memberStore, now: () => new Date(instant),
    reader: { fetch: async query => {
      requests.push(query);
      return { channelId, posts, fetchedAt: instant };
    } },
  };
  return { options, summaryStore, memberStore, filePath, requests };
}

test('stats works before the first scheduled report and labels live counters without creating a baseline or outbox', async t => {
  const h = await setup(t);
  const user = { id: 1, name: 'Test', username: null };
  await h.memberStore.recordMemberEvent({ action: 'joined', occurredAt: '2026-09-28T09:00:00.000Z', user });
  await h.memberStore.recordMemberEvent({ action: 'left', occurredAt: '2026-09-29T08:59:59.000Z', user });
  await h.memberStore.recordMemberEvent({ action: 'joined', occurredAt: '2026-09-29T09:00:00.000Z', user });
  const getStats = createStatsReporter(h.options);
  const text = await getStats();
  assert.match(text, /Период: 28\.09\.2026, 11:00 — 29\.09\.2026, 11:00 \(Подгорица\)/);
  assert.match(text, /Пользователей добавилось на канал: 1\nПользователей отписалось: 1/);
  assert.match(text, /Счётчики на 29\.09\.2026, 14:00 \(Подгорица\)/);
  assert.match(text, /Пост: &lt;Пост&gt; https:\/\/t\.me\/c\/1234567890\/30/);
  assert.match(text, /Количество просмотров: 100 \(нет данных за период\)/);
  assert.doesNotMatch(text, /\(\+100\)/);
  assert.deepEqual(h.requests, [{ before: '2026-09-29T09:00:00.000Z' }]);
  assert.equal(await getStats(), text);
  await assert.rejects(readFile(h.filePath), { code: 'ENOENT' });
});

test('stats reuses an existing pending or sent report and its original daily deltas without changing delivery state', async t => {
  const h = await setup(t);
  await h.summaryStore.initialize('2026-09-27T12:00:00.000Z');
  const yesterday = { ...reportWindow(new Date('2026-09-28T12:00:00.000Z')), channelId,
    membership: { joined: 0, left: 0 }, posts: [{ ...posts[0], views: 70, reactions: 6, forwards: 0 }] };
  const today = { ...reportWindow(h.options.now()), channelId, membership: { joined: 7, left: 2 }, posts };
  for (const report of [yesterday, today]) {
    await h.summaryStore.prepare({ ...report, text: formatDailySummary(report) });
  }
  const getStats = createStatsReporter({ ...h.options,
    memberStore: { countEvents: () => assert.fail('A stored report must not be rebuilt') },
  });
  for (const status of ['pending', 'sent']) {
    if (status === 'sent') await h.summaryStore.markSent(today.date, h.options.now().toISOString());
    const before = await readFile(h.filePath, 'utf8');
    const text = await getStats();
    assert.match(text, /Пользователей добавилось на канал: 7\nПользователей отписалось: 2/);
    assert.match(text, /Количество просмотров: 100 \(\+30\)/);
    assert.match(text, /Количество реакций: 5 \(-1\)/);
    assert.match(text, /Количество репостов: 2 \(\+2\)/);
    assert.doesNotMatch(text, /Счётчики на/);
    assert.equal(await readFile(h.filePath, 'utf8'), before);
  }
  assert.deepEqual(h.requests, []);
});

test('stats before 11:00 selects the previous completed period, including a daylight-saving transition', async t => {
  const h = await setup(t, '2026-10-26T09:59:59.000Z');
  let counted;
  let drained = false;
  const getStats = createStatsReporter({ ...h.options,
    beforeReport: async () => { drained = true; },
    memberStore: { countEvents: async (from, to) => {
      assert.equal(drained, true);
      counted = [from, to];
      return { joined: 0, left: 0 };
    } },
  });
  const text = await getStats();
  assert.deepEqual(counted, ['2026-10-24T09:00:00.000Z', '2026-10-25T10:00:00.000Z']);
  assert.match(text, /24\.10\.2026, 11:00 — 25\.10\.2026, 11:00/);
});

test('stats rejects a foreign-channel snapshot or unreadable report storage instead of fabricating a summary', async t => {
  const h = await setup(t);
  await assert.rejects(createStatsReporter({ ...h.options,
    reader: { fetch: async () => ({ channelId: 'another', posts: [], fetchedAt: h.options.now().toISOString() }) },
  })(), /DAILY_SUMMARY_CHANNEL_MISMATCH/);
  await assert.rejects(createStatsReporter({ ...h.options,
    summaryStore: { getState: async () => { throw new Error('Read failed'); } },
  })(), /Read failed/);
  assert.deepEqual(h.requests, []);
});
