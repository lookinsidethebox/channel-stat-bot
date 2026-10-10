function registerMessageController(bot, { getMonthlyStats, logger = console } = {}) {
  for (const [action, offset] of [['stats_month_current', 0], ['stats_month_previous', -1]]) {
    bot.action(action, async context => {
      await context.answerCbQuery();
      if (!getMonthlyStats) {
        await context.reply('Статистика недоступна: аккаунт Telegram для чтения счётчиков не подключён.');
        return;
      }
      let text;
      try {
        text = await getMonthlyStats(offset);
      } catch (error) {
        logger.error('Monthly stats button failed:', /^[A-Z][A-Z0-9_]+$/.test(error.message || '') ? error.message : 'MONTHLY_STATS_FAILED');
        await context.reply('Не удалось получить статистику. Попробуй ещё раз позже.');
        return;
      }
      await context.reply(text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    });
  }
  bot.on('message', async (context) => {
    await context.reply('✅ Бот работает', { reply_markup: { inline_keyboard: [
      [{ text: 'Показать статистику за этот месяц', callback_data: 'stats_month_current' }],
      [{ text: 'Показать статистику за прошлый месяц', callback_data: 'stats_month_previous' }],
    ] } });
  });
}

module.exports = registerMessageController;
