const assert = require('node:assert/strict');
const test = require('node:test');
const registerCampaignLinkController = require('../src/controllers/campaign-link.controller');

const channelId = 'test-channel-id';

function registerHandler(options = {}) {
  let handler;

  registerCampaignLinkController({
    command(command, callback) {
      assert.equal(command, 'link');
      handler = callback;
    },
  }, { channelId, ...options });

  return handler;
}

test('creates a named invite link for a campaign and returns it to the owner', async () => {
  const createdLinks = [];
  const handler = registerHandler();
  const replies = [];

  await handler({
    message: { text: '/link spring_ads' },
    telegram: { createChatInviteLink: async (...args) => {
      createdLinks.push(args);
      return { invite_link: 'https://t.me/+test-invite' };
    } },
    reply: async (message) => replies.push(message),
  });

  assert.deepEqual(createdLinks, [[channelId, { name: 'spring_ads' }]]);
  assert.match(replies[0], /spring_ads/);
  assert.match(replies[0], /https:\/\/t\.me\/\+test-invite/);
});

test('does not call Telegram when a campaign label is missing or too long', async (suite) => {
  for (const text of ['/link', `/link ${'a'.repeat(33)}`]) {
    await suite.test(text, async () => {
      let createCalled = false;
      const handler = registerHandler();
      const replies = [];

      await handler({
        message: { text },
        telegram: { createChatInviteLink: async () => { createCalled = true; } },
        reply: async (message) => replies.push(message),
      });

      assert.equal(createCalled, false);
      assert.equal(replies.length, 1);
    });
  }
});

test('accepts an addressed command and a 32-character Unicode campaign label', async () => {
  const handler = registerHandler();
  const name = '😀'.repeat(32);
  const calls = [];
  await handler({
    message: { text: `/link@test_bot  ${name}  ` },
    telegram: { createChatInviteLink: async (...args) => {
      calls.push(args);
      return { invite_link: 'https://t.me/+test-invite' };
    } },
    reply: async () => {},
  });
  assert.deepEqual(calls, [[channelId, { name }]]);
});

test('reports invite creation errors to the owner', async () => {
  const errors = [];
  const replies = [];
  const handler = registerHandler({ logger: { error: (...args) => errors.push(args) } });
  await handler({
    message: { text: '/link campaign' },
    telegram: { createChatInviteLink: async () => { throw new Error('Forbidden'); } },
    reply: async (message) => replies.push(message),
  });
  assert.equal(errors.length, 1);
  assert.equal(replies.length, 1);
  assert.match(replies[0], /Не удалось создать ссылку/);
});

test('does not misreport a reply failure as a failed invite creation', async () => {
  const error = new Error('Reply failed');
  let replies = 0;
  const handler = registerHandler();
  await assert.rejects(handler({
    message: { text: '/link campaign' },
    telegram: { createChatInviteLink: async () => ({ invite_link: 'https://t.me/+test-invite' }) },
    reply: async () => { replies += 1; throw error; },
  }), (actual) => actual === error);
  assert.equal(replies, 1);
});
