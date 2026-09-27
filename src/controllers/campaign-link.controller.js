function registerCampaignLinkController(bot, { channelId, logger = console }) {
  bot.command('link', async (context) => {
    const sourceName = context.message.text.replace(/^\/link(?:@\w+)?\s*/i, '').trim();

    if (!sourceName) {
      await context.reply('Укажи метку источника: /link campaign_name');
      return;
    }

    if ([...sourceName].length > 32) {
      await context.reply('Метка источника должна быть не длиннее 32 символов.');
      return;
    }

    let invite;
    try {
      invite = await context.telegram.createChatInviteLink(channelId, {
        name: sourceName,
      });
    } catch (error) {
      logger.error('Failed to create campaign invite link:', error);
      await context.reply('Не удалось создать ссылку. Проверь, что у бота в канале есть право приглашать пользователей.');
      return;
    }

    await context.reply(`Ссылка для «${sourceName}»:\n${invite.invite_link}`);
  });
}

module.exports = registerCampaignLinkController;
