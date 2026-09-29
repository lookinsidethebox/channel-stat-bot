function registerStatsController(bot, { getStats, logger = console }) {
  bot.command('stats', async context => {
    if (!getStats) {
      await context.reply('Статистика недоступна: аккаунт Telegram для чтения счётчиков не подключён.');
      return;
    }

    let text;
    try {
      text = await getStats();
    } catch (error) {
      logger.error('Stats command failed:', /^[A-Z][A-Z0-9_]+$/.test(error.message || '') ? error.message : 'STATS_FAILED');
      await context.reply('Не удалось получить статистику. Попробуй ещё раз позже.');
      return;
    }

    await context.reply(text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
  });
}

module.exports = registerStatsController;
