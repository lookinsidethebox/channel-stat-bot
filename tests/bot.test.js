const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createBot } = require('../src/bot');
const { createMemberStore } = require('../src/storage/member.store');

const config = { token: 'test-token', ownerId: '123', channelId: '-100456' };

function createHarness(memberStore, postResponses = []) {
  const sentMessages = [];
  const createdLinks = [];
  const errors = [];
  const postRequests = [];
  const bot = createBot(config, {
    memberStore,
    logger: { log() {}, error: (...args) => errors.push(args) },
  });
  bot.botInfo = { id: 999, username: 'test_bot', first_name: 'Test', is_bot: true };
  bot.context.telegram = {
    callApi: async (method, payload) => {
      if (method === 'getChat') return { personal_chat: { id: Number(config.channelId) } };
      assert.equal(method, 'getUserPersonalChatMessages');
      postRequests.push(payload);
      return postResponses.shift() ?? [];
    },
    sendMessage: async (...args) => sentMessages.push(args),
    createChatInviteLink: async (...args) => {
      createdLinks.push(args);
      return { invite_link: 'https://t.me/+test-invite' };
    },
  };
  return { bot, sentMessages, createdLinks, errors, postRequests };
}

function textUpdate(fromId, text) {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      date: 1780000000,
      from: { id: fromId, is_bot: false, first_name: 'Test' },
      chat: { id: fromId, type: 'private' },
      text,
      entities: text.startsWith('/')
        ? [{ type: 'bot_command', offset: 0, length: text.split(/\s/)[0].length }]
        : [],
    },
  };
}

test('the assembled bot restricts text and link commands to the owner', async () => {
  const { bot, sentMessages, createdLinks, errors } = createHarness();
  await bot.handleUpdate(textUpdate(456, 'Hi'));
  await bot.handleUpdate(textUpdate(456, '/link campaign'));
  assert.equal(sentMessages.length, 0);
  assert.equal(createdLinks.length, 0);

  await bot.handleUpdate(textUpdate(123, '/start'));
  assert.equal(sentMessages[0][1], 'Hello, world!');
  await bot.handleUpdate(textUpdate(123, '/link@test_bot campaign'));
  assert.deepEqual(createdLinks, [[config.channelId, { name: 'campaign' }]]);
  assert.equal(sentMessages.length, 2);
  assert.match(sentMessages[1][1], /https:\/\/t\.me\/\+test-invite/);
  assert.deepEqual(errors, []);
});

test('fetches existing posts for joins and leaves without receiving channel_post updates', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'channel-stat-bot-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'nested', 'channel-members.json');
  const chat = { id: Number(config.channelId), type: 'channel', title: 'Test' };
  const user = { id: 345, is_bot: false, first_name: 'Subscriber' };
  const post = { chat, message_id: 10, date: 1780000000, text: 'Original post' };
  const { bot, sentMessages, errors, postRequests } = createHarness(createMemberStore(filePath), [
    [post],
    [{ ...post, edit_date: 1780000020, text: 'Edited post' }],
    [post],
  ]);
  const membership = {
    chat,
    from: { id: 456, is_bot: false, first_name: 'Admin' },
    date: 1780000010,
    old_chat_member: { user, status: 'left' },
    new_chat_member: { user, status: 'member' },
  };

  await bot.handleUpdate({ update_id: 0, channel_post: { ...post, chat: { ...chat, id: -100789 } } });
  await bot.handleUpdate({ update_id: 1, chat_member: { ...membership, chat: { ...chat, id: -100789 } } });
  await assert.rejects(readFile(filePath), { code: 'ENOENT' });
  await Promise.all([
    bot.handleUpdate({ update_id: 3, chat_member: membership }),
    bot.handleUpdate({
      update_id: 5,
      chat_member: {
        ...membership,
        date: 1780000030,
        old_chat_member: membership.new_chat_member,
        new_chat_member: membership.old_chat_member,
      },
    }),
  ]);
  // Redelivery must neither reopen the old membership nor notify the owner again.
  await bot.handleUpdate({ update_id: 3, chat_member: membership });

  const { members, latestPost } = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(members.length, 1);
  assert.equal(members[0].postAtAddition.preview, 'Original post');
  assert.equal(members[0].postAtRemoval.preview, 'Edited post');
  assert.equal(latestPost.preview, 'Edited post');
  assert.equal(sentMessages.length, 2);
  assert.equal(postRequests.length, 3);
  assert.ok(sentMessages.every(([recipient]) => recipient === config.ownerId));
  assert.deepEqual(errors, []);
});

test('routes handler failures to the common error logger and keeps processing the queue', async () => {
  const error = new Error('Read failed');
  let attempts = 0;
  const { bot, errors, sentMessages } = createHarness({
    recordMemberEvent: async () => { throw error; },
    saveLatestPost: async () => {
      attempts += 1;
      if (attempts === 1) throw error;
      return true;
    },
  });
  const update = {
    update_id: 1,
    channel_post: {
      chat: { id: Number(config.channelId), type: 'channel' },
      message_id: 1,
      date: 1780000000,
      text: 'Test',
    },
  };
  await Promise.all([bot.handleUpdate(update), bot.handleUpdate({ ...update, update_id: 2 })]);
  assert.equal(attempts, 2);
  assert.equal(errors.length, 1);
  assert.equal(errors[0][1], error);
  assert.deepEqual(sentMessages, []);
});
