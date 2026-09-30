const assert = require('node:assert/strict');
const test = require('node:test');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createMemberStore } = require('../src/storage/member.store');
const { createUrlPromosStore } = require('../src/storage/url-promos.store');
const { createUrlPromosService } = require('../src/services/url-promos.service');
const registerUrlPromoController = require('../src/controllers/url-promo.controller');
const { formatJoinNotification } = require('../src/services/member-notification.service');
const { createBot } = require('../src/bot');

async function setup(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'url-promos-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const memberStore = createMemberStore(path.join(dir, 'members.json'));
  const file = path.join(dir, 'url-promos.json');
  const store = createUrlPromosStore(file);
  const service = createUrlPromosService({ store, memberStore });
  async function join(id, addedAt, source = 'url') {
    await memberStore.recordMemberEvent({ action: 'joined', occurredAt: addedAt,
      user: { id, name: `User ${id}`, username: null }, source: { type: source },
    });
  }
  return { memberStore, store, service, file, join };
}

test('backfills URL joins in local calendar days, preserves Ads and survives restart', async t => {
  const h = await setup(t);
  await h.join(1, '2026-09-29T22:30:00.000Z'); // 30 Sep in Podgorica
  await h.join(2, '2026-10-01T21:59:59.000Z'); // 1 Oct
  await h.join(3, '2026-10-01T22:00:00.000Z'); // 2 Oct
  await h.join(4, '2026-09-30T10:00:00.000Z', 'ads');
  const result = await h.service.add({ title: 'Фикбук: диалоги', startDate: '2026-09-30', days: 2 });
  assert.equal(result.assigned, 2);
  const data = JSON.parse(await readFile(path.join(path.dirname(h.file), 'members.json'), 'utf8'));
  assert.equal(data.members[0].campaign.title, 'Фикбук: диалоги');
  assert.equal(data.members[1].campaign.attribution, 'scheduled_url_promo');
  assert.equal(data.members[2].campaign, undefined);
  assert.equal(data.members[3].campaign, undefined);
  assert.match(formatJoinNotification(data.members[0]), /Источник: URL \(Фикбук: диалоги\)$/);
  assert.equal((await createUrlPromosStore(h.file).read()).campaigns[0].title, 'Фикбук: диалоги');
  assert.equal(await h.service.sync(), 0);
});

test('late URL source resolution assigns the campaign; Ads stays untouched', async t => {
  const h = await setup(t);
  await h.service.add({ title: 'Статья', startDate: '2026-09-30', days: 1 });
  await h.memberStore.recordMemberEvent({ action: 'joined', occurredAt: '2026-09-30T13:00:00.000Z',
    user: { id: 2, name: 'Delayed', username: null }, source: { type: 'unknown' }, sourceLookup: { status: 'pending' } });
  await h.memberStore.resolveMemberSource({ userId: 2, addedAt: '2026-09-30T13:00:00.000Z',
    status: 'matched', source: { type: 'url' } });
  await h.join(3, '2026-09-30T14:00:00.000Z', 'ads');
  assert.equal(await h.service.sync(), 1);
  assert.equal((await h.memberStore.getMember(2, '2026-09-30T13:00:00.000Z')).campaign.title, 'Статья');
  assert.equal((await h.memberStore.getMember(3, '2026-09-30T14:00:00.000Z')).campaign, undefined);
});

test('rejects overlapping periods and invalid dates without changing saved campaigns', async t => {
  const h = await setup(t);
  await h.service.add({ title: 'First', startDate: '2026-09-30', days: 3 });
  await assert.rejects(h.service.add({ title: 'Second', startDate: '2026-10-02', days: 1 }), /URL_PROMO_OVERLAP/);
  assert.throws(() => h.store.add({ title: 'Bad', startDate: '2026-02-30', days: 1 }));
  assert.equal((await h.store.read()).campaigns.length, 1);
});

test('promo command asks for title, date, duration and saves only after valid answers', async () => {
  const handlers = {};
  const added = [];
  registerUrlPromoController({ command: (name, handler) => { handlers[name] = handler; },
    on: (name, handler) => { handlers.text = handler; } }, {
    urlPromos: { add: async input => { added.push(input); return { campaign: input, assigned: 2 }; } },
  });
  const replies = [];
  const context = { chat: { id: 7, type: 'private' }, message: { text: '' }, reply: async text => replies.push(text) };
  await handlers.promo(context);
  for (const value of ['Фикбук: диалоги', '31.02.2026', '30.09.2026', '0', '2']) {
    context.message.text = value;
    await handlers.text(context, async () => {});
  }
  assert.deepEqual(added, [{ title: 'Фикбук: диалоги', startDate: '2026-09-30', days: 2 }]);
  assert.match(replies.at(-1), /Уже добавившихся через URL: 2/);
});

test('assembled bot accepts the owner promo dialog and rejects another sender', async t => {
  const h = await setup(t);
  const bot = createBot({ token: 'test-token', ownerId: '123', channelId: '-100456' }, {
    memberStore: h.memberStore, urlPromosStore: h.store, logger: { log() {}, error() {} },
  });
  bot.botInfo = { id: 999, username: 'test_bot', first_name: 'Test', is_bot: true };
  const replies = [];
  bot.telegram.sendMessage = async (id, message) => { replies.push([id, message]); return { message_id: replies.length }; };
  bot.context.telegram = { sendMessage: bot.telegram.sendMessage };
  let updateId = 0;
  async function send(id, value) {
    await bot.handleUpdate({ update_id: ++updateId, message: {
      message_id: updateId, date: 1780000000, from: { id, is_bot: false, first_name: 'Test' },
      chat: { id, type: 'private' }, text: value,
      entities: value.startsWith('/') ? [{ type: 'bot_command', offset: 0, length: value.split(/\s/)[0].length }] : [],
    } });
  }
  await send(456, '/promo');
  assert.equal(replies.length, 0);
  for (const value of ['/promo', 'Фикбук', '30.09.2026', '2']) await send(123, value);
  assert.equal((await h.store.read()).campaigns[0].title, 'Фикбук');
  assert.match(replies.at(-1)[1], /URL-кампания «Фикбук» сохранена/);
});
