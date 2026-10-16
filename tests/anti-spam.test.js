const assert = require('node:assert/strict');
const { mkdtemp, rm, writeFile } = require('node:fs/promises');
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
    answerCbQuery: async (...args) => { calls.push(['answer', ...args]); },
    callApi: async (...args) => { calls.push(['api', ...args]);
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

test('/spam_add asks for a phrase and saves the next owner text', async t => {
  const { bot, store, calls } = await harness(t);
  await bot.handleUpdate(message(owner, privateChat, '/spam_add'));
  assert.match(calls.at(-1)[2], /Какую антиспам-фразу добавить/);
  await bot.handleUpdate(message({ id: 456 }, { id: 456, type: 'private' }, 'чужая фраза'));
  await bot.handleUpdate(message(owner, privateChat, 'abactor @zfbsdiipebot allotriophagia'));
  assert.deepEqual((await store.read()).phrases, ['abactor @zfbsdiipebot allotriophagia']);
  assert.match(calls.at(-1)[2], /Фраза добавлена/);
});

test('the phrase prompt accepts a retry after invalid input and cancels on /cancel', async t => {
  const { bot, store, calls } = await harness(t);
  await bot.handleUpdate(message(owner, privateChat, '/spam_add'));
  await bot.handleUpdate(message(owner, privateChat, 'x'.repeat(201)));
  assert.deepEqual((await store.read()).phrases, []);
  assert.match(calls.at(-1)[2], /от 1 до 200/);
  await bot.handleUpdate(message(owner, privateChat, 'хорошая фраза'));
  assert.deepEqual((await store.read()).phrases, ['хорошая фраза']);
  await bot.handleUpdate(message(owner, privateChat, '/spam_add'));
  await bot.handleUpdate(message(owner, privateChat, '/cancel'));
  await bot.handleUpdate(message(owner, privateChat, 'не сохранять'));
  assert.deepEqual((await store.read()).phrases, ['хорошая фраза']);
  assert.ok(calls.some(call => call[0] === 'send' && /Добавление антиспам-фразы отменено/.test(call[2])));
});

test('another command ends the pending phrase prompt', async t => {
  const { bot, store } = await harness(t);
  await bot.handleUpdate(message(owner, privateChat, '/spam_add'));
  await bot.handleUpdate(message(owner, privateChat, '/spam_list'));
  await bot.handleUpdate(message(owner, privateChat, 'не сохранять'));
  assert.deepEqual((await store.read()).phrases, []);
});

test('/spam_remove without an argument offers buttons and removes the selected phrase', async t => {
  const { bot, store, calls } = await harness(t);
  await store.addPhrase('первая фраза');
  await store.addPhrase('вторая фраза');
  await bot.handleUpdate(message(owner, privateChat, '/spam_remove'));
  const buttons = calls.at(-1)[3].reply_markup.inline_keyboard;
  assert.equal(buttons.length, 2);
  assert.equal(buttons[0][0].text, 'первая фраза');
  assert.match(buttons[0][0].callback_data, /^spam_remove:[a-f0-9]{16}$/);
  await bot.handleUpdate({ update_id: 101, callback_query: {
    id: 'query-1', from: owner, chat_instance: 'test',
    message: { message_id: 8, date: 1, chat: privateChat },
    data: buttons[0][0].callback_data,
  } });
  assert.deepEqual((await store.read()).phrases, ['вторая фраза']);
  assert.ok(calls.some(call => call[0] === 'answer'));
  await bot.handleUpdate(message(owner, privateChat, '/spam_list'));
  assert.equal(calls.at(-1)[2], 'Антиспам-фразы:\n1. вторая фраза');
});

test('/spam_list splits a long list into Telegram-sized messages', async t => {
  const { bot, store, calls } = await harness(t);
  for (let index = 0; index < 25; index++) await store.addPhrase(`${'x'.repeat(185)}${index}`);
  await bot.handleUpdate(message(owner, privateChat, '/spam_list'));
  const replies = calls.filter(call => call[0] === 'send').map(call => call[2]);
  assert.ok(replies.length > 1);
  assert.ok(replies.every(reply => reply.length <= 3900));
  assert.ok(replies.join('\n').includes('25.'));
});

test('another user cannot remove a phrase through an inline button', async t => {
  const { bot, store, calls } = await harness(t);
  await store.addPhrase('защищённая фраза');
  await bot.handleUpdate(message(owner, privateChat, '/spam_remove'));
  const data = calls.at(-1)[3].reply_markup.inline_keyboard[0][0].callback_data;
  await bot.handleUpdate({ update_id: 102, callback_query: {
    id: 'query-2', from: { id: 456 }, chat_instance: 'test',
    message: { message_id: 8, date: 1, chat: privateChat }, data,
  } });
  assert.deepEqual((await store.read()).phrases, ['защищённая фраза']);
});

test('Telegram command menu is registered only for the owner chat', async t => {
  const { bot } = await harness(t);
  const calls = [];
  bot.telegram.setMyCommands = async (...args) => { calls.push(['commands', ...args]); return true; };
  bot.telegram.setChatMenuButton = async (...args) => { calls.push(['menu', ...args]); return true; };
  await bot.registerOwnerCommands();
  assert.deepEqual(calls[0][2], { scope: { type: 'chat', chat_id: 123 } });
  assert.deepEqual(calls[0][1].map(item => item.command), [
    'start', 'link', 'promo', 'cancel', 'spam_add', 'spam_remove', 'spam_list',
    'block', 'unblock', 'block_list',
  ]);
  assert.deepEqual(calls[1][1], { chatId: 123, menuButton: { type: 'commands' } });
});

test('/block ID immediately restricts the user and persists only after Telegram succeeds', async t => {
  const { bot, store, calls } = await harness(t);
  await bot.handleUpdate(message(owner, privateChat, '/block 8074667319'));
  const restriction = calls.find(call => call[0] === 'api' && call[1] === 'restrictChatMember');
  assert.equal(restriction[2].chat_id, '-100789');
  assert.equal(restriction[2].user_id, 8074667319);
  assert.equal(restriction[2].permissions.can_send_messages, false);
  assert.equal(restriction[2].permissions.can_send_photos, false);
  assert.deepEqual((await store.read()).blockedUsers, [8074667319]);
  assert.ok(calls.some(call => call[0] === 'send' && /больше не может писать/.test(call[2])));
});

test('/block saves the available name for later list display', async t => {
  const { bot, store, calls } = await harness(t);
  bot.context.telegram.callApi = async (method) => {
    calls.push(['api', method]);
    if (method === 'restrictChatMember') return true;
    return { user: { id: 555, first_name: 'Имя', last_name: 'Юзера', username: 'nitin7854' } };
  };
  await bot.handleUpdate(message(owner, privateChat, '/block 555'));
  assert.deepEqual(calls.filter(call => call[0] === 'api').map(call => call[1]),
    ['restrictChatMember', 'getChatMember']);
  assert.deepEqual((await store.read()).profiles[555], { name: 'Имя Юзера', username: 'nitin7854' });
});

test('/block does not add an ID or claim success when Telegram rejects the restriction', async t => {
  const { bot, store, calls } = await harness(t);
  bot.context.telegram.callApi = async () => { throw new Error('user not found'); };
  await bot.handleUpdate(message(owner, privateChat, '/block 777'));
  assert.deepEqual((await store.read()).blockedUsers, []);
  assert.ok(calls.some(call => call[0] === 'send' && /ID не добавлен/.test(call[2])));
});

test('/block requires a positive Telegram confirmation', async t => {
  const { bot, store } = await harness(t);
  bot.context.telegram.callApi = async () => false;
  await bot.handleUpdate(message(owner, privateChat, '/block 777'));
  assert.deepEqual((await store.read()).blockedUsers, []);
});

test('/block accepts only a numeric ID and never restricts the owner', async t => {
  const { bot, store, calls } = await harness(t);
  for (const command of ['/block', '/block @Nitin', '/block 123', '/block 9007199254740992']) {
    await bot.handleUpdate(message(owner, privateChat, command));
  }
  assert.deepEqual((await store.read()).blockedUsers, []);
  assert.equal(calls.filter(call => call[1] === 'restrictChatMember').length, 0);
});

test('username, forwarding, and old manual commands no longer create restrictions', async t => {
  const { bot, store, calls } = await harness(t);
  await bot.handleUpdate(message(owner, privateChat, '/comment_block 555'));
  await bot.handleUpdate(message(owner, privateChat, '/comment_unblock 555'));
  await bot.handleUpdate(message(owner, privateChat, 'forwarded', {
    forward_origin: { type: 'user', sender_user: { id: 555 } },
  }));
  assert.deepEqual((await store.read()).blockedUsers, []);
  assert.equal(calls.filter(call => call[1] === 'restrictChatMember').length, 0);
});

test('version 1 data preserves phrases and ID blocks but discards username rules', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'anti-spam-migration-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'anti-spam.json');
  await writeFile(file, JSON.stringify({ version: 1, phrases: ['spam'], blockedUsers: [777],
    blockedUsernames: ['nitin7854'], knownUsers: { nitin7854: 888 } }));
  const store = createAntiSpamStore(file);
  assert.deepEqual(await store.read(), { version: 3, phrases: ['spam'], blockedUsers: [777], profiles: {} });
  await store.blockId(999);
  const saved = JSON.parse(require('node:fs').readFileSync(file, 'utf8'));
  assert.deepEqual(saved, { version: 3, phrases: ['spam'], blockedUsers: [777, 999], profiles: {} });
  await writeFile(file, JSON.stringify({ version: 2, phrases: ['spam'], blockedUsers: [777] }));
  assert.deepEqual(await store.read(), { version: 3, phrases: ['spam'], blockedUsers: [777], profiles: {} });
});

test('/block_list shows names, optional usernames, and IDs from Telegram', async t => {
  const { bot, store, calls } = await harness(t);
  await store.blockId(555);
  await store.blockId(666);
  bot.context.telegram.callApi = async (method, payload) => {
    assert.equal(method, 'getChatMember');
    const users = {
      555: { id: 555, first_name: 'Имя', last_name: 'Юзера', username: 'nitin7854' },
      666: { id: 666, first_name: 'Без', last_name: 'Юзернейма' },
    };
    return { user: users[payload.user_id] };
  };
  await bot.handleUpdate(message(owner, privateChat, '/block_list'));
  assert.equal(calls.at(-1)[2], 'Запрещено писать в группе:\nИмя Юзера (@nitin7854) – 555\nБез Юзернейма – 666');
  assert.deepEqual((await store.read()).profiles, {
    555: { name: 'Имя Юзера', username: 'nitin7854' },
    666: { name: 'Без Юзернейма' },
  });
});

test('/block_list uses saved names if Telegram lookup is unavailable', async t => {
  const { bot, store, calls } = await harness(t);
  await store.blockId(555, { name: 'Старое Имя', username: 'former' });
  await store.blockId(777);
  bot.context.telegram.callApi = async () => { throw new Error('user not found'); };
  await bot.handleUpdate(message(owner, privateChat, '/block_list'));
  assert.equal(calls.at(-1)[2], 'Запрещено писать в группе:\nСтарое Имя (@former) – 555\nИмя недоступно – 777');
});

test('/block_list is owner-only and reports an empty list', async t => {
  const { bot, calls } = await harness(t);
  await bot.handleUpdate(message({ id: 456 }, { id: 456, type: 'private' }, '/block_list'));
  assert.equal(calls.length, 0);
  await bot.handleUpdate(message(owner, privateChat, '/block_list'));
  assert.equal(calls.at(-1)[2], 'Список ограниченных пользователей пуст.');
});

test('/unblock ID restores Telegram permissions and removes the user and profile from the list', async t => {
  const { bot, store, calls } = await harness(t);
  await store.blockId(555, { name: 'Имя Юзера', username: 'nitin7854' });
  await bot.handleUpdate(message(owner, privateChat, '/unblock 555'));
  const request = calls.find(call => call[0] === 'api' && call[1] === 'restrictChatMember');
  assert.equal(request[2].chat_id, '-100789');
  assert.equal(request[2].user_id, 555);
  assert.equal(request[2].use_independent_chat_permissions, true);
  assert.ok(Object.values(request[2].permissions).every(value => value === true));
  assert.equal(request[2].permissions.can_send_messages, true);
  assert.equal(request[2].permissions.can_send_photos, true);
  assert.deepEqual((await store.read()).blockedUsers, []);
  assert.deepEqual((await store.read()).profiles, {});
  await bot.handleUpdate(message(owner, privateChat, '/block_list'));
  assert.equal(calls.at(-1)[2], 'Список ограниченных пользователей пуст.');
});

test('/unblock leaves the rule in place when Telegram does not confirm', async t => {
  const { bot, store, calls } = await harness(t);
  await store.blockId(555);
  bot.context.telegram.callApi = async () => false;
  await bot.handleUpdate(message(owner, privateChat, '/unblock 555'));
  assert.deepEqual((await store.read()).blockedUsers, [555]);
  assert.ok(calls.some(call => call[0] === 'send' && /остаётся в списке/.test(call[2])));
});

test('/unblock requires a known numeric ID and is owner-only', async t => {
  const { bot, store, calls } = await harness(t);
  await store.blockId(555);
  await bot.handleUpdate(message({ id: 456 }, { id: 456, type: 'private' }, '/unblock 555'));
  await bot.handleUpdate(message(owner, privateChat, '/unblock @nitin'));
  await bot.handleUpdate(message(owner, privateChat, '/unblock 777'));
  assert.deepEqual((await store.read()).blockedUsers, [555]);
  assert.equal(calls.filter(call => call[1] === 'restrictChatMember').length, 0);
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
