const botService = require('../services/bot.service');

function registerMessageController(bot) {
  bot.on('text', async (context) => {
    const response = botService.getMessageResponse();
    await context.reply(response);
  });
}

module.exports = registerMessageController;