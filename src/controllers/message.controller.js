function registerMessageController(bot) {
  bot.on('text', async (context) => {
    await context.reply('✅ Бот работает');
  });
}

module.exports = registerMessageController;
