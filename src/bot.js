const { Telegraf } = require('telegraf');
const registerMessageController = require('./controllers/message.controller');
const registerChannelMemberController = require('./controllers/channel-member.controller');
const registerChannelPostController = require('./controllers/channel-post.controller');
const registerCampaignLinkController = require('./controllers/campaign-link.controller');
const registerUrlPromoController = require('./controllers/url-promo.controller');
const registerStatsController = require('./controllers/stats.controller');
const createOwnerOnlyMiddleware = require('./middleware/owner-only.middleware');
const createOrderedChannelUpdatesMiddleware = require('./middleware/ordered-channel-updates.middleware');
const createDebugMemberUpdatesMiddleware = require('./middleware/debug-member-updates.middleware');
const { createMemberStore } = require('./storage/member.store');
const { createUrlPromosStore } = require('./storage/url-promos.store');
const { createUrlPromosService } = require('./services/url-promos.service');
const { createSourceStatisticsStore } = require('./storage/source-statistics.store');
const { createSourceStatisticsMonitor } = require('./services/source-statistics-monitor.service');
const { createTelegramStatisticsReader } = require('./services/telegram-statistics.service');
const { createTelegramAdsReader } = require('./services/telegram-ads.service');
const { createAdsStatisticsStore } = require('./storage/ads-statistics.store');
const { createAdsStatisticsMonitor } = require('./services/ads-statistics-monitor.service');
const { createMemberNotifier } = require('./services/member-notification.service');
const { createDailySummaryStore } = require('./storage/daily-summary.store');
const { createDailySummaryMonitor } = require('./services/daily-summary-monitor.service');
const { createStatsReporter } = require('./services/stats-report.service');
const { createReactionStatistics } = require('./services/reaction-statistics.service');

function createBot({ token, ownerId, channelId, debugMemberUpdates = false, sourceStatistics: statisticsConfig, adsStatistics: adsConfig, dailySummary = false }, {
  memberStore = createMemberStore(),
  urlPromosStore = createUrlPromosStore(),
  statisticsStore = createSourceStatisticsStore(channelId),
  statisticsReader,
  adsStatisticsStore = createAdsStatisticsStore(channelId),
  adsStatisticsReader,
  dailySummaryStore = createDailySummaryStore(channelId),
  logger = console,
} = {}) {
  const bot = new Telegraf(token);
  const orderedUpdates = createOrderedChannelUpdatesMiddleware();
  const channelStatisticsReader = statisticsConfig && (statisticsReader || createTelegramStatisticsReader(statisticsConfig));
  const notifications = createMemberNotifier({
    memberStore, channelId, logger,
    sendMessage: message => bot.telegram.sendMessage(ownerId, message, { link_preview_options: { is_disabled: true } }),
  });
  bot.memberNotifications = notifications;
  bot.urlPromos = createUrlPromosService({ store: urlPromosStore, memberStore });
  const sendPendingJoins = async () => {
    await bot.urlPromos.sync();
    await notifications.sendPending();
  };
  if (adsConfig) {
    bot.adsStatistics = createAdsStatisticsMonitor({
      reader: adsStatisticsReader || createTelegramAdsReader({ ...adsConfig, getChannel: () => bot.telegram.getChat(channelId) }),
      statisticsStore: adsStatisticsStore, memberStore, logger,
      onChecked: sendPendingJoins,
    });
  }
  if (statisticsConfig) {
    bot.reactionStatistics = createReactionStatistics({ reader: channelStatisticsReader, summaryStore: dailySummaryStore, logger });
    bot.sourceStatistics = createSourceStatisticsMonitor({
      reader: channelStatisticsReader,
      statisticsStore, memberStore, logger,
      onChecked: sendPendingJoins,
    });
  }

  if (dailySummary) {
    if (!channelStatisticsReader) throw new Error('DAILY_SUMMARY_REQUIRES_USER_SESSION');
    bot.dailySummary = createDailySummaryMonitor({
      reader: { fetch: options => channelStatisticsReader.fetchDailyPosts(options) },
      summaryStore: dailySummaryStore, memberStore, logger,
      reactionStatistics: bot.reactionStatistics,
      beforeReport: orderedUpdates.drain,
      sendMessage: text => bot.telegram.sendMessage(ownerId, text, {
        parse_mode: 'HTML', link_preview_options: { is_disabled: true },
      }),
    });
  }

  bot.use(orderedUpdates);
  if (debugMemberUpdates) {
    bot.use(createDebugMemberUpdatesMiddleware({ channelId, logger }));
  }
  // Channel updates must be handled before filtering messages by their sender.
  registerChannelMemberController(bot, {
    channelId,
    ownerId,
    recordMemberEvent: memberStore.recordMemberEvent,
    getMemberAtRemoval: memberStore.getMemberAtRemoval,
    notifyJoins: sendPendingJoins,
    sourceStatistics: bot.sourceStatistics,
    adsStatistics: bot.adsStatistics,
    logger,
  });
  registerChannelPostController(bot, { channelId, savePost: memberStore.saveLatestPost });
  bot.use(createOwnerOnlyMiddleware(ownerId));
  registerCampaignLinkController(bot, { channelId, logger });
  registerUrlPromoController(bot, { urlPromos: bot.urlPromos, logger });
  registerStatsController(bot, {
    logger,
    getStats: channelStatisticsReader && createStatsReporter({
      channelId, reader: { fetch: options => channelStatisticsReader.fetchDailyPosts(options) },
      summaryStore: dailySummaryStore, memberStore, beforeReport: orderedUpdates.drain,
      reactionStatistics: bot.reactionStatistics,
    }),
  });
  registerMessageController(bot);

  bot.catch((error) => {
    logger.error('Telegram bot error:', error);
  });

  return bot;
}

module.exports = { createBot };
