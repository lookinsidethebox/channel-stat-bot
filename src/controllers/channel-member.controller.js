const { createMemberEvent } = require('../services/member-event.service');
const { fetchChannelPostAt } = require('../services/channel-post.service');

function describeSource(source) {
  if (!source) {
    return 'неизвестно (Telegram не передал источник)';
  }

  if (source.type === 'invite_link') {
    return source.name ? `ссылка «${source.name}»` : 'пригласительная ссылка без метки';
  }

  if (source.type === 'chat_folder') {
    return 'папка чатов';
  }

  if (source.type === 'join_request') {
    return 'заявка на вступление';
  }

  return 'неизвестно (Telegram не передал источник)';
}

function registerChannelMemberController(bot, {
  channelId, ownerId, recordMemberEvent, fetchPost = fetchChannelPostAt, logger = console,
}) {
  bot.on('chat_member', async (context) => {
    const update = context.chatMember;

    if (String(update.chat.id) !== String(channelId)) {
      return;
    }

    const event = createMemberEvent(update);
    if (!event) {
      return;
    }

    let post = null;
    try {
      post = await fetchPost(context.telegram, { channelId, ownerId, occurredAt: event.occurredAt });
    } catch (error) {
      event.postLookupError = error.message;
      logger.error('Failed to fetch the post for a member event:', error);
    }

    const saved = await recordMemberEvent(event, post);
    if (!saved) {
      return;
    }

    const user = event.user;
    const userName = user.username
      ? `@${user.username}`
      : user.name || `ID ${user.id}`;
    const action = event.action === 'joined' ? 'добавлен в канал' : 'покинул канал';
    const sourceText = event.action === 'joined'
      ? ` Источник: ${describeSource(event.source)}.`
      : ' Запись об отписке сохранена.';
    const postErrorText = event.postLookupError ? ` Пост не получен: ${event.postLookupError}` : '';
    const message = `Пользователь ${userName} (${user.id}) ${action}.${sourceText}${postErrorText}`;

    logger.log(message);
    await context.telegram.sendMessage(ownerId, message);
  });
}

module.exports = registerChannelMemberController;
