const { addDays } = require('../storage/url-promos.store');

function parseDate(value) {
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value.trim());
  if (!match) return null;
  const date = `${match[3]}-${match[2]}-${match[1]}`;
  try { return addDays(date, 0) === date ? date : null; }
  catch { return null; }
}

function registerUrlPromoController(bot, { urlPromos, logger = console }) {
  const drafts = new Map();
  bot.command('promo', async context => {
    if (context.chat?.type !== 'private') {
      await context.reply('Создай промо в личном чате с ботом.');
      return;
    }
    drafts.set(String(context.chat.id), { step: 'title' });
    await context.reply('Название URL-кампании? Для отмены отправь /cancel.');
  });
  bot.command('cancel', async context => {
    if (drafts.delete(String(context.chat?.id))) await context.reply('Создание промо отменено.');
  });
  bot.on('text', async (context, next) => {
    const key = String(context.chat?.id);
    const draft = drafts.get(key);
    if (!draft || context.chat?.type !== 'private') return next();
    const value = context.message.text.trim();
    if (value.startsWith('/')) return next();
    if (draft.step === 'title') {
      if (!value || [...value].length > 100) {
        await context.reply('Название должно содержать от 1 до 100 символов.');
        return;
      }
      draft.title = value;
      draft.step = 'date';
      await context.reply('Дата начала по времени Подгорицы? Формат ДД.ММ.ГГГГ.');
      return;
    }
    if (draft.step === 'date') {
      const date = parseDate(value);
      if (!date) {
        await context.reply('Неверная дата. Введи ДД.ММ.ГГГГ, например 30.09.2026.');
        return;
      }
      draft.startDate = date;
      draft.step = 'days';
      await context.reply('Сколько календарных дней будет идти промо?');
      return;
    }
    const days = Number(value);
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(days) || days > 3650) {
      await context.reply('Введи целое число дней от 1 до 3650.');
      return;
    }
    let result;
    try {
      result = await urlPromos.add({ title: draft.title, startDate: draft.startDate, days });
    } catch (error) {
      if (error.message === 'URL_PROMO_OVERLAP') {
        await context.reply('Этот период пересекается с другой URL-кампанией. Введи другое число дней или отправь /promo заново.');
      } else {
        drafts.delete(key);
        logger.error('Failed to save URL promo:', error);
        await context.reply(error.promoSaved
          ? 'Кампания сохранена, но не удалось разметить участников. Бот повторит попытку при следующей проверке.'
          : 'Не удалось сохранить промо. Проверь данные и повтори команду.');
      }
      return;
    }
    drafts.delete(key);
    const { campaign, assigned } = result;
    await context.reply(`URL-кампания «${campaign.title}» сохранена: ${campaign.startDate} — ${addDays(campaign.startDate, campaign.days - 1)}. Уже добавившихся через URL: ${assigned}.`);
  });
}

module.exports = registerUrlPromoController;
