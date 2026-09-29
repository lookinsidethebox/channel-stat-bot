const assert = require('node:assert/strict');
const test = require('node:test');
const { Api } = require('teleproto');
const { fetchLatestPostStatistics } = require('../src/services/telegram-post-statistics.service');

const input = new Api.InputChannel({ channelId: 1234567890, accessHash: 123 });
const options = { channelId: '-1001234567890', before: '2026-09-29T09:00:00.000Z' };
const message = (id, extra = {}) => new Api.Message({ id, date: 1790668800,
  peerId: new Api.PeerChannel({ channelId: input.channelId }), post: true, message: `Post ${id}`,
  views: id * 10, forwards: id, ...extra });
function reader(pages, requests = []) {
  return { invoke: async request => {
    assert.equal(request.className, 'messages.GetHistory');
    requests.push(request);
    return { messages: pages.shift() || [] };
  } };
}

test('reads the latest five channel posts, counts all reactions, preserves media and truncates Unicode previews', async () => {
  const service = new Api.MessageService({ id: 40, date: 1790668800 });
  const posts = [service, message(30, { message: '😀'.repeat(101), reactions: { results: [{ count: 3 }, { count: 4 }] } }),
    message(20, { message: '' }), message(10), message(5), message(4), message(3)];
  const result = await fetchLatestPostStatistics(reader([posts]), input, options);
  assert.deepEqual(result.posts.map(post => post.messageId), [30, 20, 10, 5, 4]);
  assert.equal(Array.from(result.posts[0].preview).length, 100);
  assert.equal(result.posts[0].reactions, 7);
  assert.equal(result.posts[0].views, 300);
  assert.equal(result.posts[0].forwards, 30);
  assert.equal(result.posts[1].preview, null);
  assert.equal(result.posts[1].reactions, 0);
});

test('an album is one post using its first message counters and caption, without adding per-photo counters', async () => {
  const result = await fetchLatestPostStatistics(reader([[message(32, { groupedId: 44, message: '' }),
    message(31, { groupedId: 44, message: '' }), message(30, { groupedId: 44, message: 'Album caption' }),
    message(20), message(10)]]), input, options);
  assert.deepEqual(result.posts.map(post => post.messageId), [30, 20, 10]);
  assert.equal(result.posts[0].preview, 'Album caption');
  assert.equal(result.posts[0].views, 300);
});

test('paginates beyond service events and finishes the fifth post album across a page boundary', async () => {
  const first = [message(205), message(204), message(203), message(202),
    ...Array.from({ length: 95 }, (_, index) => new Api.MessageService({ id: 201 - index, date: 1790668800 }))];
  first.push(message(100, { groupedId: 44, message: '' }));
  const requests = [];
  const result = await fetchLatestPostStatistics(reader([first, [message(99, { groupedId: 44 }), message(90), message(80)]], requests), input, options);
  assert.equal(requests[1].offsetId, 100);
  assert.deepEqual(result.posts.map(post => post.messageId), [205, 204, 203, 202, 99]);
});

test('does not include posts published at or after the report boundary', async () => {
  const cutoff = Date.parse(options.before) / 1000;
  const result = await fetchLatestPostStatistics(reader([[message(30, { date: cutoff + 1 }), message(20, { date: cutoff }), message(10)]]), input, options);
  assert.deepEqual(result.posts.map(post => post.messageId), [10]);
});

test('missing counters remain unavailable, while empty channels have no invented posts', async () => {
  const result = await fetchLatestPostStatistics(reader([[message(10, { views: undefined, forwards: undefined })]]), input, options);
  assert.equal(result.posts[0].views, null);
  assert.equal(result.posts[0].forwards, null);
  assert.deepEqual((await fetchLatestPostStatistics(reader([[]]), input, options)).posts, []);
});

test('rejects malformed counters and foreign-channel results', async () => {
  for (const extra of [{ views: -1 }, { reactions: { results: [{ count: -1 }] } },
    { peerId: new Api.PeerChannel({ channelId: 5 }) }]) {
    await assert.rejects(fetchLatestPostStatistics(reader([[message(10, extra)]]), input, options), /POST_STATISTICS_INVALID/);
  }
});
