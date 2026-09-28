const { createMemberEvent } = require('../services/member-event.service');
const { fetchChannelPostAt } = require('../services/channel-post.service');

function describeSource(source, lookup) {
  const labels = { url: 'URL', ads: 'Ads', chat_folder: 'Shareable Chat Folders', search: 'Search', pm: 'PM' };
  if (source?.attribution === 'statistics_delta' && labels[source.type]) {
    return `${labels[source.type]} (по изменению статистики)`;
  }
  if (source?.attribution === 'manual' && labels[source.type]) {
    return `${labels[source.type]} (подтверждено владельцем)`;
  }
  if ((!source || source.type === 'unknown') && lookup?.status === 'pending') {
    return 'ожидает обновления статистики';
  }
  if ((!source || source.type === 'unknown') && lookup?.status === 'unresolved') {
    return 'неизвестно (изменение статистики не позволило определить источник)';
  }
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
  channelId, ownerId, recordMemberEvent, fetchPost = fetchChannelPostAt, sourceStatistics, logger = console,
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

    if (sourceStatistics && event.action === 'joined') event.sourceLookup = { status: 'pending' };
    const saved = await recordMemberEvent(event, post);
    if (!saved) {
      return;
    }

    if (sourceStatistics && event.action === 'joined') {
      try {
        const updated = await sourceStatistics.checkJoin(event);
        if (updated) {
          event.source = updated.source;
          event.sourceLookup = updated.sourceLookup;
        }
      } catch (error) {
        logger.error('Source statistics state error:', error.message);
      }
    }

    const user = event.user;
    const userName = user.username
      ? `@${user.username}`
      : user.name || `ID ${user.id}`;
    const action = event.action === 'joined' ? 'добавлен в канал' : 'покинул канал';
    const sourceText = event.action === 'joined'
      ? ` Источник: ${describeSource(event.source, event.sourceLookup)}.`
      : ' Запись об отписке сохранена.';
    const postErrorText = event.postLookupError ? ` Пост не получен: ${event.postLookupError}` : '';
    const message = `Пользователь ${userName} (${user.id}) ${action}.${sourceText}${postErrorText}`;

    logger.log(message);
    await context.telegram.sendMessage(ownerId, message);
  });
}

module.exports = registerChannelMemberController;
module.exports.describeSource = describeSource;
