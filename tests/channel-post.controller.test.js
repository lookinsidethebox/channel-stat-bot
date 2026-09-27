const assert = require('node:assert/strict');
const test = require('node:test');
const registerChannelPostController = require('../src/controllers/channel-post.controller');

const channelId = 'test-channel-id';

test('stores the latest post preview as the first 100 Unicode characters', async () => {
  const handlers = {};
  const savedPosts = [];

  registerChannelPostController({
    on(type, handler) {
      handlers[type] = handler;
    },
  }, {
    channelId,
    savePost: async (post) => savedPosts.push(post),
  });

  const content = '😀'.repeat(101);
  await handlers.channel_post({
    channelPost: {
      chat: { id: channelId },
      message_id: 42,
      date: 1780000000,
      text: content,
    },
  });

  assert.equal(savedPosts.length, 1);
  assert.equal(savedPosts[0].messageId, 42);
  assert.equal(savedPosts[0].preview, '😀'.repeat(100));
});

test('ignores posts from other channels', async () => {
  const handlers = {};
  let saveCalled = false;

  registerChannelPostController({
    on(type, handler) {
      handlers[type] = handler;
    },
  }, {
    channelId,
    savePost: async () => { saveCalled = true; },
  });

  await handlers.channel_post({
    channelPost: {
      chat: { id: 'another-test-channel-id' },
      message_id: 43,
      date: 1780000000,
      text: 'Not this channel',
    },
  });

  assert.equal(saveCalled, false);
});

test('marks edits so only the stored latest post can be refreshed', async () => {
  const handlers = {};
  const savedPosts = [];

  registerChannelPostController({
    on(type, handler) {
      handlers[type] = handler;
    },
  }, {
    channelId,
    savePost: async (...args) => savedPosts.push(args),
  });

  await handlers.edited_channel_post({
    editedChannelPost: {
      chat: { id: channelId },
      message_id: 42,
      date: 1780000000,
      edit_date: 1780000050,
      text: 'Updated post text',
    },
  });

  assert.equal(savedPosts[0][1].isEdit, true);
  assert.equal(savedPosts[0][0].preview, 'Updated post text');
});
