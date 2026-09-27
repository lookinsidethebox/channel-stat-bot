const { appendFileSync, mkdirSync } = require('node:fs');
const path = require('node:path');

function createDebugMemberUpdatesMiddleware({ channelId, logger = console }) {
  const filePath = path.join(__dirname, '../../data/debug-member-updates.jsonl');

  function write(entry) {
    try {
      mkdirSync(path.dirname(filePath), { recursive: true });
      appendFileSync(filePath, `${JSON.stringify({ observedAt: new Date().toISOString(), ...entry })}\n`);
    } catch (error) {
      logger.error('Failed to write member debug log:', error);
    }
  }

  write({ type: 'observer_started', channelId, pid: process.pid });

  return async (context, next) => {
    const update = context.chatMember;
    if (!update || String(update.chat.id) !== String(channelId)) return next();

    const updateId = context.update.update_id;
    write({ type: 'received', updateId, update });
    try {
      await next();
      write({ type: 'processed', updateId });
    } catch (error) {
      write({ type: 'failed', updateId, error: error.message });
      throw error;
    }
  };
}

module.exports = createDebugMemberUpdatesMiddleware;
