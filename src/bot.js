const { Telegraf } = require('telegraf');
const registerMessageController = require('./controllers/message.controller');
const registerChannelMemberController = require('./controllers/channel-member.controller');
const registerChannelPostController = require('./controllers/channel-post.controller');
const registerCampaignLinkController = require('./controllers/campaign-link.controller');
const createOwnerOnlyMiddleware = require('./middleware/owner-only.middleware');
const createOrderedChannelUpdatesMiddleware = require('./middleware/ordered-channel-updates.middleware');
const createDebugMemberUpdatesMiddleware = require('./middleware/debug-member-updates.middleware');
const { createMemberStore } = require('./storage/member.store');

function createBot({ token, ownerId, channelId, debugMemberUpdates = false }, {
  memberStore = createMemberStore(),
  logger = console,
} = {}) {
  const bot = new Telegraf(token);

  bot.use(createOrderedChannelUpdatesMiddleware());
  if (debugMemberUpdates) {
    bot.use(createDebugMemberUpdatesMiddleware({ channelId, logger }));
  }
  // Channel updates must be handled before filtering messages by their sender.
  registerChannelMemberController(bot, {
    channelId,
    ownerId,
    recordMemberEvent: memberStore.recordMemberEvent,
    logger,
  });
  registerChannelPostController(bot, { channelId, savePost: memberStore.saveLatestPost });
  bot.use(createOwnerOnlyMiddleware(ownerId));
  registerCampaignLinkController(bot, { channelId, logger });
  registerMessageController(bot);

  bot.catch((error) => {
    logger.error('Telegram bot error:', error);
  });

  return bot;
}

module.exports = { createBot };
