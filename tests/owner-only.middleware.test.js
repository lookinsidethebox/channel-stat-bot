const assert = require('node:assert/strict');
const test = require('node:test');
const createOwnerOnlyMiddleware = require('../src/middleware/owner-only.middleware');

const ownerId = 'test-owner-id';

test('allows the configured owner through to the handler', async () => {
  const middleware = createOwnerOnlyMiddleware(ownerId);
  let nextCalled = false;

  await middleware({ from: { id: ownerId } }, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
});

test('matches numeric sender IDs to string config and blocks missing IDs', async () => {
  let allowed = 0;
  const next = () => { allowed += 1; };
  await createOwnerOnlyMiddleware('123')({ from: { id: 123 } }, next);
  await createOwnerOnlyMiddleware(undefined)({}, next);
  await createOwnerOnlyMiddleware(null)({ from: { id: null } }, next);
  assert.equal(allowed, 1);
});

test('blocks other users and updates without a sender', async (context) => {
  const middleware = createOwnerOnlyMiddleware(ownerId);

  for (const [name, messageContext] of [
    ['another user', { from: { id: 987654321 } }],
    ['an update without a sender', {}],
  ]) {
    await context.test(name, async () => {
      let nextCalled = false;

      await middleware(messageContext, () => {
        nextCalled = true;
      });

      assert.equal(nextCalled, false);
    });
  }
});
