const { createPostSnapshot } = require('./member-event.service');

async function fetchChannelPostAt(telegram, { ownerId, channelId, occurredAt }) {
  const eventTime = Date.parse(occurredAt) / 1000;
  if (!Number.isFinite(eventTime)) throw new Error('Invalid membership event time.');

  async function request(method, payload) {
    try {
      return await telegram.callApi(method, payload, { signal: AbortSignal.timeout(10000) });
    } catch {
      throw new Error('Не удалось запросить посты у Telegram.');
    }
  }

  const owner = await request('getChat', { chat_id: ownerId });
  if (String(owner.personal_chat?.id) !== String(channelId)) {
    throw new Error('Укажи отслеживаемый канал в своём профиле Telegram, чтобы бот мог запрашивать его посты.');
  }

  // Bot API 10.0+: this method reads existing posts from the user's profile channel.
  const posts = await request('getUserPersonalChatMessages', { user_id: Number(ownerId), limit: 20 });
  if (!Array.isArray(posts) || posts.some((post) => (
    !post || String(post.chat?.id) !== String(channelId)
    || !Number.isSafeInteger(post.message_id) || post.message_id <= 0
    || !Number.isFinite(post.date) || post.date <= 0
  ))) {
    throw new Error('Telegram вернул неожиданные данные постов канала.');
  }
  if (posts.length === 0) return null;

  const post = posts.filter((entry) => entry.date <= eventTime)
    .reduce((latest, entry) => (!latest || entry.message_id > latest.message_id ? entry : latest), null);
  if (!post) {
    throw new Error('В последних 20 постах нет публикации на момент события.');
  }
  if (post.edit_date > eventTime) {
    throw new Error('Последний пост изменён после события; прежний текст недоступен.');
  }

  return createPostSnapshot(post);
}

module.exports = { fetchChannelPostAt };
