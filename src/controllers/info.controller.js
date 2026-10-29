const { parseUser } = require('./check.controller');
const { formatDateTime, formatPost, formatMemberName, sourceLabels } = require('../services/member-notification.service');

const INPUT_PROMPT = 'Пришли username или числовой ID пользователя. Для отмены отправь /cancel.';
const NO_DATA = 'Информации о вступлении этого пользователя на канал нет.';

function formatDays(start, end) {
  const elapsed = (typeof end === 'number' ? end : Date.parse(end)) - Date.parse(start);
  if (!Number.isFinite(elapsed) || elapsed < 0) return 'нет данных';
  const days = Math.floor(elapsed / 86400000);
  if (days === 0) return 'меньше 1 дня';
  const suffix = days % 100 >= 11 && days % 100 <= 14 ? 'дней'
    : days % 10 === 1 ? 'день' : [2, 3, 4].includes(days % 10) ? 'дня' : 'дней';
  return `${days} ${suffix}`;
}

function formatInfo(member, channelId, now) {
  const source = member.source?.type;
  const campaign = source === 'ads' ? member.adsCampaign : source === 'url' ? member.urlCampaign : null;
  const lines = [
    `Имя: ${formatMemberName(member)}`,
    `ID: ${member.userId}`,
    `Добавился: ${formatDateTime(member.addedAt)}`,
    member.removedAt ? `Провёл на канале: ${formatDays(member.addedAt, member.removedAt)}`
      : `На канале: ${formatDays(member.addedAt, now)}`,
    `Пост при вступлении: ${formatPost(member.postAtAddition, { id: channelId })}`,
    `Источник: ${sourceLabels[source] || 'нет данных'}${member.source?.name ? ` (${member.source.name})` : ''}`,
    `Кампания: ${campaign?.title || 'нет данных'}`,
  ];
  if (member.removedAt) lines.push(`Покинул канал: ${formatDateTime(member.removedAt)}`);
  return lines.join('\n');
}

function registerInfoController(bot, { channelId, memberStore, resolveUsername, logger = console,
  now = () => Date.now() }) {
  let awaitingUser = false;

  async function info(context, input) {
    const user = parseUser(input);
    if (!user) return context.reply(INPUT_PROMPT);
    let id = user.id;
    if (user.username) {
      if (!resolveUsername) {
        return context.reply('Поиск по username недоступен: сессия Telegram не подключена. Пришли числовой ID.');
      }
      try {
        id = await resolveUsername(user.username);
      } catch (error) {
        if (['USERNAME_NOT_OCCUPIED', 'USERNAME_NOT_A_USER'].includes(error.message)) return context.reply(NO_DATA);
        logger.error('Info username lookup failed:', /^[A-Z0-9_]+$/.test(error.message || '') ? error.message : 'USERNAME_LOOKUP_FAILED');
        return context.reply('Не удалось найти пользователя. Попробуй ещё раз позже.');
      }
    }
    try {
      const member = await memberStore.getLatestMember(id);
      return context.reply(member?.addedAt ? formatInfo(member, channelId, now()) : NO_DATA,
        { link_preview_options: { is_disabled: true } });
    } catch {
      logger.error('Info member data lookup failed.');
      return context.reply('Не удалось прочитать информацию. Попробуй ещё раз позже.');
    }
  }

  bot.command('info', async context => {
    if (context.chat?.type !== 'private') return;
    const input = context.message.text.replace(/^\/info(?:@\w+)?\s*/i, '').trim();
    awaitingUser = true;
    if (input) await info(context, input);
    else await context.reply(INPUT_PROMPT);
  });
  bot.on('text', async (context, next) => {
    if (!awaitingUser || context.chat?.type !== 'private') return next();
    const input = context.message.text.trim();
    if (input.startsWith('/')) {
      awaitingUser = false;
      if (/^\/cancel(?:@\w+)?$/i.test(input)) {
        await context.reply('Поиск отменён.');
        return;
      }
      return next();
    }
    await info(context, input);
  });
}

module.exports = { registerInfoController, formatInfo };
