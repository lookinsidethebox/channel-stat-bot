const assert = require('node:assert/strict');
const { mkdtemp, readFile, readdir, rm, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createMemberStore } = require('../src/storage/member.store');

async function createTestStore(context) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'channel-stat-bot-'));
  const filePath = path.join(directory, 'channel-members.json');
  context.after(() => rm(directory, { recursive: true, force: true }));
  return { ...createMemberStore(filePath), filePath, directory };
}

test('migrates legacy Ads and URL fields without losing campaign details', async context => {
  const store = await createTestStore(context);
  const at = '2026-09-29T12:00:00.000Z';
  const old = { latestPost: null, members: [
    { userId: 1, addedAt: at, removedAt: null, source: { type: 'ads' },
      campaignLookup: { status: 'matched', checkedAt: at },
      campaign: { accountId: 'account', adId: 42, title: 'Реклама', attribution: 'statistics_delta' } },
    { userId: 2, addedAt: at, removedAt: null, source: { type: 'url' },
      campaignLookup: { status: 'not_applicable', reason: 'source_is_not_ads' },
      campaign: { id: 'promo', title: 'Фикбук', attribution: 'scheduled_url_promo' } },
    { userId: 3, addedAt: at, removedAt: null, source: { type: 'ads' },
      campaignLookup: { status: 'pending' } },
  ] };
  await writeFile(store.filePath, `${JSON.stringify(old)}\n`);
  assert.equal((await store.getMember(1, at)).adsCampaign.adId, 42);
  assert.equal((await store.getMember(2, at)).urlCampaign.title, 'Фикбук');
  assert.equal(await store.migrateCampaignFields(), true);
  const saved = JSON.parse(await readFile(store.filePath, 'utf8')).members;
  assert.deepEqual(saved[0].adsCampaign, { status: 'matched', checkedAt: at,
    accountId: 'account', adId: 42, title: 'Реклама', attribution: 'statistics_delta' });
  assert.deepEqual(saved[1].urlCampaign, old.members[1].campaign);
  assert.equal(saved[1].adsCampaign, undefined);
  assert.deepEqual(saved[2].adsCampaign, { status: 'pending' });
  assert.ok(saved.every(member => !Object.hasOwn(member, 'campaign') && !Object.hasOwn(member, 'campaignLookup')));
  assert.equal(await store.migrateCampaignFields(), false);
});

test('stores post snapshots, untracked departures, and returns', async (context) => {
  const { recordMemberEvent, filePath } = await createTestStore(context);

  const joinedPost = {
    messageId: 10,
    postedAt: '2026-09-27T10:00:00.000Z',
    preview: 'Post seen on join',
  };
  const leavePost = {
    messageId: 11,
    postedAt: '2026-09-27T11:00:00.000Z',
    preview: 'Post seen before leaving',
  };
  const user = { id: 'test-user-id', name: 'Test User', username: 'test_user' };

  await recordMemberEvent({
    action: 'joined',
    occurredAt: '2026-09-27T10:05:00.000Z',
    user,
    source: { type: 'invite_link', name: 'test-campaign' },
  }, joinedPost);

  const recordedLeave = await recordMemberEvent({
    action: 'left',
    occurredAt: '2026-09-27T11:05:00.000Z',
    user,
    source: null,
  }, leavePost);
  const orphanLeave = await recordMemberEvent({
    action: 'left',
    occurredAt: '2026-09-27T11:10:00.000Z',
    user: { ...user, id: 'untracked-user-id' },
    source: null,
  });
  await recordMemberEvent({
    action: 'joined',
    occurredAt: '2026-09-27T11:15:00.000Z',
    user: { ...user, id: 'test-user-id' },
    source: { type: 'chat_folder', name: null },
  });

  const data = JSON.parse(await readFile(filePath, 'utf8'));

  assert.equal(recordedLeave, true);
  assert.equal(orphanLeave, true);
  assert.deepEqual(data.members[0], {
    userId: 'test-user-id',
    name: 'Test User',
    username: 'test_user',
    addedAt: '2026-09-27T10:05:00.000Z',
    source: { type: 'invite_link', name: 'test-campaign' },
    postAtAddition: joinedPost,
    removedAt: '2026-09-27T11:05:00.000Z',
    postAtRemoval: leavePost,
    returned: false,
  });
  assert.equal(data.members[1].userId, 'untracked-user-id');
  assert.equal(data.members[1].addedAt, null);
  assert.equal(data.members[1].removedAt, '2026-09-27T11:10:00.000Z');
  assert.equal(data.members[1].returned, false);
  assert.equal(data.members[2].returned, true);
  assert.equal(data.members[2].addedAt, '2026-09-27T11:15:00.000Z');
});

test('a join after an untracked departure is marked as a return', async (context) => {
  const { recordMemberEvent, filePath } = await createTestStore(context);
  const user = { id: 'test-user-id', name: 'Test User', username: 'test_user' };

  await recordMemberEvent({
    action: 'left',
    occurredAt: '2026-09-27T11:00:00.000Z',
    user,
    source: null,
  });
  await recordMemberEvent({
    action: 'joined',
    occurredAt: '2026-09-27T11:05:00.000Z',
    user,
    source: { type: 'unknown', name: null },
  });

  const data = JSON.parse(await readFile(filePath, 'utf8'));

  assert.equal(data.members.length, 2);
  assert.equal(data.members[0].addedAt, null);
  assert.equal(data.members[1].returned, true);
});

test('does not replace the latest post with an older edit', async (context) => {
  const { saveLatestPost, filePath } = await createTestStore(context);

  await saveLatestPost({ messageId: 12, postedAt: '2026-09-27T12:00:00.000Z', preview: 'New post' });
  const savedOlderEdit = await saveLatestPost({
    messageId: 11,
    postedAt: '2026-09-27T13:00:00.000Z',
    preview: 'Edited old post',
  }, { isEdit: true });
  const data = JSON.parse(await readFile(filePath, 'utf8'));

  assert.equal(savedOlderEdit, false);
  assert.equal(data.latestPost.messageId, 12);
  assert.equal(data.latestPost.preview, 'New post');
});

function memberEvent(action, occurredAt, userId = 123) {
  return {
    action,
    occurredAt,
    user: { id: userId, name: 'Test', username: null },
    source: action === 'joined' ? { type: 'unknown', name: null } : null,
  };
}

test('ignores repeated and stale membership events, including after reopening the store', async (context) => {
  const { recordMemberEvent, filePath } = await createTestStore(context);
  const joined = memberEvent('joined', '2026-09-27T10:00:00.000Z');
  const left = memberEvent('left', '2026-09-27T11:00:00.000Z');

  assert.equal(await recordMemberEvent(joined), true);
  assert.equal(await recordMemberEvent(joined), false);
  assert.equal(await recordMemberEvent(left), true);

  const reopened = createMemberStore(filePath);
  assert.equal(await reopened.recordMemberEvent(left), false);
  assert.equal(await reopened.recordMemberEvent(joined), false);
  assert.equal(await reopened.recordMemberEvent({ ...joined, occurredAt: '2026-09-27T12:00:00.000Z' }), true);
  assert.equal(await reopened.recordMemberEvent(left), false);

  const { members } = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(members.length, 2);
  assert.equal(members[0].removedAt, left.occurredAt);
  assert.equal(members[1].returned, true);
  assert.equal(members[1].removedAt, null);
});

test('serializes concurrent writes without losing members or leaving temporary files', async (context) => {
  const { recordMemberEvent, filePath, directory } = await createTestStore(context);
  await Promise.all(Array.from({ length: 20 }, (_, id) => (
    recordMemberEvent(memberEvent('joined', '2026-09-27T10:00:00.000Z', id + 1))
  )));

  const { members } = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(members.length, 20);
  assert.equal(new Set(members.map((member) => member.userId)).size, 20);
  assert.deepEqual(await readdir(directory), ['channel-members.json']);
});

test('does not overwrite invalid data and can write again after the file is repaired', async (context) => {
  const { recordMemberEvent, filePath } = await createTestStore(context);
  const event = memberEvent('joined', '2026-09-27T10:00:00.000Z');

  for (const contents of ['{broken', 'null', '{}', '{"members":{}}', '{"members":[null]}',
    '{"members":[{}]}', '{"members":[],"latestPost":{}}']) {
    await writeFile(filePath, contents);
    await assert.rejects(recordMemberEvent(event));
    assert.equal(await readFile(filePath, 'utf8'), contents);
  }

  await writeFile(filePath, '{"members":[],"customMetadata":"preserved"}');
  assert.equal(await recordMemberEvent(event), true);
  const data = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(data.members.length, 1);
  assert.equal(data.customMetadata, 'preserved');
});

test('keeps the latest edit when older updates for the same post arrive later', async (context) => {
  const { saveLatestPost, filePath } = await createTestStore(context);
  const original = { messageId: 12, postedAt: '2026-09-27T10:00:00.000Z', preview: 'Original' };
  const edited = { ...original, postedAt: '2026-09-27T11:00:00.000Z', preview: 'Edited' };

  assert.equal(await saveLatestPost(edited, { isEdit: true }), false);
  await saveLatestPost(original);
  assert.equal(await saveLatestPost(edited, { isEdit: true }), true);
  assert.equal(await saveLatestPost(original), false);
  assert.equal(await saveLatestPost(original, { isEdit: true }), false);
  assert.equal(await saveLatestPost({ ...edited, messageId: 11 }), false);
  assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')).latestPost, edited);
});

test('later edits do not change a snapshot already attached to a member', async (context) => {
  const { saveLatestPost, recordMemberEvent, filePath } = await createTestStore(context);
  const original = { messageId: 12, postedAt: '2026-09-27T10:00:00.000Z', preview: 'Original' };
  await saveLatestPost(original);
  await recordMemberEvent(memberEvent('joined', '2026-09-27T10:30:00.000Z'), original);
  await saveLatestPost({ ...original, postedAt: '2026-09-27T11:00:00.000Z', preview: 'Edited' }, { isEdit: true });

  const data = JSON.parse(await readFile(filePath, 'utf8'));
  assert.deepEqual(data.members[0].postAtAddition, original);
  assert.equal(data.latestPost.preview, 'Edited');
});

test('uses the requested snapshot instead of a cached post and keeps lookup failures explicit', async (context) => {
  const { saveLatestPost, recordMemberEvent, filePath } = await createTestStore(context);
  const cached = { messageId: 10, postedAt: '2026-09-27T09:00:00.000Z', preview: 'Stale cached post' };
  const fetched = { messageId: 11, postedAt: '2026-09-27T10:00:00.000Z', preview: 'Fetched post' };
  await saveLatestPost(cached);
  await recordMemberEvent(memberEvent('joined', '2026-09-27T10:30:00.000Z'), fetched);
  await recordMemberEvent({
    ...memberEvent('left', '2026-09-27T11:00:00.000Z'),
    postLookupError: 'Telegram unavailable',
  }, null);

  const data = JSON.parse(await readFile(filePath, 'utf8'));
  assert.deepEqual(data.members[0].postAtAddition, fetched);
  assert.equal(data.members[0].postAtRemoval, null);
  assert.equal(data.members[0].postAtRemovalError, 'Telegram unavailable');
});
