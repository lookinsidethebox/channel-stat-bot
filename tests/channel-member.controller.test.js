const assert = require('node:assert/strict');
const test = require('node:test');
const registerChannelMemberController = require('../src/controllers/channel-member.controller');

const channelId = 'test-channel-id';
const ownerId = 'test-owner-id';

function registerHandler(options = {}) {
  let handler;
  const recordedEvents = [];

  registerChannelMemberController({
    on(type, callback) {
      assert.equal(type, 'chat_member');
      handler = callback;
    },
  }, {
    channelId,
    ownerId,
    recordMemberEvent: async (event) => recordedEvents.push(event),
    fetchPost: async () => null,
    logger: { log() {}, error() {} },
    ...options,
  });

  return { handler, recordedEvents };
}

function createContext({
  chatId = channelId,
  oldStatus,
  newStatus,
  inviteLink,
  viaJoinRequest = false,
  viaChatFolderInviteLink = false,
}) {
  const sentMessages = [];

  return {
    context: {
      chatMember: {
        chat: { id: chatId, title: 'Test channel' },
        date: 1780000000,
        invite_link: inviteLink,
        via_join_request: viaJoinRequest,
        via_chat_folder_invite_link: viaChatFolderInviteLink,
        old_chat_member: {
          status: oldStatus,
          user: { id: 345, first_name: 'Test', is_bot: true },
        },
        new_chat_member: {
          status: newStatus,
          user: { id: 345, first_name: 'Test', is_bot: true },
        },
      },
      telegram: {
        sendMessage: async (...args) => sentMessages.push(args),
      },
    },
    sentMessages,
  };
}

test('notifies the owner when a bot joins the configured channel', async () => {
  const { handler, recordedEvents } = registerHandler();
  const { context, sentMessages } = createContext({
    oldStatus: 'left',
    newStatus: 'member',
    inviteLink: { name: 'test-campaign' },
  });

  await handler(context);

  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0][0], ownerId);
  assert.match(sentMessages[0][1], /добавлен в канал/);
  assert.match(sentMessages[0][1], /test-campaign/);
  assert.match(sentMessages[0][1], /Test/);
  assert.match(sentMessages[0][1], /345/);
  assert.deepEqual(recordedEvents[0].source, { type: 'invite_link', name: 'test-campaign' });
});

test('notifies the owner when a channel member leaves', async () => {
  const { handler, recordedEvents } = registerHandler();
  const { context, sentMessages } = createContext({
    oldStatus: 'administrator',
    newStatus: 'left',
  });

  await handler(context);

  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0][1], /покинул канал/);
  assert.equal(recordedEvents[0].source, null);
});

test('records folder, join-request, and unknown sources distinctly', async (suite) => {
  const cases = [
    {
      name: 'chat folder',
      update: { viaChatFolderInviteLink: true },
      expected: { type: 'chat_folder', name: null },
    },
    {
      name: 'join request',
      update: { viaJoinRequest: true },
      expected: { type: 'join_request', name: null },
    },
    {
      name: 'unattributed join',
      update: {},
      expected: { type: 'unknown', name: null },
    },
  ];

  for (const { name, update, expected } of cases) {
    await suite.test(name, async () => {
      const { handler, recordedEvents } = registerHandler();
      const { context } = createContext({
        oldStatus: 'left',
        newStatus: 'member',
        ...update,
      });

      await handler(context);

      assert.deepEqual(recordedEvents[0].source, expected);
    });
  }
});

test('ignores other channels and status changes that keep membership', async (suite) => {
  const { handler } = registerHandler();

  await suite.test('another channel', async () => {
    const { context, sentMessages } = createContext({
      chatId: 'another-test-channel-id',
      oldStatus: 'left',
      newStatus: 'member',
    });

    await handler(context);

    assert.equal(sentMessages.length, 0);
  });

  await suite.test('member promoted to administrator', async () => {
    const { context, sentMessages } = createContext({
      oldStatus: 'member',
      newStatus: 'administrator',
    });

    await handler(context);

    assert.equal(sentMessages.length, 0);
  });
});

test('does not notify the owner when the event was already recorded', async () => {
  const { handler } = registerHandler({ recordMemberEvent: async () => false });
  const { context, sentMessages } = createContext({ oldStatus: 'left', newStatus: 'member' });
  await handler(context);
  assert.equal(sentMessages.length, 0);
});

test('propagates storage errors without claiming the event was saved', async () => {
  const error = new Error('Disk full');
  const logs = [];
  const { handler } = registerHandler({
    recordMemberEvent: async () => { throw error; },
    logger: { log: (...args) => logs.push(args) },
  });
  const { context, sentMessages } = createContext({ oldStatus: 'member', newStatus: 'left' });
  await assert.rejects(handler(context), (actual) => actual === error);
  assert.equal(logs.length, 0);
  assert.equal(sentMessages.length, 0);
});

test('fetches a post using the event time before saving the membership', async () => {
  const post = { messageId: 128, postedAt: '2026-01-01T00:00:00.000Z', preview: 'Existing post' };
  const calls = [];
  const { context } = createContext({ oldStatus: 'left', newStatus: 'member' });
  const { handler } = registerHandler({
    fetchPost: async (telegram, options) => {
      assert.equal(telegram, context.telegram);
      calls.push(['fetch', options]);
      return post;
    },
    recordMemberEvent: async (event, snapshot) => { calls.push(['record', snapshot]); return true; },
  });
  await handler(context);
  assert.deepEqual(calls, [
    ['fetch', { channelId, ownerId, occurredAt: new Date(context.chatMember.date * 1000).toISOString() }],
    ['record', post],
  ]);
});

test('preserves the membership event and reports a post lookup failure', async () => {
  const events = [];
  const { handler } = registerHandler({
    fetchPost: async () => { throw new Error('Telegram unavailable'); },
    recordMemberEvent: async (...args) => { events.push(args); return true; },
  });
  const { context, sentMessages } = createContext({ oldStatus: 'member', newStatus: 'left' });
  await handler(context);
  assert.equal(events[0][0].action, 'left');
  assert.equal(events[0][0].postLookupError, 'Telegram unavailable');
  assert.equal(events[0][1], null);
  assert.match(sentMessages[0][1], /Пост не получен: Telegram unavailable/);
});
