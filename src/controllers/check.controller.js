const PRESENT = '✅ Пользователь есть на канале';
const ABSENT = '🚫 Пользователя нет на канале';
const INPUT_PROMPT = 'Пришли username или числовой ID пользователя. Для отмены отправь /cancel.';

function parseUser(value) {
  const input = value.trim();
  if (/^[1-9]\d*$/.test(input)) {
    const id = Number(input);
    return Number.isSafeInteger(id) ? { id } : null;
  }
  const username = input.replace(/^@/, '');
  return /^[a-z0-9_]{5,32}$/i.test(username) ? { username } : null;
}

function isPresent(member) {
  if (['creator', 'administrator', 'member'].includes(member?.status)) return true;
  if (member?.status === 'restricted' && typeof member.is_member === 'boolean') return member.is_member;
  if (['left', 'kicked'].includes(member?.status)) return false;
  throw new Error('UNKNOWN_MEMBER_STATUS');
}

function membershipErrorForLog(error) {
  const code = error?.response?.error_code;
  const description = error?.response?.description;
  if (Number.isInteger(code) && typeof description === 'string') {
    return `${code}: ${description.replace(/\s+/g, ' ').slice(0, 200)}`;
  }
  return /^[A-Z0-9_]+$/.test(error?.message || '') ? error.message : 'MEMBERSHIP_LOOKUP_FAILED';
}

function isInvalidParticipant(error) {
  return error?.response?.error_code === 400
    && /^(?:Bad Request: )?PARTICIPANT_ID_INVALID$/.test(error.response.description || '');
}

function registerCheckController(bot, { channelId, resolveUsername, logger = console }) {
  let awaitingUser = false;

  async function check(context, input) {
    const user = parseUser(input);
    if (!user) {
      await context.reply(INPUT_PROMPT);
      return;
    }
    let id = user.id;
    if (user.username) {
      if (!resolveUsername) {
        await context.reply('Проверка по username недоступна: сессия Telegram не подключена. Пришли числовой ID.');
        return;
      }
      try {
        id = await resolveUsername(user.username);
      } catch (error) {
        if (['USERNAME_NOT_OCCUPIED', 'USERNAME_NOT_A_USER'].includes(error.message)) {
          await context.reply(ABSENT);
          return;
        }
        logger.error('Username lookup failed:', /^[A-Z0-9_]+$/.test(error.message || '') ? error.message : 'USERNAME_LOOKUP_FAILED');
        await context.reply('Не удалось проверить пользователя. Попробуй ещё раз позже.');
        return;
      }
    }
    try {
      const member = await context.telegram.callApi('getChatMember', { chat_id: channelId, user_id: id });
      await context.reply(isPresent(member) ? PRESENT : ABSENT);
    } catch (error) {
      if (isInvalidParticipant(error)) {
        await context.reply(ABSENT);
        return;
      }
      logger.error('Channel membership lookup failed:', membershipErrorForLog(error));
      await context.reply('Не удалось проверить подписку. Попробуй ещё раз позже.');
    }
  }

  bot.command('check', async context => {
    if (context.chat?.type !== 'private') return;
    const input = context.message.text.replace(/^\/check(?:@\w+)?\s*/i, '').trim();
    awaitingUser = true;
    if (input) await check(context, input);
    else await context.reply(INPUT_PROMPT);
  });
  bot.on('text', async (context, next) => {
    if (!awaitingUser || context.chat?.type !== 'private') return next();
    const input = context.message.text.trim();
    if (input.startsWith('/')) {
      awaitingUser = false;
      if (/^\/cancel(?:@\w+)?$/i.test(input)) {
        await context.reply('Проверка отменена.');
        return;
      }
      return next();
    }
    await check(context, input);
  });
}

module.exports = registerCheckController;
