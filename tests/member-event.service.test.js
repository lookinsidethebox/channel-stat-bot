const assert = require('node:assert/strict');
const test = require('node:test');
const { createMemberEvent, createPostSnapshot } = require('../src/services/member-event.service');

function memberUpdate(oldMember, newMember) {
  const user = { id: 123, first_name: 'Test', last_name: 'User' };
  return {
    chat: { id: -100456 },
    date: 1780000000,
    old_chat_member: { user, ...oldMember },
    new_chat_member: { user, ...newMember },
  };
}

test('recognizes restricted members using is_member, including membership changes', () => {
  const restricted = { status: 'restricted', is_member: true };
  assert.equal(createMemberEvent(memberUpdate({ status: 'member' }, restricted)), null);
  assert.equal(createMemberEvent(memberUpdate(restricted, { status: 'administrator' })), null);
  assert.equal(createMemberEvent(memberUpdate({ status: 'left' }, restricted)).action, 'joined');
  assert.equal(createMemberEvent(memberUpdate(restricted, { ...restricted, is_member: false })).action, 'left');
  assert.equal(createMemberEvent(memberUpdate({ status: 'left' }, { status: 'kicked' })), null);
});

test('normalizes a membership event and identifies the changed user rather than the actor', () => {
  const update = memberUpdate({ status: 'left' }, { status: 'creator' });
  update.from = { id: 999 };
  assert.deepEqual(createMemberEvent(update), {
    occurredAt: new Date(update.date * 1000).toISOString(),
    channelId: '-100456',
    action: 'joined',
    user: { id: 123, name: 'Test User', username: null },
    source: { type: 'unknown', name: null },
  });
});

test('uses captions for media previews and stores null for posts without text', () => {
  const post = { message_id: 1, date: 1780000000 };
  assert.equal(createPostSnapshot(post).preview, null);
  assert.equal(createPostSnapshot({ ...post, caption: 'A photo caption' }).preview, 'A photo caption');
  assert.equal(createPostSnapshot({ ...post, text: 'Text', caption: 'Caption' }).preview, 'Text');
});
