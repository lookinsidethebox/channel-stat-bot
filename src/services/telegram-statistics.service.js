const { TelegramClient, Api } = require('teleproto');
const { StringSession } = require('teleproto/sessions');
const { Logger, LogLevel } = require('teleproto/extensions/Logger');
const { readSession, assertOwner } = require('./telegram-user-session');
const { parseSourceGraph } = require('./source-statistics.service');
const { fetchLatestPostStatistics } = require('./telegram-post-statistics.service');
const { fetchDailyPostStatistics } = require('./telegram-post-daily-statistics.service');

function createTelegramStatisticsReader({ apiId, apiHash, ownerId, channelId, sessionPath }) {
  let client;
  let inputChannel;
  let statsDc;
  let queue = Promise.resolve();
  async function connect() {
    if (client && inputChannel) return;
    const session = readSession(sessionPath);
    if (!session) throw new Error('TELEGRAM_USER_SESSION_MISSING');
    client = new TelegramClient(new StringSession(session), apiId, apiHash, {
      connectionRetries: 2, requestRetries: 2, timeout: 10, floodSleepThreshold: 0,
      deviceModel: 'Channel Stat Bot', appVersion: '1.0.0', langCode: 'en', systemLangCode: 'en',
      baseLogger: new Logger(LogLevel.NONE),
    });
    await client.connect();
    assertOwner(await client.getMe(), ownerId);
    const profile = await client.invoke(new Api.users.GetFullUser({ id: new Api.InputUserSelf() }));
    const channel = profile.chats.find(chat => String(-1000000000000 - Number(chat.id)) === String(channelId));
    if (!channel?.accessHash) throw new Error('CONFIGURED_CHANNEL_NOT_IN_OWNER_PROFILE');
    const input = new Api.InputChannel({ channelId: channel.id, accessHash: channel.accessHash });
    const full = await client.invoke(new Api.channels.GetFullChannel({ channel: input }));
    if (!full.fullChat.canViewStats) throw new Error('CHANNEL_STATISTICS_UNAVAILABLE');
    statsDc = full.fullChat.statsDc;
    inputChannel = input;
  }
  async function disconnect() {
    const previous = client;
    client = undefined;
    inputChannel = undefined;
    if (previous) await previous.destroy();
  }
  function request(action) {
    const operation = queue.then(async () => {
      let timer;
      try {
        const request = (async () => {
          await connect();
          return action(client);
        })();
        return await Promise.race([request, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('SOURCE_STATISTICS_TIMEOUT')), 25000);
        })]);
      } catch (error) {
        await disconnect().catch(() => {});
        const code = error.errorMessage || error.message;
        const safe = new Error(/^[A-Z0-9_]+$/.test(code || '') ? code : 'SOURCE_STATISTICS_REQUEST_FAILED');
        if (Number.isFinite(error.seconds) && error.seconds > 0) safe.retryAfterSeconds = error.seconds;
        throw safe;
      } finally {
        clearTimeout(timer);
      }
    });
    queue = operation.catch(() => {});
    return operation;
  }
  return {
    fetch() {
      return request(async activeClient => {
        const stats = await activeClient.invoke(new Api.stats.GetBroadcastStats({ channel: inputChannel }), statsDc);
        let graph = stats.newFollowersBySourceGraph;
        if (graph instanceof Api.StatsGraphAsync) {
          graph = await activeClient.invoke(new Api.stats.LoadAsyncGraph({ token: graph.token }), statsDc);
        }
        if (!(graph instanceof Api.StatsGraph)) throw new Error('SOURCE_GRAPH_UNAVAILABLE');
        return { channelId, fetchedAt: new Date().toISOString(), days: parseSourceGraph(JSON.parse(graph.json.data)) };
      });
    },
    fetchPosts(options) {
      return request(activeClient => fetchLatestPostStatistics(activeClient, inputChannel, { ...options, channelId }));
    },
    fetchDailyPosts(options) {
      return request(activeClient => fetchDailyPostStatistics(activeClient, inputChannel, { ...options, channelId }, statsDc));
    },
    close() {
      const operation = queue.then(disconnect);
      queue = operation.catch(() => {});
      return operation;
    },
  };
}

module.exports = { createTelegramStatisticsReader };
