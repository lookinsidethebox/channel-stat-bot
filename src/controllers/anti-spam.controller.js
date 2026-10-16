const { normalize } = require('../storage/anti-spam.store');

const NO_SEND = {
  can_send_messages: false, can_send_audios: false, can_send_documents: false,
  can_send_photos: false, can_send_videos: false, can_send_video_notes: false,
  can_send_voice_notes: false, can_send_polls: false, can_send_other_messages: false,
  can_add_web_page_previews: false,
};

function forwardedUser(message) {
  if (message?.forward_origin?.type === 'user') return message.forward_origin.sender_user;
  if (message?.forward_from) return message.forward_from;
  return null;
}

function registerAntiSpamController(bot, { groupId, ownerId, store, logger = console }) {
  let awaitingForward = false;
  const isOwnerPrivate = context => context.chat?.type === 'private' && String(context.from?.id) === String(ownerId);
  async function restrict(telegram, id) {
    await telegram.callApi('restrictChatMember', {
      chat_id: groupId, user_id: id, permissions: NO_SEND, use_independent_chat_permissions: true,
    });
  }
  async function inform(telegram, text) {
    try { await telegram.sendMessage(ownerId, text); }
    catch (error) { logger.error('Anti-spam owner notification failed:', error); }
  }

  bot.on(['message', 'edited_message'], async (context, next) => {
    const message = context.msg;
    if (String(message.chat.id) !== String(groupId)) return next();
    const user = message.from;
    if (!user || user.is_bot || String(user.id) === String(ownerId) || message.sender_chat || message.is_automatic_forward) return;
    try {
      const state = await store.read();
      const name = user.username?.toLowerCase();
      const blocked = state.blockedUsers.includes(user.id) || (name && state.blockedUsernames.includes(name));
      const content = normalize([message.text, message.caption].filter(Boolean).join(' '));
      const phrase = state.phrases.find(item => content.includes(normalize(item)));
      if (name) await store.rememberUser(user);
      if (!blocked && !phrase) return;
      let restricted = true;
      if (phrase) {
        // Ban even if Combot or the author deleted the message first.
        try { await context.telegram.deleteMessage(groupId, message.message_id); }
        catch (error) { logger.error('Anti-spam deletion failed:', error); }
        await context.telegram.callApi('banChatMember', { chat_id: groupId, user_id: user.id });
      } else {
        try { await restrict(context.telegram, user.id); }
        catch (error) { restricted = false; logger.error('Blocked user restriction failed:', error); }
        try { await context.telegram.deleteMessage(groupId, message.message_id); }
        catch (error) { logger.error('Blocked comment deletion failed:', error); }
      }
      if (name && blocked && !state.blockedUsers.includes(user.id)) await store.blockId(user.id);
      await inform(context.telegram, `${phrase ? '🚫 Спам: пользователь забанен' : restricted ? '🔇 Комментарии запрещены' : '⚠️ Не удалось ограничить комментарии'}: ${user.first_name || 'Пользователь'}${name ? ` (@${name})` : ''}, ID ${user.id}.`);
    } catch (error) {
      logger.error('Anti-spam moderation failed:', error);
      await inform(context.telegram, `Не удалось обработать сообщение ${message.message_id} в группе комментариев. Проверь права бота и журнал.`);
    }
  });

  bot.command('spam_add', async context => {
    if (!isOwnerPrivate(context)) return;
    const phrase = context.message.text.replace(/^\/spam_add(?:@\w+)?\s*/i, '').trim();
    try {
      const added = await store.addPhrase(phrase);
      await context.reply(added ? `Фраза добавлена: ${phrase}` : 'Такая фраза уже есть.');
    } catch (error) {
      if (error.message === 'ANTI_SPAM_INVALID_PHRASE') await context.reply('Укажи фразу длиной от 1 до 200 символов: /spam_add фраза');
      else throw error;
    }
  });
  bot.command('spam_remove', async context => {
    if (!isOwnerPrivate(context)) return;
    const phrase = context.message.text.replace(/^\/spam_remove(?:@\w+)?\s*/i, '').trim();
    await context.reply(await store.removePhrase(phrase) ? 'Фраза удалена.' : 'Такой фразы нет.');
  });
  bot.command('spam_list', async context => {
    if (!isOwnerPrivate(context)) return;
    const { phrases } = await store.read();
    await context.reply(phrases.length ? `Антиспам-фразы:\n${phrases.map((item, index) => `${index + 1}. ${item}`).join('\n')}` : 'Антиспам-фраз пока нет.');
  });
  bot.command('comment_block', async context => {
    if (!isOwnerPrivate(context)) return;
    const argument = context.message.text.replace(/^\/comment_block(?:@\w+)?\s*/i, '').trim();
    const forwarded = forwardedUser(context.message.reply_to_message);
    const id = forwarded?.id || (/^[1-9]\d*$/.test(argument) ? Number(argument) : null);
    try {
      if (id && Number.isSafeInteger(id) && String(id) !== String(ownerId)) {
        await store.blockId(id);
        awaitingForward = false;
        try {
          await restrict(context.telegram, id);
          await context.reply(`Пользователь ID ${id} больше не может отправлять комментарии.`);
        } catch (error) {
          logger.error('Immediate comment restriction failed:', error);
          await context.reply(`ID ${id} сохранён. Telegram пока не применил ограничение; бот удалит первое сообщение пользователя и повторит запрет. Проверь права бота в группе.`);
        }
      } else if (/^@[a-zA-Z0-9_]{5,32}$/.test(argument)) {
        const knownId = await store.blockUsername(argument);
        let restricted = false;
        if (knownId) {
          try {
            const member = await context.telegram.callApi('getChatMember', { chat_id: groupId, user_id: knownId });
            if (member.user?.username?.toLowerCase() === argument.slice(1).toLowerCase()) {
              await restrict(context.telegram, knownId);
              await store.blockId(knownId);
              restricted = true;
            }
          } catch (error) { logger.error('Username lookup/restriction failed:', error); }
        }
        awaitingForward = false;
        await context.reply(restricted
          ? `Комментарии для ${argument} запрещены (ID ${knownId}).`
          : `Имя ${argument} сохранено. Telegram не дал подтвердить ID сейчас; бот запретит комментарии при первом сообщении этого пользователя в группе. Для немедленного запрета перешли его сообщение боту.`);
      } else if (!argument) {
        awaitingForward = true;
        await context.reply('Перешли сообщение пользователя следующим сообщением или ответь командой /comment_block на уже пересланное сообщение.');
      } else {
        await context.reply('Используй /comment_block @username, /comment_block ID или перешли сообщение после /comment_block.');
      }
    } catch (error) {
      logger.error('Comment restriction failed:', error);
      await context.reply('Не удалось запретить комментарии. Проверь ID пользователя и право бота ограничивать участников группы.');
    }
  });
  bot.command('comment_unblock', async context => {
    if (!isOwnerPrivate(context)) return;
    const value = context.message.text.replace(/^\/comment_unblock(?:@\w+)?\s*/i, '').trim();
    if (!/^(@[a-zA-Z0-9_]{5,32}|[1-9]\d*)$/.test(value)) {
      await context.reply('Используй /comment_unblock @username или /comment_unblock ID.');
      return;
    }
    const state = await store.read();
    const id = value.startsWith('@') ? state.knownUsers[value.slice(1).toLowerCase()] : Number(value);
    const name = value.startsWith('@') ? value.slice(1).toLowerCase() : null;
    const wasBlocked = (name && state.blockedUsernames.includes(name)) || state.blockedUsers.includes(id);
    if (!wasBlocked) {
      await context.reply('Такого запрета нет.');
      return;
    }
    let telegramFailed = false;
    if (id && state.blockedUsers.includes(id)) {
      try {
        await context.telegram.callApi('restrictChatMember', {
          chat_id: groupId, user_id: id, permissions: Object.fromEntries(Object.keys(NO_SEND).map(key => [key, true])),
          use_independent_chat_permissions: true,
        });
      } catch (error) { telegramFailed = true; logger.error('Comment unrestriction failed:', error); }
    }
    await store.unblock(value);
    await context.reply(telegramFailed
      ? `Правило для ${value} удалено, но Telegram не снял ограничение. Проверь права бота и статус пользователя в группе.`
      : `Запрет комментариев для ${value} снят.`);
  });
  bot.on('message', async (context, next) => {
    if (!isOwnerPrivate(context)) return next();
    const forwarded = Boolean(context.message.forward_origin || context.message.forward_from || context.message.forward_sender_name);
    if (!forwarded && !awaitingForward) return next();
    if (!forwarded && context.message.text?.startsWith('/')) return next();
    const user = forwardedUser(context.message);
    if (!user?.id || String(user.id) === String(ownerId)) {
      await context.reply('В пересланном сообщении Telegram скрыл отправителя. Нужен ID или сообщение с доступным автором.');
      return;
    }
    awaitingForward = false;
    try {
      await store.blockId(user.id);
      try {
        await restrict(context.telegram, user.id);
        await context.reply(`Пользователь ID ${user.id} больше не может отправлять комментарии.`);
      } catch (error) {
        logger.error('Immediate forwarded restriction failed:', error);
        await context.reply(`ID ${user.id} сохранён. Telegram пока не применил ограничение; бот удалит первое сообщение пользователя и повторит запрет. Проверь права бота в группе.`);
      }
    } catch (error) {
      logger.error('Forwarded comment restriction failed:', error);
      await context.reply('Не удалось запретить комментарии. Проверь права бота в группе.');
    }
  });
}

module.exports = registerAntiSpamController;
