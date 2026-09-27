function loadConfig(env = process.env) {
  function required(name) {
    const value = env[name]?.trim();
    if (!value) {
      throw new Error(`${name} is missing. Add it to the .env file.`);
    }
    return value;
  }

  const token = required('BOT_TOKEN');
  const ownerId = required('OWNER_ID');
  const channelId = required('CHANNEL_ID');

  if (!/^[1-9]\d*$/.test(ownerId) || !Number.isSafeInteger(Number(ownerId))) {
    throw new Error('OWNER_ID must be a positive numeric Telegram user ID.');
  }
  if (!/^-[1-9]\d*$/.test(channelId) || !Number.isSafeInteger(Number(channelId))) {
    throw new Error('CHANNEL_ID must be a negative numeric Telegram channel ID (not @username).');
  }

  return { token, ownerId, channelId, debugMemberUpdates: env.DEBUG_MEMBER_UPDATES === '1' };
}

module.exports = { loadConfig };
