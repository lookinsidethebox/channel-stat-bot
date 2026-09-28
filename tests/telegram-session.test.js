const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readAuthConfig, readSession, saveOwnerSession } = require('../src/services/telegram-user-session');

test('invalid credentials are rejected without including secret values in errors', () => {
  const secret = 'invalid-private-api-hash';
  assert.throws(() => readAuthConfig({ TELEGRAM_API_ID: '123', TELEGRAM_API_HASH: secret, OWNER_ID: '42' }), error => {
    assert(!error.message.includes(secret));
    return true;
  });
});

test('a different account or a bot cannot replace an existing owner session', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-owner-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'user.session');
  fs.writeFileSync(file, 'existing-session');
  for (const user of [{ id: 43n }, { id: 42n, bot: true }, null]) {
    assert.throws(() => saveOwnerSession(user, '42', 'replacement', file));
    assert.equal(fs.readFileSync(file, 'utf8'), 'existing-session');
  }
});

test('saved sessions use private permissions and empty sessions do not overwrite them', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-private-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'auth/user.session');
  assert.equal(readSession(file), '');
  saveOwnerSession({ id: 42n }, '42', 'test-session', file);
  assert.equal(readSession(file), 'test-session');
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.throws(() => saveOwnerSession({ id: 42n }, '42', '', file));
  assert.equal(readSession(file), 'test-session');
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['user.session']);
});
