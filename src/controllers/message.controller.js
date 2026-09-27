function registerMessageController(bot) {
  bot.on('text', async (context) => {
    await context.reply('Hello, world!');
  });
}

module.exports = registerMessageController;
