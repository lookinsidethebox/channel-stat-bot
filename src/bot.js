const { Telegraf } = require('telegraf');
const registerMessageController = require('./controllers/message.controller');
const registerChannelMemberController = require('./controllers/channel-member.controller');
const registerChannelPostController = require('./controllers/channel-post.controller');
const registerCampaignLinkController = require('./controllers/campaign-link.controller');
const createOwnerOnlyMiddleware = require('./middleware/owner-only.middleware');
const createOrderedChannelUpdatesMiddleware = require('./middleware/ordered-channel-updates.middleware');
const createDebugMemberUpdatesMiddleware = require('./middleware/debug-member-updates.middleware');
const { createMemberStore } = require('./storage/member.store');
const { createSourceStatisticsStore } = require('./storage/source-statistics.store');
const { createSourceStatisticsMonitor } = require('./services/source-statistics-monitor.service');
const { createTelegramStatisticsReader } = require('./services/telegram-statistics.service');
const { createTelegramAdsReader } = require('./services/telegram-ads.service');
const { createAdsStatisticsStore } = require('./storage/ads-statistics.store');
const { createAdsStatisticsMonitor } = require('./services/ads-statistics-monitor.service');
const { createMemberNotifier } = require('./services/member-notification.service');

function createBot({ token, ownerId, channelId, debugMemberUpdates = false, sourceStatistics: statisticsConfig, adsStatistics: adsConfig }, {
  memberStore = createMemberStore(),
  statisticsStore = createSourceStatisticsStore(channelId),
  statisticsReader,
  adsStatisticsStore = createAdsStatisticsStore(channelId),
  adsStatisticsReader,
  logger = console,
} = {}) {
  const bot = new Telegraf(token);
  const notifications = createMemberNotifier({
    memberStore, channelId, logger,
    sendMessage: message => bot.telegram.sendMessage(ownerId, message, { link_preview_options: { is_disabled: true } }),
  });
  bot.memberNotifications = notifications;
  if (adsConfig) {
    bot.adsStatistics = createAdsStatisticsMonitor({
      reader: adsStatisticsReader || createTelegramAdsReader({ ...adsConfig, getChannel: () => bot.telegram.getChat(channelId) }),
      statisticsStore: adsStatisticsStore, memberStore, logger,
      onChecked: notifications.sendPending,
    });
  }
  if (statisticsConfig) {
    bot.sourceStatistics = createSourceStatisticsMonitor({
      reader: statisticsReader || createTelegramStatisticsReader(statisticsConfig),
      statisticsStore, memberStore, logger,
      onChecked: notifications.sendPending,
    });
  }

  bot.use(createOrderedChannelUpdatesMiddleware());
  if (debugMemberUpdates) {
    bot.use(createDebugMemberUpdatesMiddleware({ channelId, logger }));
  }
  // Channel updates must be handled before filtering messages by their sender.
  registerChannelMemberController(bot, {
    channelId,
    ownerId,
    recordMemberEvent: memberStore.recordMemberEvent,
    getMemberAtRemoval: memberStore.getMemberAtRemoval,
    notifyJoins: notifications.sendPending,
    sourceStatistics: bot.sourceStatistics,
    adsStatistics: bot.adsStatistics,
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
