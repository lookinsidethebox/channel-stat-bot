const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createBot } = require('../src/bot');
const { createAntiSpamStore } = require('../src/storage/anti-spam.store');

function message(from, chat, text, extra = {}) {
  return { update_id: Math.floor(Math.random() * 1000000), message: {
    message_id: 7, date: 1, from, chat, text,
    entities: text?.startsWith('/') ? [{ type: 'bot_command', offset: 0, length: text.split(/\s/)[0].length }] : [],
    ...extra,
  } };
}

async function harness(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'anti-spam-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createAntiSpamStore(path.join(dir, 'anti-spam.json'));
  const calls = [];
  const bot = createBot({ token: 'test-token', ownerId: '123', channelId: '-100456', discussionGroupId: '-100789' }, {
    antiSpamStore: store,
    urlPromosStore: { read: async () => ({ version: 1, campaigns: [] }) },
    logger: { error: (...args) => calls.push(['error', ...args]) },
  });
  bot.botInfo = { id: 999, username: 'test_bot', first_name: 'Test', is_bot: true };
  bot.context.telegram = {
    sendMessage: async (...args) => { calls.push(['send', ...args]); },
    deleteMessage: async (...args) => { calls.push(['delete', ...args]); },
    callApi: async (...args) => { calls.push(['api', ...args]);
      if (args[0] === 'getChatMember') return { user: { id: 555, username: 'nitin' } };
      return true;
    },
  };
  return { bot, store, calls };
}
const owner = { id: 123, first_name: 'Owner' };
const user = { id: 555, first_name: 'Nitin', username: 'Nitin' };
const privateChat = { id: 123, type: 'private' };
const group = { id: -100789, type: 'supergroup' };

test('phrase survives storage and bans even when deletion fails', async t => {
  const { bot, store, calls } = await harness(t);
  await bot.handleUpdate(message(owner, privateChat, '/spam_add abactor @zfbsdiipebot allotriophagia'));
  assert.deepEqual((await store.read()).phrases, ['abactor @zfbsdiipebot allotriophagia']);
  bot.context.telegram.deleteMessage = async () => { throw new Error('already deleted'); };
  await bot.handleUpdate(message(user, group, 'ABACTOR  @zfbsdiipebot allotriophagia'));
  assert.ok(calls.some(call => call[0] === 'api' && call[1] === 'banChatMember' && call[2].user_id === 555));
  assert.ok(calls.some(call => call[0] === 'send' && /забанен/.test(call[2])));
  await bot.handleUpdate(message(owner, privateChat, '/spam_remove abactor @zfbsdiipebot allotriophagia'));
  assert.deepEqual((await store.read()).phrases, []);
});

test('username restriction is immediate for a known matching user', async t => {
  const { bot, store, calls } = await harness(t);
  await store.rememberUser(user);
  await bot.handleUpdate(message(owner, privateChat, '/comment_block @Nitin'));
  const restriction = calls.find(call => call[0] === 'api' && call[1] === 'restrictChatMember');
  assert.equal(restriction[2].user_id, 555);
  assert.equal(restriction[2].permissions.can_send_messages, false);
  assert.equal(restriction[2].permissions.can_send_photos, false);
  assert.deepEqual((await store.read()).blockedUsers, [555]);
});

test('unknown username is enforced when user posts later', async t => {
  const { bot, store, calls } = await harness(t);
  await bot.handleUpdate(message(owner, privateChat, '/comment_block @Nitin'));
  assert.deepEqual((await store.read()).blockedUsernames, ['nitin']);
  await bot.handleUpdate(message(user, group, 'hello'));
  assert.ok(calls.some(call => call[0] === 'api' && call[1] === 'restrictChatMember' && call[2].user_id === 555));
  assert.ok(calls.some(call => call[0] === 'delete'));
});

test('forwarded user is restricted; hidden origin does not create a ban', async t => {
  const { bot, store } = await harness(t);
  await bot.handleUpdate(message(owner, privateChat, '/comment_block'));
  await bot.handleUpdate(message(owner, privateChat, undefined, { forward_origin: { type: 'hidden_user', sender_user_name: 'Nitin' } }));
  assert.deepEqual((await store.read()).blockedUsers, []);
  await bot.handleUpdate(message(owner, privateChat, 'forwarded', { forward_origin: { type: 'user', sender_user: { id: 555 } } }));
  assert.deepEqual((await store.read()).blockedUsers, [555]);
});

test('numeric ID remains blocked if Telegram cannot restrict the user yet', async t => {
  const { bot, store, calls } = await harness(t);
  bot.context.telegram.callApi = async (method) => {
    if (method === 'restrictChatMember') throw new Error('user not found');
    return true;
  };
  await bot.handleUpdate(message(owner, privateChat, '/comment_block 777'));
  assert.deepEqual((await store.read()).blockedUsers, [777]);
  assert.ok(calls.some(call => call[0] === 'send' && /ID 777 сохранён/.test(call[2])));
});

test('a forwarded message alone blocks its visible author', async t => {
  const { bot, store } = await harness(t);
  await bot.handleUpdate(message(owner, privateChat, 'forwarded', {
    forward_origin: { type: 'user', sender_user: { id: 888 } },
  }));
  assert.deepEqual((await store.read()).blockedUsers, [888]);
});

test('commands from strangers cannot edit rules', async t => {
  const { bot, store } = await harness(t);
  await bot.handleUpdate(message({ id: 456 }, { id: 456, type: 'private' }, '/spam_add spam'));
  assert.deepEqual((await store.read()).phrases, []);
});

test('moderates edited captions only in the configured discussion group', async t => {
  const { bot, store, calls } = await harness(t);
  await store.addPhrase('запустить бота');
  await bot.handleUpdate({ update_id: 99, edited_message: {
    message_id: 9, date: 1, edit_date: 2, from: user, chat: { id: -100999, type: 'supergroup' },
    caption: 'Запустить бота',
  } });
  assert.equal(calls.filter(call => call[1] === 'banChatMember').length, 0);
  await bot.handleUpdate({ update_id: 100, edited_message: {
    message_id: 9, date: 1, edit_date: 2, from: user, chat: group,
    caption: 'ЗАПУСТИТЬ БОТА',
  } });
  assert.ok(calls.some(call => call[1] === 'banChatMember' && call[2].user_id === 555));
});
