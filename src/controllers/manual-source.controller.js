const sources = new Map([
  ['ads', 'ads'], ['реклама', 'ads'],
  ['url', 'url'], ['ссылка', 'url'],
  ['search', 'search'], ['поиск', 'search'],
  ['pm', 'pm'],
  ['chat folder', 'chat_folder'], ['chat_folder', 'chat_folder'],
]);

function registerManualSourceController(bot, { memberStore, sourceStatistics, adsStatistics, urlPromos, notifyJoins = async () => {}, logger = console }) {
  bot.on('text', async (context, next) => {
    const messageId = context.message.reply_to_message?.message_id;
    if (context.chat?.type !== 'private' || !Number.isSafeInteger(messageId)) return next();
    const member = await memberStore.getMemberByNotificationMessage(messageId);
    if (!member) return next();
    const type = sources.get(context.message.text.trim().toLowerCase());
    if (!type) {
      await context.reply('Ответь названием источника: URL, Ads, Search, PM или Chat Folder.');
      return;
    }
    const updated = await memberStore.setManualSourceByNotification(messageId, type, { adsEnabled: Boolean(adsStatistics) });
    if (!updated) {
      await context.reply('Источник этого подписчика уже определён.');
      return;
    }
    try { await sourceStatistics?.checkPending(); }
    catch (error) { logger.error('Failed to reconcile manually assigned source:', error.message); }

    if (type === 'url') {
      try { await urlPromos.sync(); }
      catch (error) { logger.error('Failed to match URL promo after manual source:', error.message); }
    } else if (type === 'ads') {
      try { await adsStatistics?.checkJoin({ user: { id: updated.userId }, occurredAt: updated.addedAt }); }
      catch (error) { logger.error('Failed to match Ads campaign after manual source:', error.message); }
    }
    await notifyJoins();
    const result = await memberStore.getMember(updated.userId, updated.addedAt);
    if (type === 'url') {
      await context.reply(result.urlCampaign
        ? `Источник URL сохранён. Кампания: ${result.urlCampaign.title}.`
        : 'Источник URL сохранён. Кампания за дату вступления не найдена.');
    } else if (type === 'ads') {
      await context.reply(result.adsCampaign?.title
        ? `Источник Ads сохранён. Кампания: ${result.adsCampaign.title}.`
        : result.adsCampaign?.status === 'pending'
          ? 'Источник Ads сохранён. Кампания пока не определена; бот продолжит проверку.'
          : 'Источник Ads сохранён. Кампанию по статистике определить не удалось.');
    } else {
      await context.reply('Источник сохранён.');
    }
  });
}

module.exports = registerManualSourceController;
