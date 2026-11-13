const test = require('node:test');
const assert = require('node:assert/strict');
const { Api } = require('teleproto');
const { addPublicForwards } = require('../src/services/telegram-post-statistics.service');
const { applyReactionSnapshots } = require('../src/services/reaction-statistics.service');
const { formatDailySummary, calendarWindow } = require('../src/services/daily-summary.service');

const window = calendarWindow('2026-11-12');
const post = { messageId: 1, postedAt: '2026-11-10T12:00:00Z', forwards: 3, reactions: 1 };

test('public count uses the public total, not the returned page length', async () => {
  const client = { invoke: async (request, dc) => {
    assert.ok(request instanceof Api.stats.GetMessagePublicForwards);
    assert.equal(request.msgId, 1);
    assert.equal(dc, 4);
    return { count: 1, forwards: [] };
  } };
  assert.equal((await addPublicForwards(client, {}, [post], 4))[0].publicForwards, 1);
  for (const count of [-1, 4, undefined]) {
    assert.equal((await addPublicForwards({ invoke: async () => ({ count }) }, {}, [post], 4))[0].publicForwards, null);
  }
  assert.equal((await addPublicForwards({ invoke: async () => { throw Error('UNAVAILABLE'); } }, {}, [post], 4))[0].publicForwards, null);
  assert.equal((await addPublicForwards({ invoke: () => assert.fail() }, {}, [{ ...post, forwards: 0 }], 4))[0].publicForwards, 0);
});

test('midnight snapshots give public totals and daily growth in the requested position', () => {
  const snapshot = { channelId: '-1001234567890', posts: [{ ...post, currentPublicForwards: 9 }] };
  const state = { channelId: snapshot.channelId, reactionSnapshots: {
    [window.periodStart]: { posts: [{ ...post, publicForwards: 2 }] },
    [window.periodEnd]: { posts: [{ ...post, publicForwards: 2 }] },
  } };
  const render = value => formatDailySummary({ ...window, membership: { joined: 0, left: 0 }, ...value });
  const enriched = applyReactionSnapshots(snapshot, window, state);
  assert.match(render(enriched), /Количество репостов:.*\nИз них публичных репостов: <b>2 \(0\)<\/b>\nКоличество комментариев:/);
  state.reactionSnapshots[window.periodStart].posts[0].publicForwards = 1;
  assert.match(render(applyReactionSnapshots(snapshot, window, state)), /публичных репостов: <b>2 \(\+1\)<\/b>/);
  state.reactionSnapshots = {};
  assert.match(render(applyReactionSnapshots(snapshot, window, state)), /публичных репостов: <b>9<\/b> \(сейчас; нет данных за сутки\)/);
  for (const publicForwards of [0, null, undefined]) {
    assert.doesNotMatch(render({ ...snapshot, posts: [{ ...post, publicForwards }] }), /Из них публичных/);
  }
});
