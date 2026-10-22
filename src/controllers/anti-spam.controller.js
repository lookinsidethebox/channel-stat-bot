const { createHash } = require('node:crypto');
const { normalize } = require('../storage/anti-spam.store');

const NO_SEND = {
  can_send_messages: false, can_send_audios: false, can_send_documents: false,
  can_send_photos: false, can_send_videos: false, can_send_video_notes: false,
  can_send_voice_notes: false, can_send_polls: false, can_send_other_messages: false,
  can_add_web_page_previews: false,
};
const ALL_PERMISSIONS = Object.fromEntries([
  ...Object.keys(NO_SEND), 'can_react_to_messages', 'can_edit_tag', 'can_change_info',
  'can_invite_users', 'can_pin_messages', 'can_manage_topics',
].map(key => [key, true]));

function profileFromMember(member, id) {
  const user = member?.user;
  if (user?.id !== id || typeof user.first_name !== 'string') return null;
  const name = [user.first_name, user.last_name].filter(value => typeof value === 'string')
    .join(' ').replace(/\s+/gu, ' ').trim();
  if (!name) return null;
  const profile = { name };
  if (typeof user.username === 'string' && user.username) profile.username = user.username;
  return profile;
}

function formatBlockedUser(id, profile) {
  return `${profile?.name || 'Имя недоступно'}${profile?.username ? ` (@${profile.username})` : ''} – ${id}`;
}

function phraseKey(phrase) {
  return createHash('sha256').update(normalize(phrase)).digest('hex').slice(0, 16);
}

function registerAntiSpamController(bot, { groupId, channelId, ownerId, store, logger = console }) {
  let awaitingSpamPhrase = false;
  const isOwnerPrivate = context => context.chat?.type === 'private' && String(context.from?.id) === String(ownerId);
  async function saveSpamPhrase(context, phrase) {
    try {
      const added = await store.addPhrase(phrase);
      awaitingSpamPhrase = false;
      await context.reply(added ? `Фраза добавлена: ${phrase}` : 'Такая фраза уже есть.');
    } catch (error) {
      if (error.message === 'ANTI_SPAM_INVALID_PHRASE') {
        await context.reply('Фраза должна содержать от 1 до 200 символов. Пришли другую фразу или отправь /cancel.');
      } else throw error;
    }
  }
  async function restrict(telegram, id) {
    const result = await telegram.callApi('restrictChatMember', {
      chat_id: groupId, user_id: id, permissions: NO_SEND, use_independent_chat_permissions: true,
    });
    if (result !== true) throw new Error('RESTRICT_CHAT_MEMBER_NOT_CONFIRMED');
  }
  async function inform(telegram, text) {
    try { await telegram.sendMessage(ownerId, text); }
    catch (error) { logger.error('Anti-spam owner notification failed:', error); }
  }
  async function forgiveOnJoin(telegram, userId) {
    const state = await store.read();
    if (!state.nonSubscriberBans.includes(userId)) return;
    if (state.blockedUsers.includes(userId) || state.pendingUsers.includes(userId)
      || state.bannedUsers.includes(userId)) return;
    const result = await telegram.callApi('unbanChatMember', {
      chat_id: groupId, user_id: userId, only_if_banned: true,
    });
    if (result !== true) throw new Error('UNBAN_CHAT_MEMBER_NOT_CONFIRMED');
    await store.forgiveSubscriber(userId);
  }

  bot.on(['message', 'edited_message'], async (context, next) => {
    const message = context.msg;
    if (String(message.chat.id) !== String(groupId)) return next();
    const user = message.from;
    if (!user || user.is_bot || String(user.id) === String(ownerId) || message.sender_chat || message.is_automatic_forward) return;
    try {
      const state = await store.read();
      const blocked = state.blockedUsers.includes(user.id);
      const pending = state.pendingUsers.includes(user.id);
      const banned = state.bannedUsers.includes(user.id);
      const nonSubscriberBan = state.nonSubscriberBans.includes(user.id);
      const content = normalize([message.text, message.caption].filter(Boolean).join(' '));
      const phrase = state.phrases.find(item => content.includes(normalize(item)));
      let nonSubscriber = false;
      if (!blocked && !pending && !banned && !phrase) {
        const member = await context.telegram.callApi('getChatMember', {
          chat_id: channelId, user_id: user.id,
        });
        const subscribed = ['creator', 'administrator', 'member'].includes(member.status)
          || (member.status === 'restricted' && member.is_member === true);
        if (subscribed) {
          if (nonSubscriberBan) await forgiveOnJoin(context.telegram, user.id);
          return;
        }
        nonSubscriber = member.status === 'left' || member.status === 'kicked'
          || (member.status === 'restricted' && member.is_member === false);
        if (!nonSubscriber) throw new Error(`UNKNOWN_CHANNEL_MEMBER_STATUS: ${member.status}`);
      }
      let restricted = true;
      if (phrase || pending || banned || nonSubscriber) {
        if (pending) await store.saveProfile(user.id, profileFromMember({ user }, user.id));
        // Ban even if Combot or the author deleted the message first.
        try { await context.telegram.deleteMessage(groupId, message.message_id); }
        catch (error) { logger.error('Anti-spam deletion failed:', error); }
        const result = await context.telegram.callApi('banChatMember', { chat_id: groupId, user_id: user.id });
        if (result !== true) throw new Error('BAN_CHAT_MEMBER_NOT_CONFIRMED');
        if (pending || phrase) await store.banId(user.id, profileFromMember({ user }, user.id) || undefined);
        else if (nonSubscriber && !phrase && !banned) await store.banNonSubscriber(user.id, profileFromMember({ user }, user.id) || undefined);
      } else {
        try { await restrict(context.telegram, user.id); }
        catch (error) { restricted = false; logger.error('Blocked user restriction failed:', error); }
        try { await context.telegram.deleteMessage(groupId, message.message_id); }
        catch (error) { logger.error('Blocked comment deletion failed:', error); }
      }
      await inform(context.telegram, `${phrase || pending || banned || nonSubscriber ? '🚫 Пользователь забанен' : restricted ? '🔇 Комментарии запрещены' : '⚠️ Не удалось ограничить комментарии'}: ${user.first_name || 'Пользователь'}, ID ${user.id}${nonSubscriber ? ' (не подписан на канал)' : ''}.`);
    } catch (error) {
      logger.error('Anti-spam moderation failed:', error);
      await inform(context.telegram, `Не удалось обработать сообщение ${message.message_id} в группе комментариев. Проверь права бота и журнал.`);
    }
  });

  bot.use(async (context, next) => {
    if (!awaitingSpamPhrase || !isOwnerPrivate(context) || !context.message?.text?.startsWith('/')) return next();
    if (/^\/cancel(?:@\w+)?(?:\s|$)/i.test(context.message.text)) {
      awaitingSpamPhrase = false;
      await context.reply('Добавление антиспам-фразы отменено.');
      return;
    }
    awaitingSpamPhrase = false;
    return next();
  });

  bot.command('spam_add', async context => {
    if (!isOwnerPrivate(context)) return;
    const phrase = context.message.text.replace(/^\/spam_add(?:@\w+)?\s*/i, '').trim();
    if (!phrase) {
      awaitingSpamPhrase = true;
      await context.reply('Какую антиспам-фразу добавить? Пришли её следующим сообщением. Для отмены отправь /cancel.');
      return;
    }
    await saveSpamPhrase(context, phrase);
  });
  bot.command('spam_remove', async context => {
    if (!isOwnerPrivate(context)) return;
    const phrase = context.message.text.replace(/^\/spam_remove(?:@\w+)?\s*/i, '').trim();
    if (phrase) {
      await context.reply(await store.removePhrase(phrase) ? 'Фраза удалена.' : 'Такой фразы нет.');
      return;
    }
    const { phrases } = await store.read();
    if (!phrases.length) {
      await context.reply('Антиспам-фраз пока нет.');
      return;
    }
    for (let start = 0; start < phrases.length; start += 30) {
      await context.reply('Выбери фразу для удаления:', { reply_markup: { inline_keyboard:
        phrases.slice(start, start + 30).map(item => [{
          text: [...item].slice(0, 50).join(''), callback_data: `spam_remove:${phraseKey(item)}`,
        }]),
      } });
    }
  });
  bot.action(/^spam_remove:([a-f0-9]{16})$/, async context => {
    if (!isOwnerPrivate(context)) return;
    const { phrases } = await store.read();
    const phrase = phrases.find(item => phraseKey(item) === context.match[1]);
    if (!phrase) {
      await context.answerCbQuery('Фраза уже удалена.');
      return;
    }
    const removed = await store.removePhrase(phrase);
    await context.answerCbQuery(removed ? 'Фраза удалена.' : 'Фраза уже удалена.');
    if (removed) await context.reply(`Фраза удалена: ${phrase}`);
  });
  bot.command('spam_list', async context => {
    if (!isOwnerPrivate(context)) return;
    const { phrases } = await store.read();
    if (!phrases.length) {
      await context.reply('Антиспам-фраз пока нет.');
      return;
    }
    let part = 'Антиспам-фразы:';
    for (const [index, phrase] of phrases.entries()) {
      const line = `${index + 1}. ${phrase}`;
      if (part.length + line.length + 1 > 3900) {
        await context.reply(part);
        part = line;
      } else part += `\n${line}`;
    }
    await context.reply(part);
  });
  bot.command('block', async context => {
    if (!isOwnerPrivate(context)) return;
    const argument = context.message.text.replace(/^\/block(?:@\w+)?\s*/i, '').trim();
    const id = Number(argument);
    if (!/^[1-9]\d*$/.test(argument) || !Number.isSafeInteger(id) || String(id) === String(ownerId)) {
      await context.reply('Укажи числовой ID пользователя: /block 8074667319');
      return;
    }
    const existing = await store.read();
    if (existing.nonSubscriberBans.includes(id)) {
      await store.banId(id);
      await context.reply(`ID ${id} переведён из автоматического бана в постоянный.`);
      return;
    }
    if (existing.pendingUsers.includes(id) || existing.bannedUsers.includes(id)) {
      await context.reply(`ID ${id} уже есть в списке запрета.`);
      return;
    }
    try {
      await restrict(context.telegram, id);
    } catch (error) {
      logger.error('Immediate comment restriction failed:', error);
      if (error.response?.description?.includes('PARTICIPANT_ID_INVALID')) {
        await store.pendId(id);
        await context.reply(`ID ${id} сохранён. Telegram пока не может ограничить пользователя. Если он напишет в группе комментариев, бот удалит сообщение и забанит его.`);
        return;
      }
      await context.reply(`Не удалось запретить комментарии для ID ${id}. ID не добавлен в список. Проверь права бота и статус пользователя в группе.`);
      return;
    }
    let profile = null;
    try {
      profile = profileFromMember(await context.telegram.callApi('getChatMember', {
        chat_id: groupId, user_id: id,
      }), id);
    } catch (error) {
      logger.error('Blocked user profile lookup failed:', error);
    }
    try {
      await store.blockId(id, profile || undefined);
    } catch (error) {
      logger.error('Restricted user persistence failed:', error);
      await context.reply(`Telegram запретил писать пользователю ID ${id}, но не удалось сохранить ID в списке бота. Проверь хранилище.`);
      return;
    }
    await context.reply(`Пользователь ID ${id} больше не может писать в группе комментариев.`);
  });
  bot.command('block_list', async context => {
    if (!isOwnerPrivate(context)) return;
    const state = await store.read();
    const ids = [...new Set([...state.blockedUsers, ...state.pendingUsers, ...state.bannedUsers, ...state.nonSubscriberBans])];
    if (!ids.length) {
      await context.reply('Список ограниченных пользователей пуст.');
      return;
    }
    const lines = [];
    for (const id of ids) {
      let profile = state.profiles[String(id)];
      try {
        const current = profileFromMember(await context.telegram.callApi('getChatMember', {
          chat_id: groupId, user_id: id,
        }), id);
        if (current) {
          if (JSON.stringify(current) !== JSON.stringify(profile)) await store.saveProfile(id, current);
          profile = current;
        }
      } catch (error) {
        logger.error('Blocked user profile lookup failed:', error);
      }
      const status = state.pendingUsers.includes(id) ? ' (ожидает первого сообщения)'
        : state.bannedUsers.includes(id) ? ' (забанен)'
          : state.nonSubscriberBans.includes(id) ? ' (не подписан)' : '';
      lines.push(`${formatBlockedUser(id, profile)}${status}`);
    }
    let part = 'Запрещено писать в группе:';
    for (const line of lines) {
      if (part.length + line.length + 1 > 3900) {
        await context.reply(part);
        part = line;
      } else part += `\n${line}`;
    }
    await context.reply(part);
  });
  bot.command('unblock', async context => {
    if (!isOwnerPrivate(context)) return;
    const argument = context.message.text.replace(/^\/unblock(?:@\w+)?\s*/i, '').trim();
    const id = Number(argument);
    if (!/^[1-9]\d*$/.test(argument) || !Number.isSafeInteger(id)) {
      await context.reply('Укажи числовой ID пользователя: /unblock 8074667319');
      return;
    }
    const state = await store.read();
    if (![...state.blockedUsers, ...state.pendingUsers, ...state.bannedUsers, ...state.nonSubscriberBans].includes(id)) {
      await context.reply(`ID ${id} нет в списке ограниченных пользователей.`);
      return;
    }
    if (!state.pendingUsers.includes(id)) {
      try {
        const result = state.bannedUsers.includes(id) || state.nonSubscriberBans.includes(id)
          ? await context.telegram.callApi('unbanChatMember', {
            chat_id: groupId, user_id: id, only_if_banned: true,
          })
          : await context.telegram.callApi('restrictChatMember', {
            chat_id: groupId, user_id: id, permissions: ALL_PERMISSIONS,
            use_independent_chat_permissions: true,
          });
        if (result !== true) throw new Error('UNBLOCK_NOT_CONFIRMED');
      } catch (error) {
        logger.error('Comment unrestriction failed:', error);
        await context.reply(`Не удалось вернуть возможность писать пользователю ID ${id}. Он остаётся в списке.`);
        return;
      }
    }
    try {
      await store.unblockId(id);
    } catch (error) {
      logger.error('Unrestricted user persistence failed:', error);
      await context.reply(`Telegram разрешил писать пользователю ID ${id}, но не удалось удалить ID из списка бота. Проверь хранилище.`);
      return;
    }
    await context.reply(state.pendingUsers.includes(id)
      ? `Отложенный запрет для ID ${id} отменён.`
      : `Пользователь ID ${id} снова может писать в группе комментариев.`);
  });
  bot.on('text', async (context, next) => {
    if (!awaitingSpamPhrase || !isOwnerPrivate(context)) return next();
    await saveSpamPhrase(context, context.message.text.trim());
  });
  return { forgiveOnJoin };
}

module.exports = registerAntiSpamController;
