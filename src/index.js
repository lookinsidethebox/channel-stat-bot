const { createBot } = require('./bot');
const { loadConfig } = require('./config');

async function main() {
  require('dotenv').config();
  const bot = createBot(loadConfig());

  async function stop(signal) {
    try {
      bot.stop(signal);
    } catch (error) {
      // During connection setup there is no polling loop to stop yet.
      if (error.message !== 'Bot is not running!') throw error;
      await bot.sourceStatistics?.stop();
      process.exit(0);
    }
  }

  const onInterrupt = () => stop('SIGINT');
  const onTerminate = () => stop('SIGTERM');
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onTerminate);

  try {
    await bot.sourceStatistics?.start();
    await bot.launch({
      allowedUpdates: ['message', 'chat_member', 'channel_post', 'edited_channel_post'],
    }, () => {
      console.log('Connected to Telegram. Starting the bot.');
    });
  } finally {
    await bot.sourceStatistics?.stop();
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Bot stopped with an error:', error);
    process.exitCode = 1;
  });
}
