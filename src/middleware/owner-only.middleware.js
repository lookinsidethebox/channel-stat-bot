function createOwnerOnlyMiddleware(ownerId) {
  return async (context, next) => {
    if (context.from?.id == null || String(context.from.id) !== String(ownerId)) {
      return;
    }

    return next();
  };
}

module.exports = createOwnerOnlyMiddleware;
