function createOrderedChannelUpdatesMiddleware() {
  let queue = Promise.resolve();

  return (context, next) => {
    if (!context.chatMember && !context.channelPost && !context.editedChannelPost) {
      return next();
    }

    // Telegraf dispatches a polling batch concurrently. Queue before routing so
    // post snapshots and membership events keep their incoming order.
    const operation = queue.then(next);
    queue = operation.catch(() => {});
    return operation;
  };
}

module.exports = createOrderedChannelUpdatesMiddleware;
