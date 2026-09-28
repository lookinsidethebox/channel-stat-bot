require('dotenv').config();
const { Telegram } = require('telegraf');
const { loadConfig } = require('../src/config');
const { createTelegramAdsReader } = require('../src/services/telegram-ads.service');

async function main() {
  const config = loadConfig();
  if (!config.adsStatistics) throw new Error('ADS_TOKEN_MISSING');
  const telegram = new Telegram(config.token);
  const reader = createTelegramAdsReader({ ...config.adsStatistics, getChannel: () => telegram.getChat(config.channelId) });
  const snapshot = await reader.fetch();
  console.log(JSON.stringify({ channelId: snapshot.channelId, fetchedAt: snapshot.fetchedAt,
    ads: Object.values(snapshot.ads).map(({ adId, title, actions }) => ({ adId, title, joins: actions })),
  }, null, 2));
}

main().catch(error => {
  console.error(/^ADS_[A-Z0-9_]+$/.test(error.message || '') ? error.message : 'ADS_CHECK_FAILED');
  process.exitCode = 1;
});
