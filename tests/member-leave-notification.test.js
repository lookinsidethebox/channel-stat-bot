const assert = require('node:assert/strict');
const test = require('node:test');
const { formatLeaveNotification } = require('../src/services/member-notification.service');

const headline = '👎 Подписчик покинул канал! Да и хуй с ним.';
const chat = { id: '-1001234567890', username: 'example_channel' };
const member = {
  name: 'Анна Иванова', username: 'anna',
  addedAt: '2026-09-20T10:00:00.000Z', removedAt: '2026-09-29T22:30:00.000Z',
  source: { type: 'ads' }, adsCampaign: { title: 'Новая кампания' },
  postAtAddition: { messageId: 128, postedAt: '2026-09-20T09:00:00.000Z', preview: 'Пост при вступлении' },
  postAtRemoval: { messageId: 150, preview: 'Пост при выходе' },
};

test('formats the leave template using the saved addition post, source and campaign', () => {
  assert.equal(formatLeaveNotification(member, chat), [
    headline, '', 'Имя: Анна Иванова (@anna)',
    'Источник: Ads (Новая кампания)',
    'С какого поста подписался: Пост при вступлении https://t.me/example_channel/128',
    'Сколько дней провел на канале: 9',
  ].join('\n'));
});

test('omits all history lines when there is no recorded addition date', () => {
  assert.equal(formatLeaveNotification({ ...member, addedAt: null }, chat), `${headline}\n\nИмя: Анна Иванова (@anna)`);
  assert.equal(formatLeaveNotification({ name: 'Анна', username: null }, chat), `${headline}\n\nИмя: Анна`);
});

test('URL shows its campaign while other non-ad sources do not', () => {
  for (const [type, name] of Object.entries({ url: 'URL', chat_folder: 'Shareable Chat Folders', search: 'Search', pm: 'PM' })) {
    const message = formatLeaveNotification({ ...member, username: null, source: { type },
      ...(type === 'url' ? { urlCampaign: { title: 'Новая кампания' } } : {}) }, chat);
    assert.equal(message.split('\n')[2], 'Имя: Анна Иванова');
    assert.equal(message.split('\n')[3], `Источник: ${name}${type === 'url' ? ' (Новая кампания)' : ''}`);
    if (type !== 'url') assert.ok(!message.includes('Новая кампания'));
  }
});

test('truncates old post previews to 100 Unicode characters and uses a private channel link without a username', () => {
  const message = formatLeaveNotification({ ...member, postAtAddition: { ...member.postAtAddition, preview: '😀'.repeat(101) } }, { id: '-1001234567890' });
  assert.equal(message.split('\n')[4], `С какого поста подписался: ${'😀'.repeat(100)} https://t.me/c/1234567890/128`);
  // Larger channel IDs require arithmetic conversion, not removal of a literal -100 prefix.
  const largeChannel = formatLeaveNotification(member, { id: -1234567890123 });
  assert.match(largeChannel, /https:\/\/t\.me\/c\/234567890123\/128/);
});

test('missing snapshots and textless media have readable fallbacks without borrowing the removal post', () => {
  const missing = formatLeaveNotification({ ...member, postAtAddition: null }, chat);
  assert.equal(missing.split('\n')[4], 'С какого поста подписался: нет данных');
  const media = formatLeaveNotification({ ...member, postAtAddition: { ...member.postAtAddition, preview: null } }, chat);
  assert.equal(media.split('\n')[4], 'С какого поста подписался: Пост без текста https://t.me/example_channel/128');
});

test('counts complete 24-hour days using event timestamps rather than calendar dates', () => {
  const cases = [
    ['2026-09-29T01:00:00Z', '2026-09-29T01:00:00Z', 'меньше 1'],
    ['2026-09-28T23:59:00Z', '2026-09-29T00:01:00Z', 'меньше 1'],
    ['2026-09-28T01:00:00Z', '2026-09-29T01:00:00Z', '1'],
    ['2026-09-27T01:00:01Z', '2026-09-29T01:00:00Z', '1'],
    ['2026-03-28T12:00:00+01:00', '2026-03-29T12:00:00+02:00', 'меньше 1'],
  ];
  for (const [addedAt, removedAt, expected] of cases) {
    assert.equal(formatLeaveNotification({ ...member, addedAt, removedAt }, chat).split('\n').at(-1),
      `Сколько дней провел на канале: ${expected}`);
  }
});
