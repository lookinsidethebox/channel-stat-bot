const { createMemberEvent } = require('../services/member-event.service');
const { fetchChannelPostAt } = require('../services/channel-post.service');
const { formatLeaveNotification } = require('../services/member-notification.service');

function registerChannelMemberController(bot, {
  channelId, ownerId, recordMemberEvent, getMemberAtRemoval, notifyJoins, fetchPost = fetchChannelPostAt, sourceStatistics, adsStatistics, logger = console,
}) {
  bot.on('chat_member', async (context) => {
    const update = context.chatMember;

    if (String(update.chat.id) !== String(channelId)) {
      return;
    }

    const event = createMemberEvent(update);
    if (!event) {
      return;
    }

    let post = null;
    try {
      post = await fetchPost(context.telegram, { channelId, ownerId, occurredAt: event.occurredAt });
    } catch (error) {
      event.postLookupError = error.message;
      logger.error('Failed to fetch the post for a member event:', error);
    }

    if (sourceStatistics && event.action === 'joined') event.sourceLookup = { status: 'pending' };
    if (adsStatistics && event.action === 'joined') event.adsCampaign = { status: 'pending' };
    if (event.action === 'joined') event.joinNotification = { status: 'pending' };
    const saved = await recordMemberEvent(event, post);
    if (!saved) {
      return;
    }

    if (sourceStatistics && event.action === 'joined') {
      try {
        await sourceStatistics.checkJoin(event);
      } catch (error) {
        logger.error('Source statistics state error:', error.message);
      }
    }

    if (adsStatistics && event.action === 'joined') {
      try {
        await adsStatistics.checkJoin(event);
      } catch {
        logger.error('Ads statistics state error.');
      }
    }

    if (event.action === 'joined') {
      await notifyJoins();
      return;
    }

    const member = await getMemberAtRemoval(event.user.id, event.occurredAt);
    const message = formatLeaveNotification({ ...member, ...event.user }, update.chat);

    logger.log(message);
    await context.telegram.sendMessage(ownerId, message, { link_preview_options: { is_disabled: true } });
  });
}

module.exports = registerChannelMemberController;
