const { createPostSnapshot } = require('../services/member-event.service');

function registerChannelPostController(bot, { channelId, savePost }) {
  async function handlePost(post, isEdit = false) {
    if (String(post.chat.id) !== String(channelId)) {
      return;
    }

    await savePost(createPostSnapshot(post), { isEdit });
  }

  bot.on('channel_post', (context) => handlePost(context.channelPost));
  bot.on('edited_channel_post', (context) => handlePost(context.editedChannelPost, true));
}

module.exports = registerChannelPostController;
